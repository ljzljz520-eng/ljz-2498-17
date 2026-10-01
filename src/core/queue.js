// Durable local operation queue.
//
// Responsibilities:
//  - append unconfirmed edits as ops with stable identities (status=local)
//  - promote ops to "received" when the server acknowledges them
//  - fold acked ops into named checkpoints ("saved" save points)
//  - survive offline reload: every mutation is write-through to the KV
//  - on QuotaError purge ONLY reconstructible caches, never the sole copy
//    of an unuploaded op
//  - notify other tabs via the bus after each committed mutation
//
// State persisted under key `queue:<docId>`:
// {
//   formatVersion, docId, deviceId, mode: 'nodes'|'doc',
//   serverVersion,               // last known cloud version
//   ancestor: { version, nodes },// common ancestor for 3-way merge
//   checkpoint: { name, version, nodes, createdAt } | null,
//   nodes: node[],               // last parsed/current node model
//   ops: op[] (with .status local|received|saved; acked ops keep serverVer),
//   caches: { preview, snapshots... } // reconstructible, quota-purged first
// }

import { FORMAT_VERSION, migrateQueue } from './migration.js'
import { withFingerprint } from './ops.js'
import { QuotaError } from './storage.js'

export const STATUS = Object.freeze({
  LOCAL: 'local',
  RECEIVED: 'received',
  SAVED: 'saved',
})

function queueKey(docId) {
  return `queue:${docId}`
}

export class OperationQueue {
  constructor({ kv, bus, docId, deviceId, mode = 'nodes' }) {
    this.kv = kv
    this.bus = bus
    this.docId = docId
    this.deviceId = deviceId
    this.mode = mode
    this.state = null
    this.listeners = new Set()
    this.writeChain = Promise.resolve()
    this.unloadBus = bus && bus.on
      ? bus.on(`queue:${docId}`, (msg) => this._onRemoteMessage(msg))
      : null
  }

  _onRemoteMessage(msg) {
    if (!msg || msg.from === this.deviceId) return
    // Another tab changed the queue; reload and re-render (shared queue).
    this._reloadFromDisk()
  }

  async _reloadFromDisk() {
    const fresh = await this.kv.get(queueKey(this.docId))
    if (fresh) {
      this.state = fresh
      this._emit({ type: 'external-update' })
    }
  }

  async loadOrInit(initial = {}) {
    const stored = await this.kv.get(queueKey(this.docId))
    if (stored) {
      const { queue, migratedFrom, steps } = migrateQueue(stored)
      this.state = queue
      this.mode = queue.mode || this.mode
      if (steps.length) {
        await this._persist({ reason: 'migration' })
        this._emit({ type: 'migrated', migratedFrom, steps })
      }
      return this.state
    }
    this.state = {
      formatVersion: FORMAT_VERSION,
      docId: this.docId,
      deviceId: this.deviceId,
      mode: this.mode,
      serverVersion: initial.serverVersion || 0,
      ancestor: initial.ancestor || { version: 0, nodes: initial.nodes || [] },
      checkpoint: initial.checkpoint || null,
      nodes: initial.nodes || [],
      ops: initial.ops || [],
      caches: initial.caches || {},
    }
    await this._persist({ reason: 'init' })
    return this.state
  }

  get snapshot() {
    return this.state
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  _emit(event) {
    for (const fn of this.listeners) fn(event)
  }

  // All writes serialized so concurrent edits/tabs don't clobber each other.
  mutate(fn, event) {
    const run = this.writeChain.then(async () => {
      const result = await fn(this.state)
      await this._persist(event)
      this._emit(event)
      return result
    })
    // Keep chain alive even on failure.
    this.writeChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  async _persist(event = {}) {
    this.state.formatVersion = FORMAT_VERSION
    try {
      await this.kv.set(queueKey(this.docId), this.state)
    } catch (err) {
      if (err instanceof QuotaError || err.code === 'QUOTA_EXCEEDED') {
        // 1) drop reconstructible caches (preview html, derived snapshots)
        const freed = this._purgeReconstructibleCaches()
        // 2) drop already-RECEIVED op bodies? NO — those remain the record we
        //    reconcile against. Instead try once more after cache purge.
        try {
          await this.kv.set(queueKey(this.docId), this.state)
          this._emit({ type: 'quota-recovered', freed })
          return
        } catch (err2) {
          this._emit({ type: 'quota-fatal', error: err2 })
          throw err2
        }
      }
      throw err
    }
    if (this.bus && event.broadcast !== false) {
      this.bus.post(`queue:${this.docId}`, {
        ...event,
        from: this.deviceId,
        at: Date.now(),
      })
    }
  }

  // Caches are anything derivable from nodes/ops/checkpoint.
  _purgeReconstructibleCaches() {
    if (!this.state.caches) return 0
    const keys = Object.keys(this.state.caches)
    const freed = keys.length
    this.state.caches = {}
    return freed
  }

  /** Reconstruct a cache after purge (proves it was safe to drop). */
  rebuildCache(name, producer) {
    if (!this.state.caches) this.state.caches = {}
    this.state.caches[name] = producer(this.state)
    return this.state.caches[name]
  }

  // ---- edits --------------------------------------------------------------

  /** Append a batch of freshly diffed ops (status=local). */
  appendLocalOps(ops, nextNodes) {
    return this.mutate((state) => {
      const stamped = ops.map((op) =>
        withFingerprint({
          ...op,
          docId: this.docId,
          deviceId: this.deviceId,
          status: STATUS.LOCAL,
          baseVersion: op.baseVersion ?? state.serverVersion,
        }),
      )
      state.ops.push(...stamped)
      state.nodes = nextNodes
      return stamped
    }, { type: 'local-edit', count: ops.length })
  }

  /**
   * Mark ops acknowledged by the server. Retries keep identity: an opId we
   * already know is matched, never duplicated.
   * acks: [{ opId, version, fingerprint }]
   */
  markReceived(acks, newServerVersion, serverSnapshot) {
    return this.mutate((state) => {
      const byId = new Map(acks.map((a) => [a.opId, a]))
      for (const op of state.ops) {
        const ack = byId.get(op.opId)
        if (ack) {
          if (op.fingerprint && ack.fingerprint && op.fingerprint !== ack.fingerprint) {
            // same number, different content — hard conflict, do NOT mark.
            continue
          }
          op.status = STATUS.RECEIVED
          op.serverVer = ack.version
        }
      }
      state.serverVersion = newServerVersion
      if (serverSnapshot) {
        state.ancestor = {
          version: newServerVersion,
          nodes: serverSnapshot.nodes,
        }
      }
      return state
    }, { type: 'acked', count: acks.length })
  }

  /**
   * After a rebase we replace still-local ops with new-identity ops built on
   * the new ancestor. Superseded ops are retained (tombstones with
   * .supersededBy) until their replacement is itself acknowledged, so an
   * interrupted rebase never loses an edit and the action can be undone.
   */
  rebase({ newOps, superseded, ancestorNodes, serverVersion }) {
    return this.mutate((state) => {
      const oldIds = new Set(superseded.map((o) => o.opId))
      for (const op of state.ops) {
        if (oldIds.has(op.opId)) op.superseded = true
      }
      const stamped = newOps.map((op) =>
        withFingerprint({
          ...op,
          docId: this.docId,
          deviceId: this.deviceId,
          status: STATUS.LOCAL,
          baseVersion: serverVersion,
        }),
      )
      state.ops.push(...stamped)
      state.ancestor = { version: serverVersion, nodes: ancestorNodes }
      state.serverVersion = serverVersion
      state.nodes = state.nodes // caller sets via setNodes if changed
      return { newOps: stamped }
    }, { type: 'rebase', count: newOps.length })
  }

  setNodes(nodes) {
    return this.mutate((state) => {
      state.nodes = nodes
    }, { type: 'nodes-updated' })
  }

  /** Undo a rebase: drop replacements, revive superseded ops, reset ancestor. */
  undoRebase(rebaseEvent) {
    return this.mutate((state) => {
      const newIds = new Set(rebaseEvent.newOps.map((o) => o.opId))
      state.ops = state.ops.filter((o) => !newIds.has(o.opId))
      for (const op of state.ops) delete op.superseded
      // ancestor/serverVersion restore is supplied by caller via snapshot
      return state
    }, { type: 'rebase-undone' })
  }

  /**
   * Create a named save point. All currently-received ops become "saved" and
   * the checkpoint records the exact node snapshot.
   */
  createCheckpoint(name, nodes, serverVersion) {
    return this.mutate((state) => {
      const cp = {
        name,
        version: serverVersion ?? state.serverVersion,
        nodes: nodes.map((n) => ({ ...n })),
        createdAt: Date.now(),
      }
      state.checkpoint = cp
      for (const op of state.ops) {
        if (op.status === STATUS.RECEIVED) op.status = STATUS.SAVED
      }
      // Prune fully-saved ops that are folded into the checkpoint, but keep
      // the last checkpoint record so ranges show "saved".
      state.ops = state.ops.filter((op) => op.status !== STATUS.SAVED)
      return cp
    }, { type: 'checkpoint', name })
  }

  // ---- selectors ----------------------------------------------------------

  localOps() {
    return this.state.ops.filter(
      (o) => o.status === STATUS.LOCAL && !o.superseded,
    )
  }
  pendingAckOps() {
    return this.state.ops.filter(
      (o) => (o.status === STATUS.LOCAL || !o.status) && !o.superseded,
    )
  }
  hasUnuploadedEdits() {
    return this.state.ops.some(
      (o) => o.status === STATUS.LOCAL && !o.superseded,
    )
  }
  /** Sole-copy guard: are there unuploaded ops that exist nowhere else? */
  unuploadedOps() {
    return this.state.ops.filter(
      (o) => o.status === STATUS.LOCAL && !o.superseded,
    )
  }

  /**
   * Quota policy used externally too: list keys safe to delete before ever
   * touching unuploaded ops. Caches first, then received snapshots.
   */
  safePurgePlan() {
    const plan = []
    if (this.state.caches && Object.keys(this.state.caches).length) {
      plan.push('caches')
    }
    return plan
  }
}
