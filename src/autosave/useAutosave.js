import { computed, reactive } from 'vue'
import { blocksFromText, diffBlocks, rebuildBlocks, textFromBlocks } from './blocks.js'
import { getDeviceId, hashString, opFingerprint } from './ids.js'
import {
  apiCreateCheckpoint,
  apiGetDocument,
  apiSubmitOperations,
  seedIdentityConflict,
  setMockMode,
  simulateCloudEdit,
  simulateServerReset,
} from './mockApi.js'
import { threeWayMerge, operationsToReach, applyResolutionChoice } from './merge.js'
import { DOC_ID, OP_STATUS, SCHEMA_VERSION } from './constants.js'
import {
  acquireWebLock,
  clearRebuildableCache,
  loadQueueState,
  normalizeState,
  saveQueueState,
} from './storage.js'

const FALLBACK_TEXT = `# Catalpa 自动保存演示\n\n离线首次打开时也会先写入本地操作队列。\n`
const DEVICE_LOCK = 'catalpa-device-lock'
const SYNC_LOCK = 'catalpa-sync-lock'
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('catalpa-autosave') : null

function nowIso() {
  return new Date().toISOString()
}

function notifyOtherTabs(reason) {
  channel?.postMessage({ reason, at: nowIso() })
}

function makeInitialState(deviceId, server) {
  const blocks = server?.blocks?.length ? server.blocks : blocksFromText(FALLBACK_TEXT)
  return normalizeState({
    docId: DOC_ID,
    deviceId,
    nextSeq: 1,
    baseVersion: server?.version ?? 0,
    ancestorBlocks: blocks,
    localBlocks: blocks,
    operations: [],
    checkpoints: server?.checkpoints ?? [],
  })
}

function decorateOperations(operations) {
  return operations.map((op) => ({
    ...op,
    status: op.status === OP_STATUS.IN_FLIGHT ? OP_STATUS.QUEUED : (op.status ?? OP_STATUS.QUEUED),
  }))
}

export function useAutosave() {
  const deviceId = getDeviceId()
  const loaded = loadQueueState()
  const state = reactive({
    ...makeInitialState(deviceId, null),
    ...(loaded || {}),
    operations: loaded ? decorateOperations(loaded.operations) : [],
  })

  const ui = reactive({
    ready: false,
    networkMode: sessionStorage.getItem('catalpa.networkMode') || 'online',
    syncing: false,
    lastError: '',
    quotaError: '',
    events: [],
    recoveryOpen: false,
    recovery: null,
    hardIdentityConflict: null,
    ackedThisSession: new Map(),
    lastRecoveryAudit: null,
  })
  let syncTimer = 0

  function logEvent(message, level = 'info') {
    ui.events.unshift({ id: `${Date.now()}-${Math.random()}`, at: nowIso(), message, level })
    ui.events = ui.events.slice(0, 30)
  }

  function persist(reason = 'state-change') {
    saveQueueState(state)
    notifyOtherTabs(reason)
  }

  async function mutate(reason, callback) {
    return acquireWebLock(DEVICE_LOCK, async () => {
      const result = await callback()
      persist(reason)
      return result
    })
  }

  function reloadFromStorage(reason) {
    const next = loadQueueState()
    if (!next) return
    Object.assign(state, normalizeState(next))
    state.operations = decorateOperations(next.operations || [])
    ui.hardIdentityConflict = null
    if (ui.recoveryOpen && reason === 'remote') {
      // Another tab may have resolved the same branch.
      ui.recoveryOpen = false
      ui.recovery = null
    }
  }

  window.addEventListener('storage', (event) => {
    if (event.key?.startsWith('catalpa.queue')) reloadFromStorage('remote')
  })
  channel?.addEventListener('message', () => reloadFromStorage('remote'))

  function scheduleSync(delay = 900) {
    clearTimeout(syncTimer)
    if (ui.networkMode !== 'online' || ui.recoveryOpen || ui.hardIdentityConflict) return
    syncTimer = window.setTimeout(() => syncNow(), delay)
  }

  window.addEventListener('online', () => {
    changeNetworkMode('online')
    syncNow()
  })

  async function init() {
    if (loaded) {
      logEvent(`已从本地恢复 v${loaded.schemaVersion} 操作队列，未确认操作 ${loaded.operations.length} 条`)
    }
    try {
      const server = await apiGetDocument()
      if (!loaded) {
        Object.assign(state, makeInitialState(deviceId, server))
        persist('initial-cloud-state')
      } else {
        state.checkpoints = server.checkpoints
        persist('checkpoints-refresh')
      }
      logEvent(`云端基线为 v${server.version}`)
    } catch (error) {
      if (!loaded) {
        Object.assign(state, makeInitialState(deviceId, null))
        try { persist('offline-initial-state') } catch { /* quota surfaced on edit */ }
      }
      logEvent(`离线重开：只展示本地共同祖先与未上传操作（${error.message}）`, 'warning')
    } finally {
      ui.ready = true
    }
  }

  const sourceText = computed(() => textFromBlocks(state.localBlocks))

  const pendingOperations = computed(() =>
    state.operations.filter((op) => op.status !== OP_STATUS.ACKED && op.status !== OP_STATUS.REJECTED))

  const unsavedRanges = computed(() => {
    const currentIndex = new Map(state.localBlocks.map((block, index) => [block.id, index + 1]))
    const lines = pendingOperations.value.map((op) => {
      if (currentIndex.has(op.nodeId)) return currentIndex.get(op.nodeId)
      return op.line ? `${op.line}*` : null
    }).filter(Boolean)
    const numeric = [...new Set(lines.filter((line) => Number.isInteger(line)))].sort((a, b) => a - b)
    const deleted = [...new Set(lines.filter((line) => typeof line === 'string'))]
    const groups = []
    for (const line of numeric) {
      const last = groups[groups.length - 1]
      if (last && line <= last.end + 1) last.end = Math.max(last.end, line)
      else groups.push({ start: line, end: line })
    }
    return { groups, deleted, count: pendingOperations.value.length }
  })

  const statusPill = computed(() => {
    if (ui.quotaError) return { tone: 'danger', text: OP_STATUS.QUOTA }
    if (ui.hardIdentityConflict || ui.recoveryOpen) return { tone: 'danger', text: OP_STATUS.CONFLICT }
    if (state.pendingCheckpoint) return { tone: 'warning', text: '保存点等待同步' }
    if (ui.syncing) return { tone: 'info', text: '正在同步…' }
    if (pendingOperations.value.length) return { tone: 'warning', text: OP_STATUS.LOCAL }
    if (state.lastAckedAt) return { tone: 'success', text: OP_STATUS.REMOTE }
    return { tone: 'muted', text: OP_STATUS.WAITING }
  })

  async function recordEdit(nextText, expectedBaseText = null) {
    let computedEdit
    return acquireWebLock(DEVICE_LOCK, async () => {
      // Re-read authoritative local blocks inside the lock. Another tab may
      // have committed an edit or recovery while the textarea was typing.
      const currentBlocks = state.localBlocks.map((block) => ({ ...block }))
      const currentText = textFromBlocks(currentBlocks)
      if (currentText === nextText) return true

      if (expectedBaseText !== null && expectedBaseText !== currentText) {
        const branch = diffBlocks(currentBlocks, nextText)
        return { conflict: true, serverText: currentText, branch }
      }

      computedEdit = diffBlocks(currentBlocks, nextText)
      if (!computedEdit.operations.length) {
        state.localBlocks = computedEdit.nextBlocks
        persist('local-edit-normalize')
        return true
      }
      try {
        for (const operation of computedEdit.operations) {
          state.nextSeq += 1
          state.operations.push({
            ...operation,
            id: `${deviceId}:${state.nextSeq}`,
            deviceId,
            seq: state.nextSeq,
            status: OP_STATUS.QUEUED,
            createdAt: nowIso(),
          })
        }
        state.localBlocks = computedEdit.nextBlocks
        ui.quotaError = ''
        ui.lastError = ''
        persist('local-edit')
        logEvent(`本地可靠保存 ${computedEdit.operations.length} 条节点操作；HTTP 尚未确认`)
        scheduleSync()
        return true
      } catch (error) {
        if (error.name === 'QuotaError') {
          ui.quotaError = '配额不足：已尝试清理可重建缓存，仍未能保存唯一未上传编辑'
          logEvent(ui.quotaError, 'danger')
        }
        return false
      }
    })
  }

  function replaceStateAfterRecovery({ remote, proposedBlocks, rebaseOperations, reason, oldOps, conflicts, preRecoveryBlocks }) {
    const undoOperations = operationsToReach(proposedBlocks, textFromBlocks(preRecoveryBlocks))
    state.baseVersion = remote.version
    state.ancestorBlocks = remote.blocks
    state.localBlocks = proposedBlocks
    state.operations = rebaseOperations.map((op, index) => ({
      ...op,
      id: `${deviceId}:${state.nextSeq + index + 1}`,
      deviceId,
      seq: state.nextSeq + index + 1,
      supersedes: oldOps.map((old) => old.id),
      status: OP_STATUS.QUEUED,
      createdAt: nowIso(),
    }))
    state.nextSeq += rebaseOperations.length
    state.branchAudit = {
      id: `recovery-${Date.now()}`,
      reason,
      createdAt: nowIso(),
      ancestorBeforeRecovery: state.ancestorBlocks,
      remoteBlocksAtRecovery: remote.blocks,
      resolvedBlocks: proposedBlocks,
      preRecoveryBlocks,
      undoOperations,
      oldOperations: oldOps,
      conflicts,
      undone: false,
    }
    ui.lastRecoveryAudit = state.branchAudit
  }

  async function reconcileAfterStale() {
    const remote = await apiGetDocument()
    const preRecoveryBlocks = state.localBlocks.map((block) => ({ ...block }))
    const received = new Map(remote.receivedOperations.map((op) => [`${op.deviceId}:${op.seq}`, op]))
    const oldOps = state.operations
    const acked = []
    const missing = []
    const hardConflicts = []

    for (const op of oldOps) {
      const remoteOp = received.get(`${op.deviceId}:${op.seq}`)
      if (!remoteOp) {
        missing.push(op)
      } else if (remoteOp.fingerprint === opFingerprint(op)) {
        acked.push({ op, remoteOp })
      } else {
        hardConflicts.push({ op, remoteOp })
      }
    }

    if (hardConflicts.length) {
      ui.hardIdentityConflict = {
        title: '操作身份冲突',
        message: '相同设备编号出现不同内容，拒绝用最后修改时间覆盖任何一方',
        items: hardConflicts,
      }
      logEvent('相同编号不同内容：409 OP_IDENTITY_CONFLICT', 'danger')
      return { reconciled: false }
    }

    const mergeResult = threeWayMerge(state.ancestorBlocks, state.localBlocks, remote.blocks, state.operations)
    mergeResult.ancestorBlocks = state.ancestorBlocks
    mergeResult.localBlocks = state.localBlocks
    mergeResult.remoteBlocks = remote.blocks
    mergeResult.acked = acked
    mergeResult.missing = missing
    mergeResult.remote = remote

    if (!missing.length && !mergeResult.conflicts.length) {
      state.baseVersion = remote.version
      state.ancestorBlocks = remote.blocks
      state.localBlocks = remote.blocks
      state.operations = []
      state.checkpoints = remote.checkpoints
      state.lastAckedAt = nowIso()
      acked.forEach(({ op, remoteOp }) => ui.ackedThisSession.set(op.id, remoteOp.version))
      logEvent(`回执丢失后重放：${acked.length} 条操作由幂等身份确认，未重复提交`)
      return { reconciled: true }
    }

    if (!mergeResult.conflicts.length) {
      const rebaseOperations = operationsToReach(remote.blocks, textFromBlocks(mergeResult.proposedBlocks))
      replaceStateAfterRecovery({
        remote,
        proposedBlocks: mergeResult.proposedBlocks,
        rebaseOperations,
        reason: acked.length ? 'partial-ack-timeout' : 'stale-baseline-rebase',
        oldOps: missing,
        conflicts: [],
        preRecoveryBlocks,
      })
      acked.forEach(({ op, remoteOp }) => ui.ackedThisSession.set(op.id, remoteOp.version))
      logEvent(acked.length
        ? `部分操作已接收，${missing.length} 条未确认操作已基于 v${remote.version} 变基`
        : `服务器拒绝过期基线，已自动完成无冲突三方合并，等待重新提交`)
      return { reconciled: true, needsSubmit: rebaseOperations.length > 0 }
    }

    ui.recovery = mergeResult
    ui.recoveryOpen = true
    logEvent(`检测到 ${mergeResult.conflicts.length} 个结构/内容冲突，等待人工选择`, 'warning')
    return { reconciled: false }
  }

  async function createServerCheckpoint() {
    if (!state.pendingCheckpoint) return true
    const response = await apiCreateCheckpoint({
      baseVersion: state.baseVersion,
      name: state.pendingCheckpoint.name,
    })
    if (!response.ok && response.status === 412) return false
    if (!response.ok) throw new Error(response.message || '保存点创建失败')
    state.baseVersion = response.serverVersion
    state.ancestorBlocks = state.localBlocks
    state.pendingCheckpoint = null
    state.lastAckedAt = nowIso()
    state.checkpoints = [...state.checkpoints, response.checkpoint]
    logEvent(`命名保存点「${response.checkpoint.name}」已形成：v${response.checkpoint.version}`)
    return true
  }

  async function syncNow() {
    if (ui.syncing) return
    return acquireWebLock(SYNC_LOCK, async () => {
      ui.syncing = true
      ui.lastError = ''
      try {
        for (let round = 0; round < 3; round += 1) {
          const queued = state.operations.filter((op) => op.status === OP_STATUS.QUEUED)
          if (!queued.length && !state.pendingCheckpoint && round === 0) {
            const remote = await apiGetDocument()
            if (remote.version !== state.baseVersion) {
              state.baseVersion = remote.version
              state.ancestorBlocks = remote.blocks
              state.localBlocks = remote.blocks
              state.checkpoints = remote.checkpoints
              logEvent(`已接收云端新稿 v${remote.version}；本地没有未确认分支，直接更新`)
            }
          }
          const queuedAfterPull = state.operations.filter((op) => op.status === OP_STATUS.QUEUED)
          if (queuedAfterPull.length) {
            const clientId = `${deviceId}-${Date.now()}`
            const response = await apiSubmitOperations({
              baseVersion: state.baseVersion,
              operations: queuedAfterPull,
              clientId,
            })

            if (response.status === 409) {
              ui.hardIdentityConflict = response
              logEvent(response.message, 'danger')
              return
            }

            if (response.status === 412) {
              const result = await reconcileAfterStale()
              if (!result.reconciled) return
              continue
            }

            if (!response.ok) throw new Error(response.message || '同步失败')

            const accepted = new Map(response.accepted.map((op) => [`${op.deviceId}:${op.seq}`, op]))
            state.operations = state.operations
              .filter((op) => accepted.has(`${op.deviceId}:${op.seq}`) || op.status !== OP_STATUS.QUEUED)
              .map((op) => accepted.get(`${op.deviceId}:${op.seq}`)
                ? { ...op, status: OP_STATUS.ACKED, serverVersion: accepted.get(`${op.deviceId}:${op.seq}`).version }
                : op)
            state.baseVersion = response.serverVersion
            state.ancestorBlocks = state.localBlocks
            state.lastAckedAt = nowIso()
            response.accepted.forEach((op) => ui.ackedThisSession.set(`${op.deviceId}:${op.seq}`, op.version))
            logEvent(`服务器接收 ${response.accepted.length} 条操作，当前 v${response.serverVersion}`)
            // Acknowledged operations are durable server-side; keep no local active queue.
            state.operations = []
          }

          const checkpointOk = await createServerCheckpoint()
          if (!checkpointOk) {
            const result = await reconcileAfterStale()
            if (!result.reconciled) return
            continue
          }
          break
        }
        persist('sync-complete')
      } catch (error) {
        if (error.code === 'TIMEOUT') {
          state.operations = state.operations.map((op) =>
            op.status === OP_STATUS.IN_FLIGHT ? { ...op, status: OP_STATUS.QUEUED } : op)
          ui.lastError = '超时只表示回执未知：操作保留原编号，稍后幂等重试；不会重建整稿。'
          logEvent(ui.lastError, 'warning')
          persist('timeout-unknown-commit')
        } else if (error.code === 'OFFLINE') {
          ui.lastError = '离线：编辑已在本地可靠保存，网络恢复后按原操作身份提交。'
          logEvent(ui.lastError, 'warning')
        } else {
          ui.lastError = error.message
          logEvent(error.message, 'danger')
        }
      } finally {
        ui.syncing = false
      }
    })
  }

  function markCheckpoint(name) {
    if (pendingOperations.value.length || state.pendingCheckpoint) {
      state.pendingCheckpoint = { id: `local-${Date.now()}`, name, createdAt: nowIso() }
      persist('local-checkpoint-request')
      logEvent(`保存点「${name}」先记录为本地意图，待操作上传后形成`)
    } else {
      state.pendingCheckpoint = { id: `local-${Date.now()}`, name, createdAt: nowIso() }
      persist('checkpoint-request')
    }
    syncNow()
  }

  function chooseRecovery(choices = {}, manualTexts = {}) {
    return mutate('manual-conflict-resolution', () => {
      const recovery = ui.recovery
      const chosenBlocks = applyResolutionChoice(recovery, choices, manualTexts)
      const rebaseOperations = operationsToReach(recovery.remote.blocks, textFromBlocks(chosenBlocks))
      replaceStateAfterRecovery({
        remote: recovery.remote,
        proposedBlocks: chosenBlocks,
        rebaseOperations,
        reason: 'manual-structure-resolution',
        oldOps: recovery.missing,
        conflicts: recovery.conflicts,
        preRecoveryBlocks: recovery.localBlocks,
      })
      ui.recoveryOpen = false
      ui.recovery = null
      logEvent('人工结构冲突处理已记录为可撤销恢复动作')
    }).then(() => syncNow())
  }

  function cancelRecovery() {
    ui.recoveryOpen = false
    logEvent('保留本地分支与云端新稿，稍后仍可重新打开恢复面板')
  }

  async function undoLastRecovery() {
    const audit = ui.lastRecoveryAudit || state.branchAudit
    if (!audit || audit.undone) return
    await mutate('undo-recovery', () => {
      // Reversal is a new conditional operation against the current server
      // branch. It does not rewrite history or resurrect an old baseline.
      state.localBlocks = audit.preRecoveryBlocks
      state.operations = audit.undoOperations.map((op, index) => ({
        ...op,
        id: `${deviceId}:${state.nextSeq + index + 1}`,
        deviceId,
        seq: state.nextSeq + index + 1,
        undoOfRecovery: audit.id,
        status: OP_STATUS.QUEUED,
        createdAt: nowIso(),
      }))
      state.nextSeq += audit.undoOperations.length
      audit.undone = true
      state.branchAudit = audit
      ui.recoveryOpen = false
      ui.recovery = null
      logEvent('已生成反向操作撤销恢复动作；仍需按当前版本条件提交')
    })
    return syncNow()
  }

  async function resolveHardIdentity(strategy) {
    const conflict = ui.hardIdentityConflict
    if (!conflict?.conflictingOperation && !conflict?.items?.length) return
    await mutate('resolve-identity-conflict', () => {
      const items = conflict.items || [{ op: state.operations.find((op) => op.id === conflict.conflictingOperation.id), remoteOp: conflict.conflictingOperation }]
      if (strategy === 'duplicate') {
        for (const { op } of items) {
          if (!op) continue
          state.nextSeq += 1
          state.operations.push({
            ...op,
            id: `${deviceId}:${state.nextSeq}`,
            seq: state.nextSeq,
            status: OP_STATUS.QUEUED,
            supersedes: op.id,
            createdAt: nowIso(),
          })
        }
        logEvent('已把本地意图复制为新操作身份；旧身份保留审计，不覆盖服务器')
      } else {
        state.operations = state.operations.filter((op) => !items.some((item) => item.op?.id === op.id))
        state.localBlocks = rebuildBlocks(state.ancestorBlocks, state.operations)
        logEvent('已丢弃冲突的本地操作并回到服务器已确认结构')
      }
      ui.hardIdentityConflict = null
    })
    return syncNow()
  }

  function changeNetworkMode(mode) {
    ui.networkMode = mode
    sessionStorage.setItem('catalpa.networkMode', mode)
    setMockMode(mode)
    logEvent(mode === 'offline' ? '已切换离线：本地队列继续可写' : `已切换 ${mode}`)
    if (mode === 'online') syncNow()
  }

  function simulateReceiptLoss() {
    sessionStorage.setItem('catalpa.mockControl', JSON.stringify({
      ...JSON.parse(sessionStorage.getItem('catalpa.mockControl') || '{}'),
      receiptLossOnce: true,
    }))
    logEvent('下一次提交将成功到达服务器但浏览器看到超时')
  }

  function cloudChange() {
    const version = simulateCloudEdit()
    logEvent(`另一设备已写入云端 v${version}；当前基线将被服务器拒绝并进入三方合并`)
  }

  function forceIdentityConflict() {
    seedIdentityConflict()
    logEvent('下一次提交将模拟“相同编号、不同内容指纹”')
  }

  function resetServerBaseline() {
    simulateServerReset()
    logEvent('服务器已重建为 v1，下一次过期高版本提交必须被拒绝', 'warning')
  }

  function fillRebuildableCache() {
    try {
      localStorage.setItem('catalpa.rebuildableCache.doc-1:pressure', 'x'.repeat(5_500_000))
      logEvent('已填充 5.5MB 可重建缓存；下次保存会先清它，不清未上传编辑')
    } catch (error) {
      logEvent(`无法制造配额压力：${error.message}`, 'warning')
    }
  }

  function applyLegacyMigration() {
    return mutate('format-migration', () => {
      const text = state.legacyDraftText
      const { operations, nextBlocks } = diffBlocks(state.localBlocks, text)
      for (const operation of operations) {
        state.nextSeq += 1
        state.operations.push({ ...operation, id: `${deviceId}:${state.nextSeq}`, deviceId, seq: state.nextSeq, status: OP_STATUS.QUEUED, createdAt: nowIso(), migratedFrom: state.migrationFromVersion })
      }
      state.localBlocks = nextBlocks
      state.needsFormatMigration = false
      state.legacyDraftText = null
      logEvent(`v${state.migrationFromVersion} 旧稿已升级为 v${SCHEMA_VERSION} 节点操作`)
      state.migrationFromVersion = null
    }).then(() => syncNow())
  }

  return {
    state,
    ui,
    deviceId,
    sourceText,
    pendingOperations,
    unsavedRanges,
    statusPill,
    init,
    recordEdit,
    syncNow,
    markCheckpoint,
    chooseRecovery,
    cancelRecovery,
    undoLastRecovery,
    resolveHardIdentity,
    changeNetworkMode,
    simulateReceiptLoss,
    cloudChange,
    forceIdentityConflict,
    resetServerBaseline,
    fillRebuildableCache,
    clearRebuildableCache,
    applyLegacyMigration,
  }
}
