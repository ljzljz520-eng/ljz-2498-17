// Derive "how reliably saved is each part of the document" from operations.
//
// Three states (per requirement):
//   local    — locally saved in the IndexedDB queue, not yet acknowledged
//   received — the server has accepted the op (has a server version)
//   saved    — folded into a named checkpoint (a durable save point)
//
// We compute node state by looking at the LAST op touching each node, then
// map nodes onto source line ranges so the editor can highlight exactly
// which ranges are not yet reliably saved.

import { parseBlocks } from './blocks.js'

export const STATE = Object.freeze({
  LOCAL: 'local',
  RECEIVED: 'received',
  SAVED: 'saved',
})

const RANK = { local: 0, received: 1, saved: 2 }

/**
 * Per-node state from the op log. The LAST op (chronological append order)
 * touching a node determines its local/received/saved state.
 */
export function nodeStateMap(localOps) {
  const map = new Map()
  for (const op of localOps) {
    const status = op.status || 'local'
    if (op.type === 'delete') {
      map.set(op.nodeId, { state: status, deleted: true, op })
      continue
    }
    const prev = map.get(op.nodeId)
    if (!prev || RANK[status] <= RANK[prev.state]) {
      map.set(op.nodeId, { state: status, deleted: false, op })
    }
  }
  return map
}

/**
 * Annotate current nodes with how reliably each is saved.
 *
 * Priority:
 *   - a node with an op in the log  -> that op's status
 *   - a node identical to a named checkpoint -> saved
 *   - a node identical to the server baseline -> received (server has it but
 *     no explicit save point wraps it)
 *   - otherwise -> local (unrecognized/unsynced)
 *
 * @param options.checkpointNodes  node[] of the latest named checkpoint
 * @param options.baselineNodes    node[] of the server ancestor
 */
export function annotateNodes(currentNodes, localOps, options = {}) {
  const states = nodeStateMap(localOps)
  const cp = new Map((options.checkpointNodes || []).map((n) => [n.id, n]))
  const base = new Map((options.baselineNodes || []).map((n) => [n.id, n]))

  return currentNodes.map((node) => {
    const s = states.get(node.id)
    if (s) return { id: node.id, kind: node.kind, text: node.text, state: s.state }

    const cpNode = cp.get(node.id)
    if (cpNode && cpNode.kind === node.kind && cpNode.text === node.text) {
      return { id: node.id, kind: node.kind, text: node.text, state: STATE.SAVED }
    }
    const baseNode = base.get(node.id)
    if (baseNode && baseNode.kind === node.kind && baseNode.text === node.text) {
      return { id: node.id, kind: node.kind, text: node.text, state: STATE.RECEIVED }
    }
    return { id: node.id, kind: node.kind, text: node.text, state: STATE.LOCAL }
  })
}

/**
 * Build line-level state for the textarea gutter.
 * Blocks join with '\n\n' (serializeBlocks). We reconstruct the starting
 * line of each block in the current source.
 */
export function lineStates(currentNodes, source, localOps, options = {}) {
  const annotated = annotateNodes(currentNodes, localOps, options)
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const out = lines.map(() => null) // null = blank separator line
  let cursor = 0
  for (const block of annotated) {
    const height = block.text.split('\n').length
    for (let h = 0; h < height && cursor + h < out.length; h += 1) {
      out[cursor + h] = block.state
    }
    cursor += height + 1 // block lines + the single blank separator line
  }
  return out
}

/**
 * Collect contiguous ranges (by block) that are not yet reliably saved.
 * "Reliably saved" = named checkpoint state. received/local are "pending";
 * the span's reported state is the WORST (least reliable) member so the UI
 * never understates what could still be lost.
 */
export function pendingRanges(currentNodes, localOps, options = {}) {
  const annotated = annotateNodes(currentNodes, localOps, options)
  const ranges = []
  let current = null
  annotated.forEach((block, index) => {
    const pending = block.state !== STATE.SAVED
    if (pending && (!current || current.to !== index - 1)) {
      if (current) ranges.push(current)
      current = { from: index, to: index, state: block.state, blocks: [] }
    }
    if (pending) {
      current.to = index
      if (RANK[block.state] < RANK[current.state]) current.state = block.state
      current.blocks.push(block)
    }
  })
  if (current) ranges.push(current)
  return ranges
}

/** Human-readable description of the unsaved span, by text snippet. */
export function describeRange(range) {
  const first = range.blocks[0]
  const text = (first.text || '').split('\n')[0].slice(0, 24)
  const count = range.blocks.length
  return count === 1
    ? `“${text}”`
    : `“${text}” 等 ${count} 个段落`
}
