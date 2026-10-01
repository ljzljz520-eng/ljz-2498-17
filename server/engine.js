// Server-side document engine: conditional (version-guarded) sync.
//
// Persistent facts (mirrored in PostgreSQL by pg-repo, or a JSON file by
// file-repo):
//   docs:        docId -> { version, nodes, createdAt, updatedAt, formatVersion }
//   ops:         received operations, each assigned a monotonic `version`
//   checkpoints: named save points { name, docId, version, nodes, createdAt }
//
// Concurrency: each doc has a mutex so concurrent conditional commits are
// serialized (the PG implementation instead uses SELECT ... FOR UPDATE).

import { applyOps, fingerprint as fp } from '../src/core/ops.js'
import { threeWayMerge } from '../src/core/merge.js'
import { contentHash } from '../src/core/hash.js'

export class StaleBaselineError extends Error {
  constructor(payload) {
    super('stale baseline')
    this.name = 'StaleBaselineError'
    this.code = 'STALE_BASELINE'
    this.payload = payload
  }
}

export class OpIdConflictError extends Error {
  constructor(details) {
    super('operation id reused with different content')
    this.name = 'OpIdConflictError'
    this.code = 'OP_ID_CONFLICT'
    this.payload = details
  }
}

export class DocumentEngine {
  constructor(repo) {
    this.repo = repo
    this.locks = new Map()
  }

  _withLock(docId, fn) {
    const prev = this.locks.get(docId) || Promise.resolve()
    let release
    const next = new Promise((res) => {
      release = res
    })
    this.locks.set(docId, prev.then(() => next))
    return prev
      .then(() =>
        Promise.resolve()
          .then(fn)
          .finally(release),
      )
  }

  async getDoc(docId) {
    const doc = await this.repo.getDoc(docId)
    if (!doc) return null
    const ops = await this.repo.listOps(docId)
    const checkpoint = await this.repo.getLatestCheckpoint(docId)
    return { ...doc, ops, checkpoint }
  }

  async createDoc(docId, nodes = []) {
    return this._withLock(docId, async () => {
      const existing = await this.repo.getDoc(docId)
      if (existing) return existing
      const doc = {
        docId,
        version: 0,
        nodes,
        // The node set at version 0. The op log is a complete story on top of
        // this, so an ancestor at ANY version is reconstructable by replay.
        baselineNodes: nodes,
        contentHash: contentHash(JSON.stringify(nodes)),
        formatVersion: 3,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await this.repo.putDoc(doc)
      return doc
    })
  }

  /**
   * Snapshot of nodes at a given version.
   *
   * Clean auto-merges FOLD branches: the merged fresh ops by themselves do
   * not reconstruct the cloud line (they omit the other branch). So we store
   * an exact node snapshot at every version (see _appendOps). Reconstruction
   * prefers the snapshot exactly at `version`, then the newest snapshot at or
   * below it plus op replay, then the v0 baseline. This is what makes stale
   * baseline recovery always able to show the TRUE common ancestor.
   */
  async _nodesAtVersion(docId, doc, version) {
    if (version === doc.version) return doc.nodes
    if (version === 0) return doc.baselineNodes || []

    // Exact per-version snapshots are written on every append, including
    // folded auto-merges, so the TRUE common ancestor is always available
    // without replaying ops (which cannot reconstruct a folded branch).
    const exact = await this.repo.getSnapshot(docId, version)
    if (exact) return exact.nodes

    // Defensive fallback: nearest snapshot at or below + replay the STRICT
    // tail (ops with version strictly greater than the snapshot version).
    const nearest = await this.repo.getLatestSnapshotBefore(docId, version)
    const baseVersion = nearest ? nearest.version : 0
    const baseNodes = nearest ? nearest.nodes : doc.baselineNodes || []
    const ops = await this.repo.listOps(docId)
    const upto = ops
      .filter((op) => op.version > baseVersion && op.version <= version)
      .sort((a, b) => a.version - b.version)
    return applyOps(baseNodes, upto)
  }

  /**
   * Conditional commit.
   * @param {object} p
   * @param p.docId
   * @param p.ops          incoming ops (client branch)
   * @param p.baseVersion  version the client rebased on
   * @param p.mode         'nodes' (default, merge) | 'doc' (doc-level lock)
   */
  async sync({ docId, ops = [], baseVersion = 0, mode = 'nodes' }) {
    return this._withLock(docId, async () => {
      let doc = await this.repo.getDoc(docId)
      if (!doc) {
        doc = await this.createDoc(docId, [])
      }

      // 1) Idempotency + hard conflict detection (same opId, diff content).
      const knownOps = await this.repo.listOps(docId)
      const knownById = new Map(knownOps.map((o) => [o.opId, o]))
      const acks = []
      const fresh = []
      for (const op of ops) {
        const known = knownById.get(op.opId)
        if (known) {
          const incomingFp = op.fingerprint || fp(op)
          if (known.fingerprint && known.fingerprint !== incomingFp) {
            throw new OpIdConflictError({
              opId: op.opId,
              serverFingerprint: known.fingerprint,
              clientFingerprint: incomingFp,
              serverOp: redact(known),
              clientOp: redact(op),
            })
          }
          acks.push({ opId: op.opId, version: known.version, fingerprint: known.fingerprint })
        } else {
          fresh.push(op)
        }
      }

      // 2) Stale baseline handling.
      if (baseVersion < doc.version) {
        const ancestor = await this._nodesAtVersion(docId, doc, baseVersion)
        const remoteOps = knownOps
          .filter((op) => op.version > baseVersion)
          .sort((a, b) => a.version - b.version)

        if (mode === 'doc') {
          // Document-level optimistic lock: refuse; client must rebase the
          // WHOLE document. We never let a timeout/blind overwrite win.
          throw new StaleBaselineError({
            docId,
            baseVersion,
            serverVersion: doc.version,
            ancestor: { version: baseVersion, nodes: ancestor },
            cloud: { version: doc.version, nodes: doc.nodes },
            remoteOps,
          })
        }

        // Node-op track: attempt an automatic three-way merge. Pass the
        // cloud's CURRENT nodes so content changed via an earlier folded
        // merge is still detected as a real divergence (never overwritten).
        const merge = threeWayMerge(ancestor, fresh, remoteOps, doc.nodes)
        if (merge.conflicts.length) {
          throw new StaleBaselineError({
            docId,
            baseVersion,
            serverVersion: doc.version,
            ancestor: { version: baseVersion, nodes: ancestor },
            cloud: { version: doc.version, nodes: doc.nodes },
            remoteOps,
            conflicts: merge.conflicts,
          })
        }
        // Clean auto-merge: apply fresh ops onto current cloud nodes.
        const mergedNodes = merge.nodes
        const applied = await this._appendOps(docId, doc, fresh, {
          mergedNodes,
        })
        return {
          ok: true,
          merged: true,
          version: applied.version,
          acks: [...acks, ...applied.acks],
          snapshot: { version: applied.version, nodes: applied.nodes },
          remoteOps,
        }
      }

      // 3) Fast path: baseline is current (or client ahead only with its own).
      const applied = await this._appendOps(docId, doc, fresh)
      return {
        ok: true,
        merged: false,
        version: applied.version,
        acks: [...acks, ...applied.acks],
        snapshot: { version: applied.version, nodes: applied.nodes },
        remoteOps: [],
      }
    })
  }

  async _appendOps(docId, doc, ops, { mergedNodes } = {}) {
    const acks = []
    let version = doc.version
    // `mergedNodes` is the fully merged node set for the whole batch (used on
    // the stale auto-merge path so we don't double-apply onto the cloud line).
    // On the fast path we start from the current doc nodes and replay ops.
    let nodes = doc.nodes.map((n) => ({ ...n }))
    const now = Date.now()
    for (let index = 0; index < ops.length; index += 1) {
      const op = ops[index]
      version += 1
      const stored = {
        ...op,
        fingerprint: op.fingerprint || fp(op),
        version,
        receivedAt: now,
      }
      if (mergedNodes) {
        // mergedNodes already reflects the ENTIRE merged batch. The final op
        // lands on that exact set; intermediate versions within the batch use
        // prefix replay (batches are typically a single op).
        nodes =
          index === ops.length - 1
            ? mergedNodes.map((n) => ({ ...n }))
            : applyOps(nodes, [op])
      } else {
        nodes = applyOps(nodes, [op])
      }
      // Exact per-version snapshot so a stale baseline can always be rebuilt
      // as the TRUE common ancestor, even across folded auto-merges.
      await this.repo.putSnapshot({
        docId,
        version,
        nodes: nodes.map((n) => ({ ...n })),
      })
      await this.repo.appendOp(docId, stored)
      acks.push({ opId: op.opId, version, fingerprint: stored.fingerprint })
    }
    const updated = {
      ...doc,
      version,
      nodes,
      contentHash: contentHash(JSON.stringify(nodes)),
      updatedAt: now,
    }
    await this.repo.putDoc(updated)
    return { version, nodes, acks }
  }

  async createCheckpoint(docId, name) {
    return this._withLock(docId, async () => {
      const doc = await this.repo.getDoc(docId)
      if (!doc) throw Object.assign(new Error('doc not found'), { code: 'NOT_FOUND' })
      const checkpoint = {
        docId,
        name,
        version: doc.version,
        nodes: doc.nodes.map((n) => ({ ...n })),
        contentHash: doc.contentHash,
        createdAt: Date.now(),
      }
      await this.repo.putCheckpoint(checkpoint)
      return checkpoint
    })
  }

  async listCheckpoints(docId) {
    return this.repo.listCheckpoints(docId)
  }
}

function redact(op) {
  const { version, receivedAt, ...rest } = op
  return rest
}
