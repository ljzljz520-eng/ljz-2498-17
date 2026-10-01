import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { FileRepository } from '../server/file-repo.js'
import { DocumentEngine } from '../server/engine.js'
import { withFingerprint, makeOpId } from '../src/core/ops.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function tempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'catalpa-'))
  return new FileRepository(dir)
}

function op(dev, fields, baseVersion = 0) {
  return withFingerprint({
    opId: makeOpId(dev),
    docId: 'doc',
    baseVersion,
    clientClock: Date.now(),
    deviceId: dev,
    ...fields,
  })
}

async function freshDoc(engine, docId, nodes) {
  await engine.createDoc(docId, nodes)
}

test('fast path: conditional commit on current baseline gets versioned acks', async () => {
  const engine = new DocumentEngine(tempRepo())
  const docId = 'd1'
  await freshDoc(engine, docId, [{ id: 'a', kind: 'paragraph', text: 'A' }])
  const o = op('dev1', { type: 'update', nodeId: 'a', content: { kind: 'paragraph', text: 'A2' } })
  const res = await engine.sync({ docId, ops: [o], baseVersion: 0 })
  assert.equal(res.ok, true)
  assert.equal(res.version, 1)
  assert.equal(res.acks[0].opId, o.opId)
  const doc = await engine.getDoc(docId)
  assert.equal(doc.nodes[0].text, 'A2')
  assert.equal(doc.ops[0].version, 1)
})

test('retry is idempotent: same opId resubmitted returns same ack', async () => {
  const engine = new DocumentEngine(tempRepo())
  const docId = 'd2'
  await freshDoc(engine, docId, [])
  const o = op('dev1', { type: 'insert', nodeId: 'n', afterId: null, content: { kind: 'p', text: 'x' } })
  const first = await engine.sync({ docId, ops: [o], baseVersion: 0 })
  const retry = await engine.sync({ docId, ops: [o], baseVersion: 0 })
  assert.equal(retry.version, 1) // no new version
  assert.equal(retry.acks.length, 1)
  assert.equal(retry.acks[0].version, first.acks[0].version)
  const doc = await engine.getDoc(docId)
  assert.equal(doc.ops.length, 1) // not duplicated
})

test('same opId with DIFFERENT content throws OP_ID_CONFLICT', async () => {
  const engine = new DocumentEngine(tempRepo())
  const docId = 'd3'
  await freshDoc(engine, docId, [])
  const o1 = op('dev1', { type: 'insert', nodeId: 'n', afterId: null, content: { kind: 'p', text: 'original' } })
  await engine.sync({ docId, ops: [o1], baseVersion: 0 })
  // attacker/buggy client reuses id with new content
  const forged = withFingerprint({ ...o1, content: { kind: 'p', text: 'FORGED' } })
  await assert.rejects(
    engine.sync({ docId, ops: [forged], baseVersion: 0 }),
    (err) => err.code === 'OP_ID_CONFLICT',
  )
})

test('stale baseline with non-conflicting ops auto-merges', async () => {
  const engine = new DocumentEngine(tempRepo())
  const docId = 'd4'
  const base = [
    { id: 'a', kind: 'p', text: 'A' },
    { id: 'b', kind: 'p', text: 'B' },
  ]
  await freshDoc(engine, docId, base)
  // cloud edits node b
  const cloud = op('cloud', { type: 'update', nodeId: 'b', content: { kind: 'p', text: 'B-cloud' } })
  await engine.sync({ docId, ops: [cloud], baseVersion: 0 })
  // device was offline at v0, edits node a
  const local = op('dev', { type: 'update', nodeId: 'a', content: { kind: 'p', text: 'A-local' } }, 0)
  const res = await engine.sync({ docId, ops: [local], baseVersion: 0 })
  assert.equal(res.merged, true)
  const map = Object.fromEntries(res.snapshot.nodes.map((n) => [n.id, n.text]))
  assert.equal(map.a, 'A-local')
  assert.equal(map.b, 'B-cloud')
})

test('stale baseline with conflicting ops returns 409 payload carrying all three branches', async () => {
  const engine = new DocumentEngine(tempRepo())
  const docId = 'd5'
  await freshDoc(engine, docId, [{ id: 'a', kind: 'p', text: 'A' }])
  await engine.sync({
    docId,
    ops: [op('cloud', { type: 'update', nodeId: 'a', content: { kind: 'p', text: 'cloud' } })],
    baseVersion: 0,
  })
  const local = op('dev', { type: 'update', nodeId: 'a', content: { kind: 'p', text: 'local' } }, 0)
  try {
    await engine.sync({ docId, ops: [local], baseVersion: 0 })
    assert.fail('expected stale')
  } catch (err) {
    assert.equal(err.code, 'STALE_BASELINE')
    assert.ok(err.payload.ancestor)
    assert.ok(err.payload.cloud)
    assert.equal(err.payload.remoteOps.length, 1)
    assert.equal(err.payload.conflicts[0].kind, 'update_update')
  }
})

test('doc-level optimistic lock mode refuses ANY stale baseline', async () => {
  const engine = new DocumentEngine(tempRepo())
  const docId = 'd6'
  await freshDoc(engine, docId, [
    { id: 'a', kind: 'p', text: 'A' },
    { id: 'b', kind: 'p', text: 'B' },
  ])
  await engine.sync({
    docId,
    mode: 'doc',
    ops: [op('cloud', { type: 'update', nodeId: 'b', content: { kind: 'p', text: 'B2' } })],
    baseVersion: 0,
  })
  const local = op('dev', { type: 'update', nodeId: 'a', content: { kind: 'p', text: 'A2' } }, 0)
  await assert.rejects(
    engine.sync({ docId, mode: 'doc', ops: [local], baseVersion: 0 }),
    (err) => err.code === 'STALE_BASELINE',
  )
})

test('checkpoint stores received ops snapshot as named save point', async () => {
  const engine = new DocumentEngine(tempRepo())
  const docId = 'd7'
  await freshDoc(engine, docId, [])
  await engine.sync({
    docId,
    ops: [op('dev', { type: 'insert', nodeId: 'a', afterId: null, content: { kind: 'p', text: 'saved content' } })],
    baseVersion: 0,
  })
  const cp = await engine.createCheckpoint(docId, 'milestone-1')
  assert.equal(cp.name, 'milestone-1')
  assert.equal(cp.version, 1)
  assert.equal(cp.nodes[0].text, 'saved content')
  const list = await engine.listCheckpoints(docId)
  assert.equal(list.length, 1)
})

test('ancestor across a folded auto-merge is reconstructed exactly (snapshot)', async () => {
  const engine = new DocumentEngine(tempRepo())
  const docId = 'd-snap'
  await engine.createDoc(docId, [
    { id: 'a', kind: 'p', text: 'A' },
    { id: 'b', kind: 'p', text: 'B' },
  ])
  // v1 cloud edits b
  await engine.sync({
    docId,
    ops: [op('cloud', { type: 'update', nodeId: 'b', content: { kind: 'p', text: 'B-cloud' } })],
    baseVersion: 0,
  })
  // v2 stale local edits a -> folded auto merge
  await engine.sync({
    docId,
    ops: [op('dev', { type: 'update', nodeId: 'a', content: { kind: 'p', text: 'A-local' } }, 0)],
    baseVersion: 0,
  })
  // reconstruct ancestor at v1 must be A / B-cloud (not replayed wrongly)
  const doc = await engine.getDoc(docId)
  const at1 = await engine._nodesAtVersion(docId, doc, 1)
  assert.deepEqual(at1.map((n) => n.text), ['A', 'B-cloud'])
  const at2 = await engine._nodesAtVersion(docId, doc, 2)
  assert.deepEqual(at2.map((n) => n.text), ['A-local', 'B-cloud'])
})

test('stale client editing the SAME node cloud changed via earlier merge conflicts', async () => {
  const engine = new DocumentEngine(tempRepo())
  const docId = 'd-foldconflict'
  await engine.createDoc(docId, [{ id: 'b', kind: 'p', text: 'B' }])
  await engine.sync({
    docId,
    ops: [op('cloud', { type: 'update', nodeId: 'b', content: { kind: 'p', text: 'B-cloud' } })],
    baseVersion: 0,
  })
  // stale base=0 client edits b to a different value
  await assert.rejects(
    engine.sync({
      docId,
      ops: [op('dev', { type: 'update', nodeId: 'b', content: { kind: 'p', text: 'B-stale' } }, 0)],
      baseVersion: 0,
    }),
    (err) => err.code === 'STALE_BASELINE' && err.payload.conflicts[0].kind === 'update_update',
  )
})
