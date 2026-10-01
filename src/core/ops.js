// Operation model for the node-based merge track.
//
// A document is an ordered array of nodes. Nodes have stable `id`s across
// edits so moves/edits can be merged instead of diffing whole text blobs.
//
// Operation:
//   {
//     opId: string,              // globally unique, stable across retries
//     docId, parentId?
//     type: 'insert' | 'update' | 'delete',
//     nodeId: string,            // node targeted / created
//     afterId: string | null,    // for insert: anchor node id (null = head)
//     content?: { kind, text },  // insert/update payload
//     baseVersion: number,       // server version the client rebased on
//     clientClock: number,       // local monotonic ms timestamp (tie-break only)
//     deviceId: string,
//     fingerprint: string        // hash of the operation's semantic content
//   }
//
// The fingerprint deliberately excludes opId and status so the SAME opId
// retried with different content is detectable as a hard conflict.

import { contentHash } from './hash.js'

let counter = 0
export function makeOpId(deviceId) {
  counter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `op_${Date.now().toString(36)}_${counter.toString(36)}_${deviceId.slice(0, 6)}_${rand}`
}

const FINGERPRINT_FIELDS = [
  'type',
  'nodeId',
  'afterId',
  'content',
  'baseVersion',
  'docId',
  'parentId',
]

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`
}

export function fingerprint(op) {
  const pick = {}
  for (const key of FINGERPRINT_FIELDS) {
    if (op[key] !== undefined) pick[key] = op[key]
  }
  // Recursive canonical stringify so nested content (kind/text) is covered.
  return contentHash(stableStringify(pick))
}

export function withFingerprint(op) {
  return { ...op, fingerprint: fingerprint(op) }
}

export function sameOperation(a, b) {
  // Identity is opId; agreement is fingerprint.
  return a.opId === b.opId && a.fingerprint === b.fingerprint
}

export class OpConflictError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'OpConflictError'
    this.code = 'OP_ID_CONFLICT'
    this.details = details
  }
}

export class AnchorError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AnchorError'
    this.code = 'ANCHOR_MISSING'
    this.details = details
  }
}

/**
 * Apply one op to a cloned/working node array. Returns the new array.
 * Pure: does not mutate `nodes`.
 */
export function applyOne(nodes, op, { strictAnchor = false } = {}) {
  const next = nodes.map((n) => ({ ...n }))
  const indexById = new Map(next.map((n, i) => [n.id, i]))

  if (op.type === 'insert') {
    if (!op.content || typeof op.content.text !== 'string') {
      throw new AnchorError(`insert ${op.opId} missing content`)
    }
    const node = {
      id: op.nodeId,
      kind: op.content.kind || 'paragraph',
      text: op.content.text,
    }
    if (op.afterId === null || op.afterId === undefined) {
      next.unshift(node)
    } else {
      const at = indexById.get(op.afterId)
      if (at === undefined) {
        if (strictAnchor) {
          throw new AnchorError(`anchor ${op.afterId} missing for insert ${op.opId}`, {
            opId: op.opId,
            afterId: op.afterId,
          })
        }
        // Loose recovery: append at end instead of dropping the edit.
        next.push(node)
      } else {
        next.splice(at + 1, 0, node)
      }
    }
    return next
  }

  if (op.type === 'update') {
    const at = indexById.get(op.nodeId)
    if (at === undefined) {
      throw new AnchorError(`update targets missing node ${op.nodeId}`, { opId: op.opId })
    }
    next[at] = {
      ...next[at],
      ...(op.content ? { ...op.content } : {}),
      id: op.nodeId,
    }
    return next
  }

  if (op.type === 'delete') {
    const at = indexById.get(op.nodeId)
    if (at === undefined) {
      // Idempotent delete of an already-absent node is a no-op, not an error.
      return next
    }
    next.splice(at, 1)
    return next
  }

  throw new AnchorError(`unknown op type ${op.type}`)
}

/**
 * Apply an ordered list of ops. Returns final nodes.
 * Order matters: operations are applied in the sequence given.
 */
export function applyOps(nodes, ops, opts = {}) {
  let result = nodes
  for (const op of ops) {
    result = applyOne(result, op, opts)
  }
  return result
}

/**
 * Rebuild a document snapshot by replaying operations on top of an ancestor.
 * Used both server-side (checkpoint + tail) and client-side (base + local).
 */
export function replay(ancestorNodes, orderedOps, opts = {}) {
  return applyOps(ancestorNodes || [], orderedOps, opts)
}
