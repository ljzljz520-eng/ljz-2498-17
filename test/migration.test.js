import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateQueue, makeLegacyV1Queue, FORMAT_VERSION } from '../src/core/migration.js'
import { fingerprint } from '../src/core/ops.js'

test('v1 queue (no kind, no fingerprint) upgrades all the way to current', () => {
  const legacy = makeLegacyV1Queue('doc')
  const { queue, migratedFrom, steps } = migrateQueue(legacy)
  assert.equal(migratedFrom, 1)
  assert.deepEqual(steps, [1, 2])
  assert.equal(queue.formatVersion, FORMAT_VERSION)
  // explicit kinds inferred
  assert.equal(queue.nodes[0].kind, 'heading')
  assert.equal(queue.nodes[1].kind, 'paragraph')
  // fingerprints + baseVersion stamped
  for (const op of queue.ops) {
    assert.ok(op.fingerprint)
    assert.equal(op.fingerprint, fingerprint(op))
    assert.equal(typeof op.baseVersion, 'number')
  }
  // content survived the upgrade
  assert.equal(queue.ops[1].content.text, '这是 v1 队列里的内容，没有 kind。')
})

test('already-current queue is a no-op', () => {
  const current = { formatVersion: FORMAT_VERSION, docId: 'x', ops: [], nodes: [] }
  const { steps, queue } = migrateQueue(current)
  assert.deepEqual(steps, [])
  assert.equal(queue.formatVersion, FORMAT_VERSION)
})

test('migration is pure (does not mutate input)', () => {
  const legacy = makeLegacyV1Queue('doc')
  const snapshot = JSON.stringify(legacy)
  migrateQueue(legacy)
  assert.equal(JSON.stringify(legacy), snapshot)
})
