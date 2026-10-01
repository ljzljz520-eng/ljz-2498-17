import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, withFingerprint, makeOpId } from '../src/core/ops.js'
import { threeWayMerge, applyResolutions } from '../src/core/merge.js'

function op(fields) {
  return withFingerprint({
    opId: makeOpId('dev'),
    docId: 'd',
    baseVersion: 0,
    clientClock: Date.now(),
    deviceId: 'dev',
    ...fields,
  })
}

const ancestor = [
  { id: 'a', kind: 'heading', text: 'Title' },
  { id: 'b', kind: 'paragraph', text: 'Body' },
  { id: 'c', kind: 'paragraph', text: 'Footer' },
]

test('non-overlapping edits auto-merge regardless of timestamps', () => {
  const local = [
    op({ type: 'update', nodeId: 'a', content: { kind: 'heading', text: 'New Title' } }),
  ]
  // remote edited LATER but touches a DIFFERENT node; merge must keep both
  const remote = [
    op({
      type: 'update',
      nodeId: 'c',
      content: { kind: 'paragraph', text: 'Newer Footer' },
      clientClock: Date.now() + 99999,
    }),
  ]
  const result = threeWayMerge(ancestor, local, remote)
  assert.equal(result.autoMerged, true)
  const map = Object.fromEntries(result.nodes.map((n) => [n.id, n.text]))
  assert.equal(map.a, 'New Title')
  assert.equal(map.b, 'Body')
  assert.equal(map.c, 'Newer Footer')
})

test('same node edited differently on both branches => update_update conflict', () => {
  const local = [op({ type: 'update', nodeId: 'b', content: { kind: 'paragraph', text: 'local body' } })]
  const remote = [op({ type: 'update', nodeId: 'b', content: { kind: 'paragraph', text: 'remote body' } })]
  const result = threeWayMerge(ancestor, local, remote)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].kind, 'update_update')
})

test('delete vs edit => structural delete_update conflict', () => {
  const local = [op({ type: 'delete', nodeId: 'b' })]
  const remote = [op({ type: 'update', nodeId: 'b', content: { kind: 'paragraph', text: 'kept edit' } })]
  const result = threeWayMerge(ancestor, local, remote)
  assert.equal(result.conflicts[0].kind, 'delete_update')
  assert.equal(result.conflicts[0].deletedBy, 'local')
})

test('both delete same node is clean', () => {
  const local = [op({ type: 'delete', nodeId: 'b' })]
  const remote = [op({ type: 'delete', nodeId: 'b' })]
  const result = threeWayMerge(ancestor, local, remote)
  assert.equal(result.autoMerged, true)
  assert.ok(!result.nodes.find((n) => n.id === 'b'))
})

test('one side deletes, other untouched => delete wins cleanly', () => {
  const local = [op({ type: 'delete', nodeId: 'b' })]
  const result = threeWayMerge(ancestor, local, [])
  assert.equal(result.autoMerged, true)
  assert.ok(!result.nodes.find((n) => n.id === 'b'))
})

test('both insert same content => deduped via shared opId', () => {
  const shared = op({
    type: 'insert',
    nodeId: 'x',
    afterId: 'c',
    content: { kind: 'paragraph', text: 'Added by both' },
  })
  const result = threeWayMerge(ancestor, [shared], [shared])
  assert.equal(result.autoMerged, true)
  assert.equal(result.nodes.filter((n) => n.id === 'x').length, 1)
})

test('local-only insert survives remote ordering and appears near anchor', () => {
  const remote = [op({ type: 'update', nodeId: 'a', content: { kind: 'heading', text: 'Remote Title' } })]
  const local = [
    op({
      type: 'insert',
      nodeId: 'z',
      afterId: 'a',
      content: { kind: 'paragraph', text: 'Local insert' },
    }),
  ]
  const result = threeWayMerge(ancestor, local, remote)
  assert.equal(result.autoMerged, true)
  const ids = result.nodes.map((n) => n.id)
  const zAt = ids.indexOf('z')
  const aAt = ids.indexOf('a')
  assert.ok(zAt > aAt)
  assert.equal(result.nodes[zAt].text, 'Local insert')
})

test('human resolution picks local/remote/custom and applies', () => {
  const local = [op({ type: 'update', nodeId: 'b', content: { kind: 'paragraph', text: 'L' } })]
  const remote = [op({ type: 'update', nodeId: 'b', content: { kind: 'paragraph', text: 'R' } })]
  const merge = threeWayMerge(ancestor, local, remote)
  const decisions = new Map([
    [merge.conflicts[0].id, { resolution: 'custom', content: { kind: 'paragraph', text: 'MINE' } }],
  ])
  const nodes = applyResolutions(merge, decisions)
  assert.equal(nodes.find((n) => n.id === 'b').text, 'MINE')
})

test('applyOps: insert anchor and idempotent delete', () => {
  const ops = [
    op({ type: 'insert', nodeId: 'n1', afterId: null, content: { kind: 'p', text: 'x' } }),
    op({ type: 'delete', nodeId: 'n1' }),
    op({ type: 'delete', nodeId: 'n1' }), // idempotent
  ]
  const nodes = applyOps([], ops)
  assert.equal(nodes.length, 0)
})
