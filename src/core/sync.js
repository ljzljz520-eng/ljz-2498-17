// Client synchronization engine.
//
// Guarantees:
//  - unconfirmed edits live in the durable OperationQueue; the network loop
//    only reads/acks them, never holds the sole copy
//  - HTTP timeout/network error = UNKNOWN, not failure: we reconcile by
//    querying the server for the op ids it already received, ack those, and
//    re-send only the rest with their ORIGINAL identities
//  - stale baseline triggers a real three-way recovery (common ancestor /
//    device branch / cloud draft), never "last timestamp wins"
//  - structural conflicts pause sync and await human decisions
//  - every recovery action is recorded and can be undone

import { api as defaultApi, fetchWithTimeout } from './api.js'
import { applyOps, makeOpId, withFingerprint } from './ops.js'
import { diffToOps } from './blocks.js'
import { threeWayMerge, applyResolutions } from './merge.js'

export class SyncEngine {
  constructor({
    queue,
    api: apiClient = defaultApi,
    mode = 'nodes',
    timeoutMs = 8000,
    resolveConflict, // async (context) => Map<conflictId, decision> | null
    onEvent = () => {},
    autoFlush = true,
    intervalMs = 4000,
  }) {
    this.queue = queue
    this.api = apiClient
    this.mode = mode
    this.timeoutMs = timeoutMs
    this.resolveConflict = resolveConflict
    this.onEvent = onEvent
    this.autoFlush = autoFlush
    this.intervalMs = intervalMs

    this.flushing = null
    this.timer = null
    this.recoveryStack = [] // undoable recovery actions
    this.stopped = true
    this.lastOutcome = 'idle'
  }

  emit(type, details = {}) {
    const event = { type, at: Date.now(), ...details }
    this.lastOutcome = type
    this.onEvent(event)
  }

  start() {
    this.stopped = false
    if (typeof addEventListener !== 'undefined') {
      this._online = () => this.requestFlush('online')
      addEventListener('online', this._online)
    }
    if (this.autoFlush) {
      this.timer = setInterval(() => this.safeFlush('interval'), this.intervalMs)
    }
    // Initial flush covers offline-reopen: pending ops upload once online.
    this.safeFlush('start')
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this._online && typeof removeEventListener !== 'undefined') {
      removeEventListener('online', this._online)
    }
  }

  requestFlush(reason = 'edit') {
    if (this.stopped) return
    // Coalesce bursts; still run promptly after editing stops.
    clearTimeout(this._debounce)
    this._debounce = setTimeout(() => this.safeFlush(reason), 250)
  }

  async safeFlush(reason) {
    try {
      await this.flush(reason)
    } catch (err) {
      this.emit('flush-error', { message: err.message, code: err.code })
    }
  }

  isOnline() {
    return typeof navigator === 'undefined' || navigator.onLine === undefined
      ? true
      : navigator.onLine
  }

  /**
   * One reconciliation+sync pass. Idempotent and safe to repeat.
   */
  async flush(reason = 'manual') {
    if (this.flushing) return this.flushing
    if (!this.queue.hasUnuploadedEdits()) {
      this.lastOutcome = 'up-to-date'
      return { upToDate: true }
    }
    if (!this.isOnline()) {
      this.emit('offline', { reason })
      return { offline: true }
    }

    const task = this._run(reason)
    this.flushing = task
    try {
      return await task
    } finally {
      this.flushing = null
    }
  }

  async _run(reason) {
    const q = this.queue
    this.emit('syncing', { reason, ops: q.pendingAckOps().length })

    const state = q.snapshot
    const pending = q.pendingAckOps()
    const baseVersion = state.serverVersion

    let result
    try {
      result = await fetchWithTimeout(
        ({ signal } = {}) =>
          this.api.sync(
            state.docId,
            { ops: stripLocal(pending), baseVersion, mode: this.mode },
            { signal },
          ),
        this.timeoutMs,
      )
    } catch (err) {
      if (err.code === 'NETWORK_UNKNOWN' || err.name === 'AbortError' || err.status === 503) {
        // OUTCOME UNKNOWN. Reconcile: ask the server which of our opIds it
        // already has. Never rebuild the draft.
        return this._reconcileAfterUnknown(err, reason)
      }
      if (err.code === 'STALE_BASELINE') {
        return this._handleStale(err.body.error, reason)
      }
      if (err.code === 'OP_ID_CONFLICT') {
        this.emit('op-id-conflict', err.body.error)
        throw err
      }
      throw err
    }

    // Definite acks.
    await q.markReceived(result.acks, result.version, result.snapshot)
    this.emit('received', {
      acks: result.acks.length,
      version: result.version,
      merged: result.merged,
    })

    // If another device pushed between our reconcile and commit, loop once.
    if (q.hasUnuploadedEdits()) {
      return this._run('tail')
    }
    this.emit('up-to-date', { version: result.version })
    return { ok: true, version: result.version }
  }

  /**
   * The response (or even the request) may have been lost while the server
   * committed. Query the op log by identity and adopt whatever landed, then
   * re-send the remainder (same opIds => server dedupes).
   */
  async _reconcileAfterUnknown(networkError, reason) {
    const q = this.queue
    this.emit('unknown-outcome', { message: networkError.message })
    let log
    try {
      log = await fetchWithTimeout(
        ({ signal } = {}) => this.api.listOps(q.snapshot.docId, { signal }),
        this.timeoutMs,
      )
    } catch (err) {
      this.emit('still-unreachable', { message: err.message })
      return { unknown: true }
    }
    const serverOps = log.ops || []
    const landed = new Map(serverOps.map((o) => [o.opId, o]))
    const pending = q.pendingAckOps()

    // Same id but different content on the server is a hard protocol conflict.
    for (const op of pending) {
      const theirs = landed.get(op.opId)
      if (theirs && op.fingerprint && theirs.fingerprint !== op.fingerprint) {
        this.emit('op-id-conflict', {
          opId: op.opId,
          serverFingerprint: theirs.fingerprint,
          clientFingerprint: op.fingerprint,
        })
        throw Object.assign(new Error('op id conflict during reconcile'), {
          code: 'OP_ID_CONFLICT',
        })
      }
    }

    const acks = pending
      .filter((op) => landed.has(op.opId))
      .map((op) => ({
        opId: op.opId,
        version: landed.get(op.opId).version,
        fingerprint: landed.get(op.opId).fingerprint,
      }))

    if (acks.length) {
      // Fetch current doc for the authoritative snapshot.
      const doc = await this.api.getDoc(q.snapshot.docId)
      await q.markReceived(acks, doc.version, { nodes: doc.nodes })
      this.emit('recovered-ack', { acks: acks.length, version: doc.version })
    } else {
      this.emit('nothing-landed', {})
    }

    if (q.hasUnuploadedEdits()) {
      return this._run('retry-after-reconcile')
    }
    this.emit('up-to-date', { version: q.snapshot.serverVersion })
    return { reconciled: true }
  }

  /**
   * Handle a 409 stale baseline. Present the three branches and (for node
   * mode) structural conflicts to the user, then rebase local edits onto the
   * cloud draft. The rebase supersedes old ops but keeps them until the new
   * ops are acknowledged; the whole action is undoable.
   */
  async _handleStale(errorPayload, reason) {
    const q = this.queue
    const localOps = q.pendingAckOps()
    const ancestor = errorPayload.ancestor || { version: errorPayload.baseVersion, nodes: [] }
    const cloud = errorPayload.cloud
    const remoteOps = errorPayload.remoteOps || []

    const ancestorNodes = ancestor.nodes
    const localNodes = applyOps(ancestorNodes, localOps, { strictAnchor: false })
    const cloudNodes = cloud.nodes

    const merge = threeWayMerge(ancestorNodes, localOps, remoteOps, cloudNodes)

    // In doc-lock mode ANY staleness is surfaced for full-document review.
    const conflicts =
      this.mode === 'doc'
        ? [{ id: 'doc-lock', kind: 'doc_lock', wholeDocument: true }]
        : merge.conflicts

    const context = {
      reason,
      mode: this.mode,
      ancestor: ancestorNodes,
      ancestorVersion: ancestor.version,
      device: {
        deviceId: q.deviceId,
        nodes: localNodes,
        ops: localOps,
      },
      cloud: {
        version: cloud.version,
        nodes: cloudNodes,
        ops: remoteOps,
      },
      conflicts,
    }

    this.emit('conflict-detected', context)

    let decisions
    if (this.resolveConflict) {
      decisions = await this.resolveConflict(context)
    }
    if (!decisions) {
      // User deferred: keep local branch, do not lose anything.
      this.emit('conflict-deferred', {})
      return { deferred: true }
    }

    let resolvedNodes
    if (this.mode === 'doc') {
      const d = decisions.get('doc-lock')
      if (!d) return { deferred: true }
      resolvedNodes =
        d.resolution === 'local'
          ? localNodes
          : d.resolution === 'remote'
            ? cloudNodes
            : d.nodes || cloudNodes
    } else {
      resolvedNodes = applyResolutions(merge, decisions)
    }

    // Build rebased ops as a diff from the CLOUD draft to the resolution.
    const blocks = resolvedNodes.map((n) => ({ kind: n.kind, text: n.text }))
    const { ops: rebasedOps, nodes: rebasedNodes } = diffToOps(
      cloudNodes,
      blocks,
      (fields) => ({ ...fields, clientClock: Date.now() }),
      {},
    )

    // Capture undoable recovery record BEFORE mutating.
    const recovery = {
      type: 'rebase',
      prevAncestor: { ...q.snapshot.ancestor },
      prevServerVersion: q.snapshot.serverVersion,
      prevNodes: q.snapshot.nodes.map((n) => ({ ...n })),
      superseded: localOps.map((o) => o.opId),
      newOps: rebasedOps,
      newNodes: rebasedNodes,
    }

    await q.mutate((state) => {
      const supersededIds = new Set(localOps.map((o) => o.opId))
      for (const op of state.ops) {
        if (supersededIds.has(op.opId)) op.superseded = true
      }
      const stamped = rebasedOps.map((op) =>
        withFingerprint({
          ...op,
          opId: op.opId || makeOpId(state.deviceId),
          docId: state.docId,
          deviceId: state.deviceId,
          status: 'local',
          baseVersion: cloud.version,
          clientClock: Date.now(),
        }),
      )
      state.ops.push(...stamped)
      state.ancestor = { version: cloud.version, nodes: cloudNodes }
      state.serverVersion = cloud.version
      state.nodes = rebasedNodes
      recovery.stamped = stamped
      return stamped
    }, { type: 'rebase-applied', count: rebasedOps.length })

    this.recoveryStack.push(recovery)
    this.emit('rebased', {
      newOps: recovery.stamped.length,
      serverVersion: cloud.version,
      undoable: true,
    })

    // Update editor through the queue subscription; then upload the rebase.
    return this._run('post-rebase')
  }

  /** Undo the most recent recovery (rebase). Restores the device branch. */
  async undoRecovery() {
    const recovery = this.recoveryStack.pop()
    if (!recovery || recovery.type !== 'rebase') return false
    const q = this.queue
    const stampedIds = new Set((recovery.stamped || []).map((o) => o.opId))
    await q.mutate((state) => {
      state.ops = state.ops.filter((o) => !stampedIds.has(o.opId))
      for (const op of state.ops) {
        if (recovery.superseded.includes(op.opId)) delete op.superseded
      }
      state.ancestor = { ...recovery.prevAncestor }
      state.serverVersion = recovery.prevServerVersion
      state.nodes = recovery.prevNodes.map((n) => ({ ...n }))
    }, { type: 'recovery-undone' })
    this.emit('recovery-undone', {})
    return true
  }

  /** Create a named save point on server and fold received ops to "saved". */
  async checkpoint(name) {
    const q = this.queue
    // Make sure everything is acknowledged first.
    await this.flush('before-checkpoint')
    if (q.hasUnuploadedEdits()) {
      this.emit('checkpoint-blocked', {})
      return { blocked: true }
    }
    const cp = await this.api.createCheckpoint(q.snapshot.docId, name)
    await q.createCheckpoint(name, cp.nodes, cp.version)
    this.emit('checkpoint', { name, version: cp.version })
    return cp
  }
}

function stripLocal(ops) {
  // Send only wire fields; keep opId + fingerprint for idempotency/conflict.
  return ops.map((op) => {
    const { status, serverVer, superseded, ...wire } = op
    return wire
  })
}
