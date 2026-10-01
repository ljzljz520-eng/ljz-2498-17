import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileRepository } from '../server/file-repo.js'
import { createServer } from '../server/http.js'
import { MemoryKV } from '../src/core/storage.js'
import { MemoryBus } from '../src/core/bus.js'
import { OperationQueue } from '../src/core/queue.js'
import { SyncEngine } from '../src/core/sync.js'
import { withFingerprint, makeOpId } from '../src/core/ops.js'

const BASE = { host: '127.0.0.1' }
let server
let origin

test.before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'catalpa-e2e-'))
  server = createServer({ repo: new FileRepository(dir) }).server
  await new Promise((r) => server.listen(0, r))
  origin = `http://127.0.0.1:${server.address().port}/api`
})
test.after(async () => {
  await new Promise((r) => server.close(r))
})

// Minimal fetch-based api client for node (the real src one uses /api path).
function httpApi(extraHeaders = {}) {
  async function call(method, url, body, opts = {}) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...extraHeaders, ...(opts.headers || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: opts.signal,
      })
    } catch (err) {
      throw Object.assign(new Error(err.message), { code: 'NETWORK_UNKNOWN' })
    }
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(payload?.error?.message || 'http'), {
      code: payload?.error?.code || 'HTTP_ERROR',
      status: res.status,
      body: payload,
    })
    return payload
  }
  return {
    getDoc: (id) => call('GET', `${origin}/docs/${id}`),
    ensureDoc: (id, nodes) => call('POST', `${origin}/docs/${id}`, { nodes }),
    sync: (id, payload, opts) => call('POST', `${origin}/docs/${id}/sync`, payload, opts),
    listOps: (id) => call('GET', `${origin}/docs/${id}/ops`),
    createCheckpoint: (id, name) => call('POST', `${origin}/docs/${id}/checkpoints`, { name }),
    listCheckpoints: (id) => call('GET', `${origin}/docs/${id}/checkpoints`),
  }
}

async function makeQueue(docId, deviceId) {
  const kv = new MemoryKV()
  const q = new OperationQueue({ kv, bus: new MemoryBus(), docId, deviceId })
  await q.loadOrInit()
  return { q, kv }
}

function localOp(dev, fields) {
  return withFingerprint({
    opId: makeOpId(dev),
    clientClock: Date.now() + Math.random(),
    deviceId: dev,
    baseVersion: 0,
    ...fields,
  })
}

test('offline edits flush after reconnect; ack lost then reconciled without rebuild', async () => {
  const docId = 'e2e-1'
  await httpApi().ensureDoc(docId, [])
  const { q } = await makeQueue(docId, 'devA')

  const edit = localOp('devA', {
    type: 'insert', nodeId: 'n1', afterId: null,
    content: { kind: 'p', text: 'written offline' },
  })
  await q.appendLocalOps([edit], [{ id: 'n1', kind: 'p', text: 'written offline' }])

  // Engine pointed at a fault header that loses the ack after commit.
  const events = []
  const engine = new SyncEngine({
    queue: q,
    api: httpApi({ 'x-fault': 'timeout' }),
    autoFlush: false,
    timeoutMs: 4000,
    onEvent: (e) => events.push(e.type),
  })
  await engine.flush('test')

  assert.ok(events.includes('unknown-outcome'))
  // reconcile queries ops via a client WITHOUT the fault header -> finds it
  assert.ok(events.includes('recovered-ack'))
  assert.equal(q.hasUnuploadedEdits(), false)
  assert.equal(q.snapshot.ops[0].status, 'received')

  const serverOps = await httpApi().listOps(docId)
  assert.equal(serverOps.ops.length, 1)
  assert.equal(serverOps.ops[0].opId, edit.opId)
})

test('two devices diverge: clean auto-merge; conflicting edit pauses for human then uploads', async () => {
  const docId = 'e2e-2'
  const base = [
    { id: 'a', kind: 'p', text: 'A' },
    { id: 'b', kind: 'p', text: 'B' },
  ]
  await httpApi().ensureDoc(docId, base)

  // Device cloud pushes an edit to B first.
  const { q: cloudQ } = await makeQueue(docId, 'cloud')
  cloudQ.state.serverVersion = 0
  const cloudEdit = localOp('cloud', { type: 'update', nodeId: 'b', content: { kind: 'p', text: 'B-cloud' }, docId })
  await cloudQ.appendLocalOps([cloudEdit], base.map((n) => (n.id === 'b' ? { ...n, text: 'B-cloud' } : n)))
  const cloudEngine = new SyncEngine({ queue: cloudQ, api: httpApi(), autoFlush: false, timeoutMs: 4000 })
  await cloudEngine.flush()
  assert.equal(cloudQ.snapshot.serverVersion, 1)

  // Device local was offline; edits A (clean) — auto merge.
  const { q: localQ } = await makeQueue(docId, 'local')
  const localEdit = localOp('local', { type: 'update', nodeId: 'a', content: { kind: 'p', text: 'A-local' }, docId, baseVersion: 0 })
  await localQ.appendLocalOps([localEdit], [{ id: 'a', kind: 'p', text: 'A-local' }, { id: 'b', kind: 'p', text: 'B' }])
  const localEngine = new SyncEngine({ queue: localQ, api: httpApi(), autoFlush: false, timeoutMs: 4000 })
  const res1 = await localEngine.flush()
  assert.equal(res1.ok, true)
  const map1 = Object.fromEntries(localQ.snapshot.ancestor.nodes.map((n) => [n.id, n.text]))
  assert.equal(map1.a, 'A-local')
  assert.equal(map1.b, 'B-cloud')

  // Now a TRUE divergence on a FRESH document: two devices both branch from
  // v0 and edit the same node differently. Cloud commits first.
  const doc2 = 'e2e-2-conflict'
  await httpApi().ensureDoc(doc2, [{ id: 'a', kind: 'p', text: 'A' }])
  const { q: c2 } = await makeQueue(doc2, 'cloud2')
  const { q: l2 } = await makeQueue(doc2, 'local2')

  const cloudEdit2 = localOp('cloud2', { type: 'update', nodeId: 'a', content: { kind: 'p', text: 'A-cloud2' }, docId: doc2, baseVersion: 0 })
  await c2.appendLocalOps([cloudEdit2], [{ id: 'a', kind: 'p', text: 'A-cloud2' }])
  const cloudEng2 = new SyncEngine({ queue: c2, api: httpApi(), autoFlush: false, timeoutMs: 4000 })
  await cloudEng2.flush()
  assert.equal(c2.snapshot.serverVersion, 1)

  // local still believes v0 — stale baseline with a real content conflict.
  const conflictEdit = localOp('local2', {
    type: 'update', nodeId: 'a', content: { kind: 'p', text: 'A-conflict' }, docId: doc2, baseVersion: 0,
  })
  await l2.appendLocalOps([conflictEdit], [{ id: 'a', kind: 'p', text: 'A-conflict' }])

  let conflictContext = null
  const localEng2 = new SyncEngine({
    queue: l2,
    api: httpApi(),
    autoFlush: false,
    timeoutMs: 4000,
    resolveConflict: async (ctx) => {
      conflictContext = ctx
      const decisions = new Map()
      for (const c of ctx.conflicts) {
        decisions.set(c.id, { resolution: 'custom', content: { kind: 'p', text: 'HUMAN-MERGED' } })
      }
      return decisions
    },
  })
  await localEng2.flush()

  assert.ok(conflictContext, 'conflict context with 3 branches should be surfaced')
  assert.equal(conflictContext.ancestor[0].text, 'A')
  assert.equal(conflictContext.cloud.nodes[0].text, 'A-cloud2')
  assert.ok(conflictContext.device.nodes.some((n) => n.text === 'A-conflict'))
  assert.equal(conflictContext.conflicts[0].kind, 'update_update')

  const doc = await httpApi().getDoc(doc2)
  assert.equal(doc.nodes.find((n) => n.id === 'a').text, 'HUMAN-MERGED')

  // The recovery action is recorded and undoable.
  assert.ok(localEng2.recoveryStack.length >= 1)
  await localEng2.undoRecovery()
  assert.equal(l2.snapshot.nodes[0].text, 'A-conflict')
})

test('two tabs/devices share work: sequential edits converge; doc-lock mode rejects stale full doc', async () => {
  const docId = 'e2e-twotab'
  await httpApi().ensureDoc(docId, [{ id: 'p', kind: 'p', text: 'seed' }])

  async function tab(deviceId) {
    const kv = new MemoryKV()
    const q = new OperationQueue({ kv, bus: new MemoryBus(), docId, deviceId })
    await q.loadOrInit()
    return q
  }

  const tabA = await tab('tabA')
  const engA = new SyncEngine({ queue: tabA, api: httpApi(), autoFlush: false, timeoutMs: 4000 })
  const tabB = await tab('tabB')
  const engB = new SyncEngine({ queue: tabB, api: httpApi(), autoFlush: false, timeoutMs: 4000 })

  // Tab A appends a node while offline.
  const aOp = localOp('tabA', {
    type: 'insert', nodeId: 'a1', afterId: 'p',
    content: { kind: 'p', text: 'from tab A' }, docId, baseVersion: 0,
  })
  await tabA.appendLocalOps(aOp ? [aOp] : [], [
    { id: 'p', kind: 'p', text: 'seed' },
    { id: 'a1', kind: 'p', text: 'from tab A' },
  ])
  await engA.flush()
  assert.equal(tabA.snapshot.serverVersion, 1)

  // Simulate B picking up A's commit from the shared server before editing.
  const docAfterA = await httpApi().getDoc(docId)
  tabB.state.serverVersion = docAfterA.version
  tabB.state.nodes = docAfterA.nodes
  tabB.state.ancestor = { version: docAfterA.version, nodes: docAfterA.nodes }
  const bOp = localOp('tabB', {
    type: 'insert', nodeId: 'b1', afterId: 'a1',
    content: { kind: 'p', text: 'from tab B' }, docId, baseVersion: 1,
  })
  await tabB.appendLocalOps([bOp], [
    { id: 'p', kind: 'p', text: 'seed' },
    { id: 'a1', kind: 'p', text: 'from tab A' },
    { id: 'b1', kind: 'p', text: 'from tab B' },
  ])
  await engB.flush()

  const converged = await httpApi().getDoc(docId)
  assert.deepEqual(converged.nodes.map((n) => n.text), [
    'seed',
    'from tab A',
    'from tab B',
  ])

  // doc-lock mode: a stale full-document commit is rejected, not overwritten.
  const docEng = new SyncEngine({
    queue: tabB, api: httpApi(), autoFlush: false, timeoutMs: 4000, mode: 'doc',
    resolveConflict: async () => null,
  })
  // deliberately force a stale baseline and add an edit
  tabB.state.serverVersion = 0
  tabB.state.ancestor = { version: 0, nodes: [{ id: 'p', kind: 'p', text: 'seed' }] }
  const stale = localOp('tabB', {
    type: 'update', nodeId: 'p', content: { kind: 'p', text: 'stale whole doc' }, docId, baseVersion: 0,
  })
  await tabB.appendLocalOps([stale], [{ id: 'p', kind: 'p', text: 'stale whole doc' }])
  const outcome = await docEng.flush()
  assert.equal(outcome.deferred, true)
  // cloud untouched by the rejected stale write
  const still = await httpApi().getDoc(docId)
  assert.equal(still.nodes[0].text, 'seed')
})
