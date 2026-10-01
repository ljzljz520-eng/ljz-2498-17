import { CONTROL_STORAGE_KEY, DOC_ID, SERVER_STORAGE_KEY } from './constants.js'
import { blocksFromText, textFromBlocks } from './blocks.js'
import { opFingerprint } from './ids.js'

const INITIAL_TEXT = `# Catalpa 自动保存演示

先在离线状态编辑，再恢复网络。操作会保留设备编号和内容指纹。

- 本地保存
- 服务器已接收
- 命名保存点
`

function readControl() {
  try {
    return JSON.parse(sessionStorage.getItem(CONTROL_STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function writeControl(control) {
  sessionStorage.setItem(CONTROL_STORAGE_KEY, JSON.stringify(control))
}

export function setMockMode(mode) {
  writeControl({ ...readControl(), mode })
}

export function seedIdentityConflict() {
  writeControl({ ...readControl(), identityConflict: true })
}

export function simulateServerReset() {
  localStorage.removeItem(SERVER_STORAGE_KEY)
}

function ensureServer() {
  const existing = localStorage.getItem(SERVER_STORAGE_KEY)
  if (existing) return JSON.parse(existing)
  const blocks = blocksFromText(INITIAL_TEXT)
  const server = {
    docId: DOC_ID,
    version: 1,
    blocks,
    receivedOperations: [],
    checkpoints: [{
      id: 'cp-server-seed',
      name: '初始基线',
      version: 1,
      createdAt: new Date().toISOString(),
      blocks,
    }],
    lastMutationAt: new Date().toISOString(),
  }
  saveServer(server)
  return server
}

function saveServer(server) {
  localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(server))
}

function delay(ms = 450) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function networkGate() {
  const { mode = 'online', receiptLossOnce = false } = readControl()
  await delay(receiptLossOnce ? 200 : 450)
  if (mode === 'offline') {
    const error = new Error('当前处于离线状态，服务器不可达')
    error.status = 0
    error.code = 'OFFLINE'
    throw error
  }
  if (mode === 'timeout' || receiptLossOnce) {
    if (receiptLossOnce) writeControl({ ...readControl(), receiptLossOnce: false })
    const error = new Error('HTTP 请求超时：不假定服务器未提交')
    error.status = 504
    error.code = 'TIMEOUT'
    throw error
  }
}

export async function apiGetDocument() {
  await networkGate()
  const server = ensureServer()
  return {
    docId: server.docId,
    version: server.version,
    blocks: server.blocks,
    text: textFromBlocks(server.blocks),
    checkpoints: server.checkpoints.map(({ blocks, ...summary }) => ({
      ...summary,
      lineCount: blocks.length,
    })),
    receivedOperations: server.receivedOperations.map(({ operation }) => ({
      id: operation.id,
      deviceId: operation.deviceId,
      seq: operation.seq,
      fingerprint: operation.fingerprint,
      version: operation.version,
      type: operation.type,
      nodeId: operation.nodeId,
    })),
  }
}

function serverApply(server, operation) {
  const map = new Map(server.blocks.map((block) => [block.id, { ...block }]))
  const order = server.blocks.map((block) => block.id)

  if (operation.type === 'insert_node') {
    if (map.has(operation.nodeId)) return
    map.set(operation.nodeId, { id: operation.nodeId, content: operation.content })
    const anchorIndex = operation.afterNodeId ? order.indexOf(operation.afterNodeId) : -1
    const beforeIndex = operation.beforeNodeId ? order.indexOf(operation.beforeNodeId) : -1
    if (anchorIndex >= 0) order.splice(anchorIndex + 1, 0, operation.nodeId)
    else if (beforeIndex >= 0) order.splice(beforeIndex, 0, operation.nodeId)
    else order.push(operation.nodeId)
  } else if (operation.type === 'update_node') {
    const block = map.get(operation.nodeId)
    if (!block) return
    block.content = operation.content
  } else if (operation.type === 'delete_node') {
    map.delete(operation.nodeId)
    const index = order.indexOf(operation.nodeId)
    if (index >= 0) order.splice(index, 1)
  }

  server.blocks = order.map((id) => map.get(id)).filter(Boolean)
}

export async function apiSubmitOperations({ baseVersion, operations, clientId }) {
  const initialControl = readControl()
  if (initialControl.receiptLossOnce) {
    // Fault injection: the server commits the exact idempotent operation batch,
    // persists it, then the response is lost as a client-visible timeout.
    writeControl({ ...initialControl, receiptLossOnce: false })
    await delay(200)
    const committed = await apiSubmitOperations({ baseVersion, operations, clientId })
    if (committed.ok) {
      const error = new Error('服务器已提交，但 HTTP 回执丢失；保留原操作身份稍后幂等重放')
      error.status = 504
      error.code = 'TIMEOUT'
      throw error
    }
    return committed
  }

  await networkGate()
  const control = readControl()
  const server = ensureServer()

  if (baseVersion !== server.version) {
    return {
      ok: false,
      status: 412,
      code: 'STALE_BASELINE',
      message: '基线版本已过期，请先三方合并',
      serverVersion: server.version,
      clientId,
    }
  }

  const accepted = []
  for (const operation of operations) {
    const fingerprint = opFingerprint(operation)
    const duplicate = server.receivedOperations.find((item) =>
      item.operation.deviceId === operation.deviceId && item.operation.seq === operation.seq)

    if (duplicate) {
      if (duplicate.operation.fingerprint !== fingerprint) {
        return {
          ok: false,
          status: 409,
          code: 'OP_IDENTITY_CONFLICT',
          message: `相同操作编号 ${operation.deviceId}:${operation.seq} 的内容不同`,
          serverVersion: server.version,
          conflictingOperation: {
            id: operation.id,
            deviceId: operation.deviceId,
            seq: operation.seq,
            localFingerprint: fingerprint,
            serverFingerprint: duplicate.operation.fingerprint,
          },
          clientId,
        }
      }
      accepted.push({ ...operation, version: duplicate.operation.version })
      continue
    }

    if (control.identityConflict && accepted.length === 0) {
      const fakeServerFingerprint = `${fingerprint}-tampered`
      // Record the same identity with a different hash once, then remove the switch.
      server.receivedOperations.push({
        operation: { ...operation, fingerprint: fakeServerFingerprint, version: server.version },
        receivedAt: new Date().toISOString(),
      })
      control.identityConflict = false
      writeControl(control)
      saveServer(server)
      return {
        ok: false,
        status: 409,
        code: 'OP_IDENTITY_CONFLICT',
        message: `相同操作编号 ${operation.deviceId}:${operation.seq} 的内容不同`,
        serverVersion: server.version,
        conflictingOperation: {
          id: operation.id,
          deviceId: operation.deviceId,
          seq: operation.seq,
          localFingerprint: fingerprint,
          serverFingerprint: fakeServerFingerprint,
        },
        clientId,
      }
    }

    server.version += 1
    serverApply(server, operation)
    const stored = {
      ...operation,
      fingerprint,
      version: server.version,
      clientId,
    }
    server.receivedOperations.push({ operation: stored, receivedAt: new Date().toISOString() })
    accepted.push(stored)
  }

  server.lastMutationAt = new Date().toISOString()
  saveServer(server)

  return {
    ok: true,
    serverVersion: server.version,
    accepted: accepted.map((op) => ({
      id: op.id,
      deviceId: op.deviceId,
      seq: op.seq,
      fingerprint: op.fingerprint,
      version: op.version,
    })),
    clientId,
  }
}

export async function apiCreateCheckpoint({ baseVersion, name }) {
  await networkGate()
  const server = ensureServer()
  if (baseVersion !== server.version) {
    return {
      ok: false,
      status: 412,
      code: 'STALE_BASELINE',
      serverVersion: server.version,
      message: '保存点基线已过期',
    }
  }
  server.version += 1
  const checkpoint = {
    id: `cp-${server.version}-${Date.now().toString(36)}`,
    name,
    version: server.version,
    createdAt: new Date().toISOString(),
    blocks: server.blocks,
  }
  server.checkpoints.push(checkpoint)
  saveServer(server)
  return {
    ok: true,
    serverVersion: server.version,
    checkpoint: { id: checkpoint.id, name: checkpoint.name, version: checkpoint.version, createdAt: checkpoint.createdAt },
  }
}

/** Test hook: another device edits cloud without telling this tab. */
export function simulateCloudEdit(text = `# 云端新稿 ${new Date().toLocaleTimeString()}\n\n这是另一台设备在服务器直接形成的新版本。\n\n- 本地旧编辑需要三方合并\n- 不能仅比较最后修改时间\n`) {
  const server = ensureServer()
  server.version += 1
  server.blocks = blocksFromText(text)
  server.lastMutationAt = new Date().toISOString()
  saveServer(server)
  return server.version
}
