// Catalpa document is modelled as an ordered list of blocks (nodes).
// Each block is one logical element: heading / paragraph / list / quote /
// code block / hr. Lists and quotes may span several source lines, so a
// block has `text` (its raw multi-line text) and `kind`.

const HR = /^(-{3,}|\*{3,}|_{3,})$/
const FENCE = /^```/
const HEADING = /^#{1,6}\s+/
const ORDERED = /^\s*\d+\.\s+/
const UNORDERED = /^\s*[-*+]\s+/

export function classifyLine(line) {
  const t = line.trim()
  if (FENCE.test(t)) return 'fence'
  if (HEADING.test(t)) return 'heading'
  if (/^>\s?/.test(t)) return 'quote'
  if (HR.test(t)) return 'hr'
  if (ORDERED.test(t)) return 'ol'
  if (UNORDERED.test(t)) return 'ul'
  return 'paragraph'
}

/** Parse source text into id-less blocks [{ kind, text }]. */
export function parseBlocks(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i].trimEnd()
    const t = line.trim()

    if (t === '') {
      i += 1
      continue
    }

    const kind = classifyLine(line)

    if (kind === 'fence') {
      const buf = [line]
      i += 1
      while (i < lines.length && !FENCE.test(lines[i].trim())) {
        buf.push(lines[i])
        i += 1
      }
      if (i < lines.length) {
        buf.push(lines[i].trim())
        i += 1
      }
      blocks.push({ kind: 'code', text: buf.join('\n') })
      continue
    }

    if (kind === 'heading' || kind === 'hr') {
      blocks.push({ kind, text: t })
      i += 1
      continue
    }

    if (kind === 'quote') {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        // preserve the `>` marker so the source round-trips exactly
        buf.push(lines[i].trim())
        i += 1
      }
      blocks.push({ kind: 'quote', text: buf.join('\n') })
      continue
    }

    if (kind === 'ol' || kind === 'ul') {
      const buf = []
      const listKind = kind
      while (i < lines.length && classifyLine(lines[i]) === listKind) {
        buf.push(lines[i].trim())
        i += 1
      }
      blocks.push({ kind: listKind, text: buf.join('\n') })
      continue
    }

    const buf = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      classifyLine(lines[i]) === 'paragraph'
    ) {
      buf.push(lines[i].trim())
      i += 1
    }
    blocks.push({ kind: 'paragraph', text: buf.join(' ') })
  }

  return blocks
}

/** Serialize blocks back to Catalpa source text. */
export function serializeBlocks(blocks) {
  return blocks.map((b) => (typeof b === 'string' ? b : b.text)).join('\n\n')
}

// ---- Stable node ids -------------------------------------------------------

let nodeCounter = 0
export function newNodeId() {
  nodeCounter += 1
  return `n_${Date.now().toString(36)}_${nodeCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

export function assignIds(blocks) {
  return blocks.map((b) => ({ id: newNodeId(), kind: b.kind, text: b.text }))
}

// ---- LCS alignment ---------------------------------------------------------

function lcsTable(a, b, equal) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let x = m - 1; x >= 0; x -= 1) {
    for (let y = n - 1; y >= 0; y -= 1) {
      if (equal(a[x], b[y])) {
        dp[x][y] = dp[x + 1][y + 1] + 1
      } else {
        dp[x][y] = Math.max(dp[x + 1][y], dp[x][y + 1])
      }
    }
  }
  return dp
}

/**
 * Align old nodes and new blocks into [old|null, new|null] pairs.
 * Exact matches (same kind+text) stay together; others are delete/insert
 * candidates which diffToOps may pair as same-kind updates.
 */
export function alignBlocks(oldNodes, newBlocks) {
  const same = (x, y) => x.kind === y.kind && x.text === y.text
  const dp = lcsTable(oldNodes, newBlocks, same)
  const pairs = []
  let i = 0
  let j = 0
  while (i < oldNodes.length && j < newBlocks.length) {
    if (same(oldNodes[i], newBlocks[j])) {
      pairs.push([oldNodes[i], newBlocks[j]])
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pairs.push([oldNodes[i], null])
      i += 1
    } else {
      pairs.push([null, newBlocks[j]])
      j += 1
    }
  }
  while (i < oldNodes.length) {
    pairs.push([oldNodes[i], null])
    i += 1
  }
  while (j < newBlocks.length) {
    pairs.push([null, newBlocks[j]])
    j += 1
  }
  return pairs
}

/**
 * Diff old node array against newly parsed blocks and emit node operations.
 *
 * Strategy: LCS aligns identical blocks; leftover old/new blocks of the same
 * kind are paired in order as *updates* (node id preserved — this is the key
 * to node-based merging); leftover old blocks are deletes; leftover new
 * blocks are inserts with fresh ids and afterId anchors.
 *
 * @param makeOp  (fields) => op   caller stamps opId/timestamps/device.
 * @param context object spread into every emitted op
 */
export function diffToOps(oldNodes, newBlocks, makeOp, context = {}) {
  const identical = (x, y) => x.kind === y.kind && x.text === y.text
  const dp = lcsTable(oldNodes, newBlocks, identical)

  // 1) LCS walk into pairs.
  const pairs = []
  let i = 0
  let j = 0
  while (i < oldNodes.length && j < newBlocks.length) {
    if (identical(oldNodes[i], newBlocks[j])) {
      pairs.push({ old: oldNodes[i], next: newBlocks[j], role: 'same' })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pairs.push({ old: oldNodes[i], next: null, role: 'oldonly' })
      i += 1
    } else {
      pairs.push({ old: null, next: newBlocks[j], role: 'newonly' })
      j += 1
    }
  }
  while (i < oldNodes.length) {
    pairs.push({ old: oldNodes[i], next: null, role: 'oldonly' })
    i += 1
  }
  while (j < newBlocks.length) {
    pairs.push({ old: null, next: newBlocks[j], role: 'newonly' })
    j += 1
  }

  // 2) Pair same-kind leftovers as updates (in source order per kind).
  const oldByKind = new Map()
  const newByKind = new Map()
  for (const p of pairs) {
    if (p.role === 'oldonly') {
      if (!oldByKind.has(p.old.kind)) oldByKind.set(p.old.kind, [])
      oldByKind.get(p.old.kind).push(p)
    } else if (p.role === 'newonly') {
      if (!newByKind.has(p.next.kind)) newByKind.set(p.next.kind, [])
      newByKind.get(p.next.kind).push(p)
    }
  }
  const updatePairs = []
  for (const kind of new Set([...oldByKind.keys(), ...newByKind.keys()])) {
    const olds = oldByKind.get(kind) || []
    const news = newByKind.get(kind) || []
    // Pair leftovers greedily, but only treat as an UPDATE when the text
    // actually differs. Same-kind + same-text leftovers are a MOVE (or a
    // swap), which must stay delete+insert to preserve the new ordering.
    let oi = 0
    let ni = 0
    while (oi < olds.length && ni < news.length) {
      if (olds[oi].old.text !== news[ni].next.text) {
        updatePairs.push([olds[oi], news[ni]])
        oi += 1
        ni += 1
      } else {
        // identical text: leave both for delete/insert handling
        oi += 1
        ni += 1
      }
    }
  }
  const updateOldPairs = new Set(updatePairs.map(([o]) => o))
  const updateNewPairs = new Set(updatePairs.map(([, w]) => w))

  // 3) Walk pairs in order to build the final node array with stable ids.
  const finalNodes = []
  const inserts = [] // { pair, id }
  const deletes = [] // { node }
  const updates = [] // { oldNode, nextBlock }
  for (const p of pairs) {
    if (p.role === 'same') {
      finalNodes.push({ id: p.old.id, kind: p.old.kind, text: p.old.text })
    } else if (p.role === 'oldonly') {
      if (updateOldPairs.has(p)) {
        const w = updatePairs.find(([o]) => o === p)[1]
        finalNodes.push({ id: p.old.id, kind: w.next.kind, text: w.next.text })
        updates.push({ oldNode: p.old, nextBlock: w.next })
      } else {
        deletes.push({ node: p.old })
      }
    } else if (p.role === 'newonly') {
      if (updateNewPairs.has(p)) {
        // consumed as an update on its paired old node; skip here
        continue
      }
      const id = newNodeId()
      finalNodes.push({ id, kind: p.next.kind, text: p.next.text })
      inserts.push({ pair: p, id })
    }
  }

  // 4) Emit ops: deletes first, then inserts in final order with anchors,
  //    then updates. This ordering is valid when applied on the server:
  //    insert anchors always refer to nodes that survive (same/update) or
  //    other newly inserted nodes.
  const ops = []
  for (const d of deletes) {
    ops.push(makeOp({ type: 'delete', nodeId: d.node.id, ...context }))
  }
  finalNodes.forEach((node, idx) => {
    const ins = inserts.find((x) => x.id === node.id)
    if (!ins) return
    const afterId = idx === 0 ? null : finalNodes[idx - 1].id
    ops.push(makeOp({
      type: 'insert',
      nodeId: node.id,
      afterId,
      content: { kind: node.kind, text: node.text },
      ...context,
    }))
  })
  for (const u of updates) {
    ops.push(makeOp({
      type: 'update',
      nodeId: u.oldNode.id,
      content: { kind: u.nextBlock.kind, text: u.nextBlock.text },
      ...context,
    }))
  }

  return { ops, nodes: finalNodes }
}
