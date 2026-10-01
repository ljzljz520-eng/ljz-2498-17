import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileRepository } from '../server/file-repo.js'
import { createServer } from '../server/http.js'
import { withFingerprint, makeOpId } from '../src/core/ops.js'

let server
let baseUrl

function op(dev, fields) {
  return withFingerprint({
    opId: makeOpId(dev),
    docId: 'd',
    baseVersion: 0,
    clientClock: Date.now(),
    deviceId: dev,
    ...fields,
  })
}

test.before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'catalpa-http-'))
  const created = createServer({ repo: new FileRepository(dir) })
  server = created.server
  await new Promise((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/api`
})

test.after(async () => {
  await new Promise((r) => server.close(r))
})

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const payload = await res.json().catch(() => null)
  return { status: res.status, payload }
}

async function getJson(url) {
  const res = await fetch(url)
  return { status: res.status, payload: await res.json() }
}

test('X-Fault: timeout destroys socket AFTER commit; retry recovers the ack', async () => {
  const docId = 'timeout-doc'
  await postJson(`${baseUrl}/docs/${docId}`, { nodes: [] })
  const o = op('dev', { type: 'insert', nodeId: 'n1', afterId: null, content: { kind: 'p', text: 'committed-but-ack-lost' } })

  // First attempt: server commits then kills the socket.
  let networkError = null
  try {
    await fetch(`${baseUrl}/docs/${docId}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fault': 'timeout' },
      body: JSON.stringify({ ops: [o], baseVersion: 0 }),
    })
  } catch (err) {
    networkError = err
  }
  assert.ok(networkError, 'socket destruction should surface as a network error')

  // The edit MUST be on the server despite the lost response.
  const opsList = await getJson(`${baseUrl}/docs/${docId}/ops`)
  assert.equal(opsList.payload.ops.length, 1)
  assert.equal(opsList.payload.ops[0].opId, o.opId)

  // Retry with SAME identity returns the ack, no duplicate, no rebuild.
  const retry = await postJson(`${baseUrl}/docs/${docId}/sync`, { ops: [o], baseVersion: 0 })
  assert.equal(retry.status, 200)
  assert.equal(retry.payload.acks.length, 1)
  assert.equal(retry.payload.acks[0].opId, o.opId)
  const after = await getJson(`${baseUrl}/docs/${docId}/ops`)
  assert.equal(after.payload.ops.length, 1)
})

test('X-Fault: offline returns 503 and edits are not lost client-side', async () => {
  const docId = 'offline-doc'
  await postJson(`${baseUrl}/docs/${docId}`, { nodes: [] })
  const res = await postJson(
    `${baseUrl}/docs/${docId}/sync`,
    { ops: [op('dev', { type: 'insert', nodeId: 'z', afterId: null, content: { kind: 'p', text: 'x' } })], baseVersion: 0 },
    { 'x-fault': 'offline' },
  )
  assert.equal(res.status, 503)
  assert.equal(res.payload.error.code, 'OFFLINE')
})

test('server rejects stale baseline with 409 naming server version and ancestor', async () => {
  const docId = 'stale-doc'
  await postJson(`${baseUrl}/docs/${docId}`, {
    nodes: [{ id: 'a', kind: 'p', text: 'A' }],
  })
  await postJson(`${baseUrl}/docs/${docId}/sync`, {
    ops: [op('cloud', { type: 'update', nodeId: 'a', content: { kind: 'p', text: 'cloud' } })],
    baseVersion: 0,
  })
  const res = await postJson(`${baseUrl}/docs/${docId}/sync`, {
    ops: [op('dev', { type: 'update', nodeId: 'a', content: { kind: 'p', text: 'local' } })],
    baseVersion: 0,
  })
  assert.equal(res.status, 409)
  assert.equal(res.payload.error.code, 'STALE_BASELINE')
  assert.equal(res.payload.error.serverVersion, 1)
  assert.equal(res.payload.error.baseVersion, 0)
  assert.ok(Array.isArray(res.payload.error.ancestor.nodes))
  assert.equal(res.payload.error.cloud.nodes[0].text, 'cloud')
})

test('checkpoint endpoint creates a named save point', async () => {
  const docId = 'cp-doc'
  await postJson(`${baseUrl}/docs/${docId}`, { nodes: [] })
  await postJson(`${baseUrl}/docs/${docId}/sync`, {
    ops: [op('dev', { type: 'insert', nodeId: 'a', afterId: null, content: { kind: 'p', text: 'milestone' } })],
    baseVersion: 0,
  })
  const cp = await postJson(`${baseUrl}/docs/${docId}/checkpoints`, { name: 'release' })
  assert.equal(cp.status, 200)
  assert.equal(cp.payload.name, 'release')
  const list = await getJson(`${baseUrl}/docs/${docId}/checkpoints`)
  assert.equal(list.payload.checkpoints[0].name, 'release')
})
