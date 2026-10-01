import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryKV, QuotaError } from '../src/core/storage.js'
import { MemoryBus } from '../src/core/bus.js'
import { MemoryLeader } from '../src/core/leader.js'
import { OperationQueue } from '../src/core/queue.js'
import { withFingerprint, makeOpId } from '../src/core/ops.js'

function makeOp(dev, fields) {
  return withFingerprint({
    opId: makeOpId(dev),
    docId: 'd',
    baseVersion: 0,
    clientClock: Date.now(),
    deviceId: dev,
    ...fields,
  })
}

async function boot(kv, deviceId = 'devA') {
  const bus = new MemoryBus()
  const q = new OperationQueue({ kv, bus, docId: 'd', deviceId })
  await q.loadOrInit()
  return { q, bus }
}

test('local edit is durable: survives reload (offline reopen)', async () => {
  const kv = new MemoryKV()
  const { q } = await boot(kv)
  const ops = [makeOp('devA', { type: 'insert', nodeId: 'n1', afterId: null, content: { kind: 'p', text: '离线编辑' } })]
  await q.appendLocalOps(ops, [{ id: 'n1', kind: 'p', text: '离线编辑' }])

  // Reopen with a brand-new queue over the SAME storage.
  const reopened = new OperationQueue({ kv, bus: new MemoryBus(), docId: 'd', deviceId: 'devA' })
  await reopened.loadOrInit()
  assert.equal(reopened.hasUnuploadedEdits(), true)
  assert.equal(reopened.localOps()[0].content.text, '离线编辑')
  assert.equal(reopened.localOps()[0].status, 'local')
})

test('two tab contexts share the durable queue via bus reload', async () => {
  const kv = new MemoryKV()
  const bus = new MemoryBus()
  const tab1 = new OperationQueue({ kv, bus, docId: 'd', deviceId: 'tab1' })
  await tab1.loadOrInit()
  const tab2 = new OperationQueue({ kv, bus, docId: 'd', deviceId: 'tab2' })
  await tab2.loadOrInit()

  await tab1.appendLocalOps(
    [makeOp('tab1', { type: 'insert', nodeId: 'x', afterId: null, content: { kind: 'p', text: 'from tab1' } })],
    [{ id: 'x', kind: 'p', text: 'from tab1' }],
  )
  // bus.post in MemoryBus dispatches synchronously to subscribers
  assert.equal(tab2.hasUnuploadedEdits(), true)
  assert.equal(tab2.localOps()[0].deviceId, 'tab1')
})

test('ack promotion local -> received; retry keeps identity (no dup)', async () => {
  const kv = new MemoryKV()
  const { q } = await boot(kv)
  const o = makeOp('devA', { type: 'insert', nodeId: 'n', afterId: null, content: { kind: 'p', text: 'x' } })
  await q.appendLocalOps([o], [{ id: 'n', kind: 'p', text: 'x' }])
  await q.markReceived(
    [{ opId: o.opId, version: 1, fingerprint: o.fingerprint }],
    1,
    { nodes: [{ id: 'n', kind: 'p', text: 'x' }] },
  )
  assert.equal(q.localOps().length, 0)
  assert.equal(q.snapshot.ops[0].status, 'received')
  // re-ack same id again (retry)
  await q.markReceived([{ opId: o.opId, version: 1, fingerprint: o.fingerprint }], 1, null)
  assert.equal(q.snapshot.ops.length, 1)
})

test('same opId different fingerprint is NOT marked received (conflict)', async () => {
  const kv = new MemoryKV()
  const { q } = await boot(kv)
  const o = makeOp('devA', { type: 'insert', nodeId: 'n', afterId: null, content: { kind: 'p', text: 'x' } })
  await q.appendLocalOps([o], [{ id: 'n', kind: 'p', text: 'x' }])
  await q.markReceived(
    [{ opId: o.opId, version: 1, fingerprint: 'different-fp' }],
    1,
    null,
  )
  assert.equal(q.snapshot.ops[0].status, 'local')
})

test('checkpoint folds received ops to saved and prunes them', async () => {
  const kv = new MemoryKV()
  const { q } = await boot(kv)
  const o = makeOp('devA', { type: 'insert', nodeId: 'n', afterId: null, content: { kind: 'p', text: 'x' } })
  await q.appendLocalOps([o], [{ id: 'n', kind: 'p', text: 'x' }])
  await q.markReceived([{ opId: o.opId, version: 1, fingerprint: o.fingerprint }], 1, null)
  const cp = await q.createCheckpoint('v1', [{ id: 'n', kind: 'p', text: 'x' }], 1)
  assert.equal(cp.name, 'v1')
  assert.equal(q.snapshot.ops.length, 0)
  assert.equal(q.snapshot.checkpoint.name, 'v1')
})

test('quota: purges reconstructible cache but never drops unuploaded op', async () => {
  // Tiny quota: baseline record ~ some bytes. First fill caches, then force a
  // queue write while over quota; cache purge must make it succeed and the
  // local op must survive.
  const kv = new MemoryKV({ quota: 4000 })
  const { q } = await boot(kv)
  const o = makeOp('devA', { type: 'insert', nodeId: 'n', afterId: null, content: { kind: 'p', text: 'keep-me' } })
  await q.appendLocalOps([o], [{ id: 'n', kind: 'p', text: 'keep-me' }])
  // stuff a reconstructible cache large enough to blow the quota
  q.snapshot.caches = { preview: 'X'.repeat(6000), html: 'Y'.repeat(4000) }
  let recovered = false
  q.subscribe((e) => {
    if (e.type === 'quota-recovered') recovered = true
  })
  // next persist must evict cache then succeed
  await q.mutate(() => {}, { type: 'touch' })
  assert.equal(recovered, true)
  assert.equal(Object.keys(q.snapshot.caches).length, 0)
  assert.equal(q.hasUnuploadedEdits(), true)
  assert.equal(q.localOps()[0].content.text, 'keep-me')
})

test('quota: when even essential data cannot fit, error and data retained', async () => {
  const kv = new MemoryKV({ quota: 10 })
  const bus = new MemoryBus()
  const q = new OperationQueue({ kv, bus, docId: 'tiny', deviceId: 'dev' })
  await q.loadOrInit().catch(() => {})
  // Even init may fail; assert we never silently drop — error surfaces.
  const o = makeOp('dev', { type: 'insert', nodeId: 'n', afterId: null, content: { kind: 'p', text: 'data' } })
  await assert.rejects(
    q.appendLocalOps([o], [{ id: 'n', kind: 'p', text: 'data' }]),
    (err) => err instanceof QuotaError || err.code === 'QUOTA_EXCEEDED',
  )
})

test('rebase marks old ops superseded but keeps them; undo restores', async () => {
  const kv = new MemoryKV()
  const { q } = await boot(kv)
  const old = makeOp('devA', { type: 'insert', nodeId: 'n1', afterId: null, content: { kind: 'p', text: 'old' } })
  await q.appendLocalOps([old], [{ id: 'n1', kind: 'p', text: 'old' }])
  const { newOps } = await q.rebase({
    newOps: [
      makeOp('devA', {
        type: 'insert',
        nodeId: 'n1',
        afterId: null,
        content: { kind: 'p', text: 'old' },
        baseVersion: 2,
      }),
    ],
    superseded: [old],
    ancestorNodes: [],
    serverVersion: 2,
  })
  assert.equal(q.snapshot.ops.find((x) => x.opId === old.opId).superseded, true)
  assert.equal(q.hasUnuploadedEdits(), true) // replacement still pending
  assert.equal(q.snapshot.serverVersion, 2)
  // undo
  await q.undoRebase({ newOps })
  assert.equal(q.snapshot.ops.find((x) => x.opId === old.opId).superseded, undefined)
})
