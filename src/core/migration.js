// Queue/schema format versioning and upgrades.
//
// FORMAT_VERSION history:
//   1 — earliest: nodes were plain {id,text} (kind inferred from text);
//       ops had no `fingerprint` and no `baseVersion`.
//   2 — nodes carry explicit `kind`; ops carry `fingerprint`+`baseVersion`.
//   3 — queue stores `mode` ('nodes'|'doc'), checkpoint metadata and
//       content hash; ops reference `schema`.
//
// Migrations are pure functions over a parsed queue object so they are
// trivially testable and reversible in the UI before they are committed.

import { contentHash } from './hash.js'
import { fingerprint } from './ops.js'
import { classifyLine } from './blocks.js'

export const FORMAT_VERSION = 3

export function inferKind(text) {
  const first = String(text || '').split('\n')[0]
  const kind = classifyLine(first)
  if (kind === 'fence') return 'code'
  return kind === 'hr' ? 'hr' : kind
}

export function migrateQueue(queue) {
  const steps = []
  let data = structuredCloneSafe(queue)
  const from = data.formatVersion || 1

  if (from === 1) {
    steps.push(1)
    data = fromV1(data)
  }
  if (data.formatVersion === 2) {
    steps.push(2)
    data = fromV2(data)
  }

  data.formatVersion = FORMAT_VERSION
  return { queue: data, migratedFrom: from, steps }
}

function fromV1(data) {
  const nodes = (data.nodes || []).map((n) => ({
    id: n.id,
    kind: n.kind || inferKind(n.text),
    text: n.text,
  }))
  const ops = (data.ops || []).map((op) => {
    const next = { ...op }
    if (op.type === 'insert' || op.type === 'update') {
      next.content = op.content || {
        kind: inferKind(op.text || (nodes.find((n) => n.id === op.nodeId) || {}).text),
        text: op.text ?? (nodes.find((n) => n.id === op.nodeId) || {}).text ?? '',
      }
      next.content = {
        kind: next.content.kind || inferKind(next.content.text),
        text: next.content.text,
      }
    }
    next.baseVersion = next.baseVersion ?? data.serverVersion ?? 0
    next.fingerprint = fingerprint(next)
    return next
  })
  return { ...data, nodes, ops, formatVersion: 2 }
}

function fromV2(data) {
  const ops = (data.ops || []).map((op) => ({
    ...op,
    schema: 3,
    fingerprint: op.fingerprint || fingerprint(op),
  }))
  const checkpoint = data.checkpoint
    ? {
        ...data.checkpoint,
        contentHash: data.checkpoint.contentHash || contentHash(JSON.stringify(data.checkpoint.nodes || [])),
      }
    : data.checkpoint
  return {
    ...data,
    ops,
    checkpoint,
    mode: data.mode || 'nodes',
    formatVersion: 3,
  }
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

// A generator of legacy v1 sample queues, used by tests and the dev panel.
export function makeLegacyV1Queue(docId) {
  return {
    formatVersion: 1,
    docId,
    deviceId: 'legacy_device',
    serverVersion: 0,
    nodes: [
      { id: 'n_old_1', text: '# 旧版本文档' },
      { id: 'n_old_2', text: '这是 v1 队列里的内容，没有 kind。' },
    ],
    ops: [
      {
        opId: 'op_old_1',
        docId,
        type: 'insert',
        nodeId: 'n_old_1',
        afterId: null,
        text: '# 旧版本文档',
        clientClock: 1,
        deviceId: 'legacy_device',
        status: 'saved',
      },
      {
        opId: 'op_old_2',
        docId,
        type: 'insert',
        nodeId: 'n_old_2',
        afterId: 'n_old_1',
        text: '这是 v1 队列里的内容，没有 kind。',
        clientClock: 2,
        deviceId: 'legacy_device',
        status: 'local',
      },
    ],
  }
}
