import { hashString } from './ids.js'

export function blocksFromText(text) {
  return text.replace(/\r\n/g, '\n').split('\n').map((content, index) => ({
    id: `seed-${index}-${hashString(`${index}:${content || ' '}`)}`,
    content,
  }))
}

export function textFromBlocks(blocks) {
  return blocks.map((block) => block.content).join('\n')
}

function lcsIndexes(oldLines, newLines) {
  const m = oldLines.length
  const n = newLines.length
  const table = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const pairs = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

function rangeForLine(lines, index) {
  let start = 0
  for (let i = 0; i < index; i += 1) start += lines[i].length + 1
  return { start, end: start + lines[index].length }
}

/**
 * Convert plain text edits into stable node operations.
 * The output is deterministic and preserves node IDs across edits via LCS.
 */
export function diffBlocks(oldBlocks, nextText) {
  const oldLines = oldBlocks.map((block) => block.content)
  const newLines = nextText.replace(/\r\n/g, '\n').split('\n')
  const pairs = lcsIndexes(oldLines, newLines)
  const segments = [[-1, -1], ...pairs, [oldLines.length, newLines.length]]
  const deletes = []
  const updates = []
  const inserts = []

  for (let segment = 0; segment < segments.length - 1; segment += 1) {
    const [oldEnd, newEnd] = segments[segment]
    const [nextOld, nextNew] = segments[segment + 1]
    const oldGap = nextOld - oldEnd - 1
    const newGap = nextNew - newEnd - 1
    const aligned = Math.min(oldGap, newGap)

    for (let k = 0; k < aligned; k += 1) {
      const oldIndex = oldEnd + 1 + k
      const newIndex = newEnd + 1 + k
      updates.push({
        type: 'update_node',
        nodeId: oldBlocks[oldIndex].id,
        parentId: 'root',
        content: newLines[newIndex],
        range: { ...rangeForLine(newLines, newIndex), line: newIndex + 1 },
      })
    }

    for (let k = aligned; k < oldGap; k += 1) {
      const oldIndex = oldEnd + 1 + k
      deletes.push({
        type: 'delete_node',
        nodeId: oldBlocks[oldIndex].id,
        parentId: 'root',
        range: { ...rangeForLine(oldLines, oldIndex), line: oldIndex + 1 },
      })
    }

    let afterNodeId = oldEnd >= 0 ? oldBlocks[oldEnd].id : null
    const beforeNodeId = nextOld < oldLines.length ? oldBlocks[nextOld].id : null
    for (let k = aligned; k < newGap; k += 1) {
      const newIndex = newEnd + 1 + k
      const nodeId = `n-${hashString(`${newIndex}:${newLines[newIndex] || ' '}:${Date.now()}:${Math.random()}`)}`
      inserts.push({
        type: 'insert_node',
        nodeId,
        parentId: 'root',
        afterNodeId,
        beforeNodeId: k === aligned ? beforeNodeId : null,
        content: newLines[newIndex],
        range: { ...rangeForLine(newLines, newIndex), line: newIndex + 1 },
      })
      afterNodeId = nodeId
    }
  }

  const operations = [...deletes, ...updates, ...inserts].map((op, index) => ({ ...op, order: index }))
  return { operations, nextBlocks: rebuildBlocks(oldBlocks, operations) }
}

export function rebuildBlocks(baseBlocks, operations) {
  const blocks = new Map(baseBlocks.map((block) => [block.id, { ...block }]))
  const ordered = [...baseBlocks.map((block) => block.id)]

  for (const op of [...operations].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (op.type === 'insert_node') {
      if (blocks.has(op.nodeId)) continue
      blocks.set(op.nodeId, { id: op.nodeId, content: op.content ?? '' })
      const afterIndex = op.afterNodeId ? ordered.indexOf(op.afterNodeId) : -1
      const beforeIndex = op.beforeNodeId ? ordered.indexOf(op.beforeNodeId) : -1
      if (afterIndex >= 0) ordered.splice(afterIndex + 1, 0, op.nodeId)
      else if (beforeIndex >= 0) ordered.splice(beforeIndex, 0, op.nodeId)
      else ordered.push(op.nodeId)
    } else if (op.type === 'update_node') {
      const block = blocks.get(op.nodeId)
      if (!block) continue
      block.content = op.content ?? ''
      if (!ordered.includes(op.nodeId)) ordered.push(op.nodeId)
    } else if (op.type === 'delete_node') {
      blocks.delete(op.nodeId)
      const index = ordered.indexOf(op.nodeId)
      if (index >= 0) ordered.splice(index, 1)
    }
  }

  return ordered.map((id) => blocks.get(id)).filter(Boolean)
}
