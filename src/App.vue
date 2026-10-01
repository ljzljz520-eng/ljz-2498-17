<script setup>
import { ref, computed, reactive, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { renderCatalpa } from './utils/catalpa'
import { parseBlocks, serializeBlocks, assignIds, diffToOps } from './core/blocks.js'
import { createDefaultKV } from './core/storage.js'
import { createDefaultBus } from './core/bus.js'
import { createDefaultLeader } from './core/leader.js'
import { loadOrCreateDeviceId } from './core/device.js'
import { OperationQueue } from './core/queue.js'
import { SyncEngine } from './core/sync.js'
import { makeOpId } from './core/ops.js'
import { lineStates, pendingRanges } from './core/ranges.js'
import { api, faultControl } from './core/api.js'
import { FORMAT_VERSION, makeLegacyV1Queue } from './core/migration.js'
import StatusBar from './components/StatusBar.vue'
import ConflictDialog from './components/ConflictDialog.vue'
import RecoveryPanel from './components/RecoveryPanel.vue'

const DOC_ID = 'welcome-doc'

// ---- editor state ----------------------------------------------------------
const source = ref('')
const currentNodes = ref([])
const ready = ref(false)

// ---- services (created on mount so SSR-safe) -------------------------------
let queue
let sync
let leader
let kv
let bus
const deviceId = ref('')
// bumped whenever the durable queue changes so computed views re-derive
const stateTick = ref(0)
// latest authoritative cloud snapshot (for recovery three-view)
const latestCloud = ref({ version: 0, nodes: [] })

// ---- ui state --------------------------------------------------------------
const ui = reactive({
  status: 'idle',
  lastMessage: '',
  conflict: null,
  recoveryOpen: false,
  checkpoints: [],
  recoveryActions: [],
  mode: 'nodes',
  eventLog: [],
  fault: '',
  formatVersion: FORMAT_VERSION,
  migrated: false,
})

const serverVersion = computed(() => {
  void stateTick.value
  return queue?.snapshot.serverVersion ?? 0
})
const pendingCount = computed(() => {
  void stateTick.value
  return queue ? queue.pendingAckOps().length : 0
})
const checkpointName = computed(() => {
  void stateTick.value
  return queue?.snapshot.checkpoint?.name || ''
})

const opsForState = computed(() => {
  void stateTick.value
  return queue?.snapshot.ops || []
})

const lineState = computed(() => {
  // depend on the reactive bump so non-reactive queue mutations re-render
  void stateTick.value
  return lineStates(currentNodes.value, source.value, opsForState.value, {
    checkpointNodes: queue?.snapshot.checkpoint?.nodes || [],
    baselineNodes: queue?.snapshot.ancestor?.nodes || [],
  })
})
const ranges = computed(() => {
  void stateTick.value
  return pendingRanges(currentNodes.value, opsForState.value, {
    checkpointNodes: queue?.snapshot.checkpoint?.nodes || [],
    baselineNodes: queue?.snapshot.ancestor?.nodes || [],
  })
})

const previewHtml = computed(() => renderCatalpa(source.value))
const lineCount = computed(() => source.value.split(/\r?\n/).length)
const charCount = computed(() => source.value.length)

// ---- editing -> diff -> durable local queue --------------------------------
let editTimer = null
let lastSerialized = ''

function scheduleEdit() {
  clearTimeout(editTimer)
  editTimer = setTimeout(commitEdit, 300)
}

async function commitEdit() {
  if (!queue) return
  const newBlocks = parseBlocks(source.value)
  const serializedNow = serializeBlocks(newBlocks)
  if (serializedNow === lastSerialized) return
  lastSerialized = serializedNow

  const { ops, nodes } = diffToOps(
    currentNodes.value,
    newBlocks,
    (fields) => ({
      opId: makeOpId(deviceId.value),
      clientClock: Date.now(),
      ...fields,
    }),
  )
  currentNodes.value = nodes
  if (ops.length) {
    await queue.appendLocalOps(ops, nodes)
    ui.status = 'local'
    ui.lastMessage = `已写入本地操作队列（${ops.length} 项）`
    sync.requestFlush('edit')
  }
}

// keep the textarea source in sync if another tab / recovery changes nodes
function adoptNodes(nodes) {
  currentNodes.value = nodes
  const text = serializeBlocks(nodes)
  source.value = text
  lastSerialized = serializeBlocks(parseBlocks(text))
}

// ---- events ----------------------------------------------------------------
function logEvent(e) {
  stateTick.value += 1
  ui.eventLog.unshift({ type: e.type, at: new Date().toLocaleTimeString() })
  ui.eventLog = ui.eventLog.slice(0, 30)
  switch (e.type) {
    case 'syncing':
      ui.status = 'syncing'
      break
    case 'offline':
    case 'still-unreachable':
    case 'unknown-outcome':
      ui.status = 'offline'
      ui.lastMessage =
        e.type === 'unknown-outcome'
          ? '请求结果未知（可能已保存）。正在核对服务器，绝不重建整稿…'
          : '离线：编辑已安全存入本地队列'
      break
    case 'recovered-ack':
      ui.lastMessage = `回执丢失已恢复：确认 ${e.acks} 项操作此前已被服务器接收`
      break
    case 'nothing-landed':
      ui.lastMessage = '服务器未收到该操作，将以原操作身份重试'
      break
    case 'received':
      ui.status = 'received'
      latestCloud.value = {
        version: e.version,
        nodes: queue?.snapshot.ancestor?.nodes || [],
      }
      ui.lastMessage = e.merged
        ? `服务器已接收并自动合并 ${e.acks} 项（v${e.version}）`
        : `服务器已接收 ${e.acks} 项（v${e.version}）`
      break
    case 'up-to-date':
      ui.status = queue?.snapshot.checkpoint ? 'saved' : 'received'
      latestCloud.value = {
        version: e.version ?? serverVersion.value,
        nodes: queue?.snapshot.ancestor?.nodes || latestCloud.value.nodes,
      }
      ui.lastMessage = `已是最新（v${e.version ?? serverVersion.value}）`
      break
    case 'conflict-detected':
      ui.status = 'conflict'
      latestCloud.value = { version: e.cloud.version, nodes: e.cloud.nodes }
      ui.lastMessage = '检测到结构冲突，等待人工合并'
      break
    case 'rebased':
      ui.status = 'syncing'
      ui.lastMessage = `已 rebase 到云端基线（${e.newOps} 项新操作），该动作可撤销`
      ui.recoveryActions = [...(sync.recoveryStack || [])]
      break
    case 'checkpoint':
      ui.status = 'saved'
      ui.lastMessage = `已形成命名保存点「${e.name}」(v${e.version})`
      loadCheckpoints()
      break
    case 'quota-recovered':
      ui.lastMessage = '浏览器配额不足：已清理可重建缓存，未上传编辑完好保留'
      break
    case 'quota-fatal':
      ui.status = 'error'
      ui.lastMessage = '存储已满且无法通过清理缓存解决：未上传编辑保留在内存中，请勿关闭页面'
      break
    case 'external-update':
      // another tab wrote the shared queue
      if (queue && !queue.hasUnuploadedEdits()) {
        adoptNodes(queue.snapshot.nodes)
      }
      ui.lastMessage = '另一标签页更新了共享队列'
      break
    case 'migrated':
      ui.migrated = true
      ui.lastMessage = `本地队列已从格式 v${e.migratedFrom} 升级（${e.steps.join('→v')}）`
      break
    case 'flush-error':
      ui.status = 'error'
      ui.lastMessage = `同步异常：${e.message}（编辑安全，仍在本地）`
      break
  }
}

// ---- conflict resolution ---------------------------------------------------
function onResolve(decisions) {
  // Hand decisions back to the waiting sync engine.
  resolveResolver(decisions)
  ui.conflict = null
}
function onDefer() {
  resolveResolver(null)
  ui.conflict = null
  ui.lastMessage = '已暂缓合并：本机稿完整保留，可随时从恢复面板重新处理'
}
let resolveResolver = () => {}
function askConflict(ctx) {
  ui.conflict = ctx
  return new Promise((resolve) => {
    resolveResolver = resolve
  })
}

// ---- checkpoints / recovery ------------------------------------------------
async function loadCheckpoints() {
  try {
    const res = await api.listCheckpoints(DOC_ID)
    ui.checkpoints = res.checkpoints || []
  } catch {
    ui.checkpoints = []
  }
}

async function createSavePoint() {
  const name = `保存点 ${new Date().toLocaleString()}`
  try {
    await sync.checkpoint(name)
  } catch (err) {
    ui.lastMessage = `无法建立保存点：${err.message}`
  }
}

async function restoreCheckpoint(cp) {
  // Restoring is itself undoable-ish: it replaces current nodes and records a
  // local branch. Here we simply adopt the checkpoint as the document.
  adoptNodes(cp.nodes)
  await commitEdit()
  ui.recoveryOpen = false
  ui.lastMessage = `已恢复到保存点「${cp.name}」`
}

async function undoRecovery(action) {
  await sync.undoRecovery()
  adoptNodes(queue.snapshot.nodes)
  ui.recoveryActions = [...(sync.recoveryStack || [])]
  ui.lastMessage = '已撤销 rebase，恢复本机分支'
}

// ---- mode toggle -----------------------------------------------------------
function toggleMode() {
  ui.mode = ui.mode === 'nodes' ? 'doc' : 'nodes'
  sync.mode = ui.mode
  ui.lastMessage =
    ui.mode === 'doc'
      ? '已切换为文档级乐观锁：过期基线将要求整篇确认'
      : '已切换为节点操作合并：无冲突改动自动合并'
}

// ---- fault / dev tools (acceptance scenarios) ------------------------------
function setFault(kind) {
  ui.fault = kind
  faultControl.header = kind || null
  ui.lastMessage = kind
    ? `故障注入已开启：${kind === 'timeout' ? '提交后丢回执' : kind === 'delay' ? '高延迟' : '离线 503'}`
    : '故障注入已关闭'
}

async function simulateLegacyV1() {
  // Write a v1-format queue then reload to prove format upgrade on reopen.
  const legacy = makeLegacyV1Queue(DOC_ID)
  await kv.set(`queue:${DOC_ID}`, legacy)
  location.reload()
}

function forceQuota() {
  if (!queue) return
  queue.snapshot.caches = {
    big: 'X'.repeat(2_000_000),
    other: 'Y'.repeat(2_000_000),
  }
  queue
    .mutate(() => {}, { type: 'simulated-pressure' })
    .then(() => {
      ui.lastMessage = '配额压力模拟完成：缓存已清理，未上传编辑仍在'
    })
    .catch(() => {
      ui.lastMessage = '配额已满（模拟极端情况）：编辑保留，未被清除'
    })
}

// ---- gutter scroll sync ----------------------------------------------------
const textareaRef = ref(null)
const gutterRef = ref(null)
function syncScroll() {
  if (gutterRef.value && textareaRef.value) {
    gutterRef.value.scrollTop = textareaRef.value.scrollTop
  }
}

// ---- boot ------------------------------------------------------------------
onMounted(async () => {
  kv = createDefaultKV()
  bus = createDefaultBus()
  leader = createDefaultLeader()
  deviceId.value = await loadOrCreateDeviceId(kv)

  queue = new OperationQueue({
    kv,
    bus,
    docId: DOC_ID,
    deviceId: deviceId.value,
    mode: ui.mode,
  })
  queue.subscribe(logEvent)

  // Ensure server doc exists; seed first time.
  const initialBlocks = parseBlocks(initialDoc)
  const baselineNodes = assignIds(initialBlocks)
  let serverDoc = null
  try {
    serverDoc = await api.getDoc(DOC_ID)
  } catch {
    // network error or 404 — offline-first start is supported
  }

  await queue.loadOrInit({
    nodes: serverDoc?.nodes?.length ? serverDoc.nodes : baselineNodes,
    ancestor: {
      version: serverDoc?.version || 0,
      nodes: serverDoc?.nodes?.length ? serverDoc.nodes : baselineNodes,
    },
    serverVersion: serverDoc?.version || 0,
  })
  if (serverDoc) {
    latestCloud.value = { version: serverDoc.version, nodes: serverDoc.nodes }
  }

  if (!serverDoc) {
    try {
      // Seed the cloud with the SAME baseline nodes/ids the local queue used.
      await api.ensureDoc(DOC_ID, baselineNodes)
    } catch {
      /* offline first start is fine; sync will flush later */
    }
  } else if (!queue.snapshot.ops.length) {
    // Fresh local queue joining an existing cloud document.
    queue.state.serverVersion = serverDoc.version
    queue.state.nodes = serverDoc.nodes
    queue.state.ancestor = { version: serverDoc.version, nodes: serverDoc.nodes }
    await queue.setNodes(serverDoc.nodes)
  }

  // Build editor content from durable queue nodes (offline-reopen restores).
  adoptNodes(queue.snapshot.nodes.length ? queue.snapshot.nodes : baselineNodes)

  sync = new SyncEngine({
    queue,
    mode: ui.mode,
    resolveConflict: askConflict,
    onEvent: logEvent,
    autoFlush: true,
    intervalMs: 5000,
  })

  // Only the elected leader tab drives network sync; both tabs share queue.
  const isLeader = await leader.acquire()
  if (isLeader) {
    sync.start()
  } else {
    ui.lastMessage = '该标签页为从动副本：同步由另一标签页负责，队列共享'
  }

  loadCheckpoints()
  ready.value = true
})

onBeforeUnmount(() => {
  clearTimeout(editTimer)
  sync?.stop()
  leader?.release?.()
})

function resetToDemo() {
  source.value = initialDoc
  scheduleEdit()
}
function clearAll() {
  source.value = ''
  scheduleEdit()
}

const initialDoc = `# Catalpa 自动保存演示

在左侧编辑，内容会被切成**节点操作**写入本地持久队列。

## 三种状态
- 仅本地保存（尚未上传）
- 服务器已接收（有版本号，未成保存点）
- 命名保存点（可靠存档）

> HTTP 超时只代表结果未知，系统会核对服务器，绝不重建整稿。
`
</script>

<template>
  <div class="page" v-if="ready">
    <header class="hero">
      <div>
        <p class="eyebrow">Vue 3 · 操作队列 · 条件提交 · 三方合并</p>
        <h1>Catalpa 可靠自动保存</h1>
        <p class="subtitle">
          设备 {{ deviceId.slice(0, 10) }}… · 本地格式 v{{ ui.formatVersion }}
        </p>
      </div>
      <div class="stats">
        <span>{{ lineCount }} 行</span>
        <span>{{ charCount }} 字符</span>
        <span :class="['badge', pendingCount ? 'has-pending' : 'all-safe']">
          {{ pendingCount ? `${pendingCount} 项未确认` : '全部可靠' }}
        </span>
      </div>
    </header>

    <StatusBar
      :status="ui.status"
      :server-version="serverVersion"
      :pending-count="pendingCount"
      :pending-ranges="ranges"
      :checkpoint-name="checkpointName"
      :last-message="ui.lastMessage"
      :mode="ui.mode"
      @checkpoint="createSavePoint"
      @sync-now="sync?.flush('manual')"
      @undo-recovery="undoRecovery"
      @toggle-mode="toggleMode"
    />

    <main class="workspace">
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区</h2>
          <div class="legend">
            <span><i class="sw local" />仅本地</span>
            <span><i class="sw received" />已接收</span>
            <span><i class="sw saved" />已存点</span>
          </div>
          <div class="actions">
            <button class="ghost-btn" type="button" @click="ui.recoveryOpen = true">恢复 / 保存点</button>
            <button class="ghost-btn" type="button" @click="resetToDemo">恢复示例</button>
            <button class="ghost-btn danger" type="button" @click="clearAll">清空</button>
          </div>
        </div>
        <div class="editor-wrap">
          <div ref="gutterRef" class="gutter" aria-hidden="true">
            <div
              v-for="(s, idx) in lineState"
              :key="idx"
              class="gutter-line"
              :class="s || 'blank'"
            >
              <span class="lnum">{{ idx + 1 }}</span>
              <span class="bar" />
            </div>
          </div>
          <textarea
            ref="textareaRef"
            v-model="source"
            class="editor"
            placeholder="在这里输入 Catalpa 内容..."
            spellcheck="false"
            @input="scheduleEdit"
            @scroll="syncScroll"
          />
        </div>
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>预览区</h2>
        </div>
        <article class="preview markdown-body" v-html="previewHtml"></article>
      </section>
    </main>

    <section class="devtools">
      <div class="devtools-row">
        <strong>验收场景注入：</strong>
        <button type="button" :class="{ on: ui.fault === 'timeout' }" @click="setFault('timeout')">
          提交成功但回执丢失
        </button>
        <button type="button" :class="{ on: ui.fault === 'delay' }" @click="setFault('delay')">
          高延迟（客户端超时）
        </button>
        <button type="button" :class="{ on: ui.fault === 'offline' }" @click="setFault('offline')">
          离线 503
        </button>
        <button type="button" @click="setFault('')">关闭注入</button>
        <span class="sep" />
        <button type="button" @click="simulateLegacyV1">模拟 v1 旧格式并重开（升级）</button>
        <button type="button" @click="forceQuota">模拟浏览器配额不足</button>
        <button type="button" @click="sync?.flush('manual')">手动同步</button>
      </div>
      <div class="event-log">
        <span class="log-title">事件：</span>
        <span v-if="!ui.eventLog.length" class="log-empty">尚无</span>
        <span v-for="(e, i) in ui.eventLog.slice(0, 6)" :key="i" class="log-item">
          {{ e.at }} {{ e.type }}
        </span>
      </div>
    </section>

    <ConflictDialog :context="ui.conflict" @resolve="onResolve" @defer="onDefer" />
    <RecoveryPanel
      :open="ui.recoveryOpen"
      :checkpoints="ui.checkpoints"
      :recovery-actions="ui.recoveryActions"
      :ancestor="queue?.snapshot.ancestor"
      :cloud="latestCloud"
      :device-nodes="currentNodes"
      @close="ui.recoveryOpen = false"
      @restore-checkpoint="restoreCheckpoint"
      @undo="undoRecovery"
    />
  </div>
  <div v-else class="booting">正在加载本地操作队列…</div>
</template>
