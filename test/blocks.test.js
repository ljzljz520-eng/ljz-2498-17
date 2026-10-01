import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBlocks,
  serializeBlocks,
  diffToOps,
  assignIds,
} from '../src/core/blocks.js'
import { applyOps } from '../src/core/ops.js'
import { lineStates, pendingRanges, annotateNodes, STATE } from '../src/core/ranges.js'

let seq = 0
const makeOp = (fields) => ({
  opId: `op${++seq}`,
  clientClock: Date.now(),
  deviceId: 'dev',
  ...fields,
})

test('parse/serialize round trips headings, lists, quotes, code, hr', () => {
  const src = [
    '# Title',
    '',
    'A paragraph.',
    '',
    '- one',
    '- two',
    '',
    '> quoted',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '---',
  ].join('\n')
  const blocks = parseBlocks(src)
  const kinds = blocks.map((b) => b.kind)
  assert.deepEqual(kinds, ['heading', 'paragraph', 'ul', 'quote', 'code', 'hr'])
  const out = serializeBlocks(blocks)
  assert.equal(out, src)
})

test('diff preserves node id for an in-place text edit (update not delete+insert)', () => {
  const oldNodes = assignIds(parseBlocks('# H\n\nBody text'))
  const next = parseBlocks('# H\n\nBody edited')
  const { ops, nodes } = diffToOps(oldNodes, next, makeOp)
  const updates = ops.filter((o) => o.type === 'update')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].nodeId, oldNodes[1].id)
  assert.equal(ops.filter((o) => o.type === 'insert').length, 0)
  assert.equal(ops.filter((o) => o.type === 'delete').length, 0)
  // applying reproduces the target
  const applied = applyOps(oldNodes, ops)
  assert.equal(serializeBlocks(applied), serializeBlocks(next))
})

test('diff emits insert with afterId anchor and delete for removed block', () => {
  const oldNodes = assignIds(parseBlocks('A\n\nB'))
  const next = parseBlocks('A\n\nB\n\nC')
  const { ops } = diffToOps(oldNodes, next, makeOp)
  const insert = ops.find((o) => o.type === 'insert')
  assert.ok(insert)
  assert.equal(insert.afterId, oldNodes[1].id)

  const baseNodes = assignIds(parseBlocks('A\n\nB'))
  const removed = diffToOps(baseNodes, parseBlocks('A'), makeOp)
  const del = removed.ops.find((o) => o.type === 'delete')
  assert.ok(del)
  assert.equal(del.nodeId, baseNodes[1].id)
})

test('reorder: swapping two equal paragraphs is insert+delete anchored correctly', () => {
  const oldNodes = assignIds(parseBlocks('AAA\n\nBBB'))
  const next = parseBlocks('BBB\n\nAAA')
  const { ops } = diffToOps(oldNodes, next, makeOp)
  const applied = applyOps(oldNodes, ops)
  assert.deepEqual(applied.map((n) => n.text), ['BBB', 'AAA'])
})

test('line states and pending ranges pinpoint unsaved scope', () => {
  const nodes = assignIds(parseBlocks('# H\n\nLocal para\n\nSaved para'))
  const ops = [
    { opId: 'a', type: 'insert', nodeId: nodes[0].id, status: STATE.SAVED },
    { opId: 'b', type: 'insert', nodeId: nodes[1].id, status: STATE.LOCAL },
    { opId: 'c', type: 'insert', nodeId: nodes[2].id, status: STATE.RECEIVED },
  ]
  const source = serializeBlocks(nodes)
  const lines = lineStates(nodes, source, ops)
  // line 0 heading saved, line 2 local, line 4 received
  assert.equal(lines[0], STATE.SAVED)
  assert.equal(lines[2], STATE.LOCAL)
  assert.equal(lines[4], STATE.RECEIVED)
  const pending = pendingRanges(nodes, ops)
  // the two adjacent pending blocks (local+received) merge into one span;
  // its worst state is LOCAL so the UI reports the not-yet-safe extent
  assert.equal(pending.length, 1)
  assert.equal(pending[0].from, 1)
  assert.equal(pending[0].to, 2)
  assert.equal(pending[0].state, STATE.LOCAL)
})

test('state falls back to checkpoint=saved and baseline=received', () => {
  const nodes = [
    { id: 'cp', kind: 'p', text: 'at checkpoint' },
    { id: 'base', kind: 'p', text: 'on server only' },
    { id: 'new', kind: 'p', text: 'brand new' },
  ]
  const annotated = annotateNodes(nodes, [], {
    checkpointNodes: [{ id: 'cp', kind: 'p', text: 'at checkpoint' }],
    baselineNodes: [
      { id: 'cp', kind: 'p', text: 'at checkpoint' },
      { id: 'base', kind: 'p', text: 'on server only' },
    ],
  })
  assert.equal(annotated[0].state, STATE.SAVED)
  assert.equal(annotated[1].state, STATE.RECEIVED)
  assert.equal(annotated[2].state, STATE.LOCAL)
})
