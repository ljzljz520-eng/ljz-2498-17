<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import RecoveryPanel from './components/RecoveryPanel.vue'
import IdentityConflictModal from './components/IdentityConflictModal.vue'
import { diffBlocks, textFromBlocks } from './autosave/blocks.js'
import { useAutosave } from './autosave/useAutosave.js'
import { renderCatalpa } from './utils/catalpa.js'

const editor = ref(null)
const checkpointName = ref(`保存点 ${new Date().toLocaleString()}`)
const ephemeralText = ref(null)
const ephemeralReason = ref('')
const lastBaseText = ref(sourceText.value)
const editorFocused = ref(false)

const {
  state,
  ui,
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
} = useAutosave()

const effectiveText = computed(() => ephemeralText.value ?? sourceText.value)
watch(sourceText, (value) => {
  if (ephemeralText.value == null) lastBaseText.value = value
})
const previewHtml = computed(() => renderCatalpa(effectiveText.value))
const lineCount = computed(() => effectiveText.value.split(/\r?\n/).length)
const charCount = computed(() => effectiveText.value.length)
const unreliableRanges = computed(() => {
  if (ephemeralText.value == null) return { groups: [], deleted: [], count: 0 }
  const operations = diffBlocks(state.localBlocks, ephemeralText.value).operations
  const groups = []
  for (const line of operations.map((op) => op.range?.line).filter(Boolean).sort((a, b) => a - b)) {
    const last = groups[groups.length - 1]
    if (last && line <= last.end + 1) last.end = line
    else groups.push({ start: line, end: line })
  }
  return { groups, deleted: [], count: operations.length }
})
const rangeLabel = computed(() => {
  const reliable = unsavedRanges.value.groups.map((group) => group.start === group.end ? `第${group.start}行` : `第${group.start}-${group.end}行`)
  const deleted = unsavedRanges.value.deleted.map((line) => `原第${line.replace('*', '')}行`)
  const parts = [...reliable, ...deleted]
  if (!parts.length) return '无未确认范围'
  return `${parts.join('、')}（${unsavedRanges.value.count} 条操作未收讫）`
})

onMounted(init)

async function onInput(event) {
  const value = event.target.value
  const expected = ephemeralText.value == null ? lastBaseText.value : lastBaseText.value
  const saved = await recordEdit(value, expected)
  if (saved === true) {
    ephemeralText.value = null
    ephemeralReason.value = ''
    lastBaseText.value = value
  } else if (saved?.conflict) {
    ephemeralText.value = value
    ephemeralReason.value = '另一标签页或同步流程刚更新了权威队列；这段输入尚未可靠保存，请合并后重试。'
    lastBaseText.value = saved.serverText
  } else {
    ephemeralText.value = value
    ephemeralReason.value = '浏览器配额不足：输入未进入唯一操作队列。'
  }
  await nextTick()
}

async function retryEphemeral() {
  if (ephemeralText.value == null) return
  clearRebuildableCache()
  const saved = await recordEdit(ephemeralText.value, lastBaseText.value)
  if (saved === true) {
    const value = ephemeralText.value
    ephemeralText.value = null
    ephemeralReason.value = ''
    lastBaseText.value = value
  } else if (saved?.conflict) {
    ephemeralReason.value = '权威版本仍在变化；已保留这段输入，不会覆盖另一标签页编辑。'
    lastBaseText.value = saved.serverText
  }
}

function createCheckpoint() {
  markCheckpoint(checkpointName.value || `保存点 ${new Date().toLocaleString()}`)
}

function installLegacyDraft() {
  localStorage.setItem('catalpa.queue.doc-1', JSON.stringify({
    schemaVersion: 1,
    docId: 'doc-1',
    deviceId: localStorage.getItem('catalpa.deviceId'),
    draftText: '# v1 旧格式文稿\n\n这段内容以前只是整稿字符串，重新打开后必须升级成节点操作。\n',
  }))
  location.reload()
}

function openSecondTab() {
  window.open(window.location.href, '_blank', 'noopener')
}
</script>

<template>
  <div class="page">
    <header class="hero compact">
      <div>
        <p class="eyebrow">Vue 3 · 本地操作队列 · 条件版本提交</p>
        <h1>Catalpa 文稿自动保存</h1>
        <p class="subtitle">本地保存、服务器已接收、命名保存点三态分离；HTTP 超时不会重建整稿。</p>
      </div>
      <div class="status-stack">
        <span class="status-pill" :class="statusPill.tone">{{ statusPill.text }}</span>
        <span>共同祖先 v{{ state.baseVersion }}</span>
        <span>设备 {{ state.deviceId.slice(0, 13) }}…</span>
      </div>
    </header>

    <section v-if="state.needsFormatMigration" class="banner warning">
      <div>
        <strong>检测到 v{{ state.migrationFromVersion }} 格式：</strong>
        旧的整稿字符串不会直接覆盖云端，将转换为节点操作后作为本地分支提交。
      </div>
      <button class="primary-btn" @click="applyLegacyMigration">升级并进入合并</button>
    </section>

    <section v-if="ui.quotaError || ephemeralText !== null" class="banner danger">
      <div>
        <strong>以下范围尚未可靠保存：</strong>
        <template v-if="unreliableRanges.groups.length">
          {{ unreliableRanges.groups.map((g) => g.start === g.end ? `第${g.start}行` : `第${g.start}-${g.end}行`).join('、') }}
        </template>
        <template v-else>等待下一次输入或重试</template>
        。{{ ephemeralReason || ui.quotaError }} 已先清可重建缓存，但不会删除唯一未上传编辑。
      </div>
      <button class="ghost-btn" @click="retryEphemeral">重试写入队列</button>
    </section>

    <section v-if="ui.lastError" class="banner info">{{ ui.lastError }}</section>

    <main class="autosave-grid">
      <section class="panel editor-panel">
        <div class="panel-header">
          <div>
            <h2>编辑区</h2>
            <p class="range-text">尚未可靠保存范围：{{ rangeLabel }}</p>
          </div>
          <div class="actions">
            <button class="ghost-btn" :disabled="ui.syncing" @click="syncNow">立即同步</button>
          </div>
        </div>
        <textarea
          ref="editor"
          class="editor"
          :value="effectiveText"
          spellcheck="false"
          @input="onInput"
          @focus="editorFocused = true"
          @blur="editorFocused = false"
        />
      </section>

      <aside class="sidebar">
        <section class="side-card">
          <h3>保存状态</h3>
          <dl class="state-list">
            <dt>本地操作队列</dt>
            <dd :class="{ warning: pendingOperations.length }">{{ pendingOperations.length }} 条未确认</dd>
            <dt>服务器已接收</dt>
            <dd>{{ state.lastAckedAt ? new Date(state.lastAckedAt).toLocaleTimeString() : '本会话尚无收讫' }}</dd>
            <dt>命名保存点</dt>
            <dd>{{ state.pendingCheckpoint ? `等待：${state.pendingCheckpoint.name}` : `${state.checkpoints.length} 个` }}</dd>
          </dl>
          <div class="checkpoint-row">
            <input v-model="checkpointName" aria-label="保存点名称" />
            <button class="primary-btn" @click="createCheckpoint">创建保存点</button>
          </div>
        </section>

        <section class="side-card">
          <h3>网络与故障注入</h3>
          <div class="button-grid">
            <button :class="{ active: ui.networkMode === 'online' }" @click="changeNetworkMode('online')">在线</button>
            <button :class="{ active: ui.networkMode === 'offline' }" @click="changeNetworkMode('offline')">离线</button>
            <button :class="{ active: ui.networkMode === 'timeout' }" @click="changeNetworkMode('timeout')">持续超时</button>
            <button @click="simulateReceiptLoss">成功但回执丢失</button>
            <button @click="cloudChange">模拟云端新稿</button>
            <button @click="forceIdentityConflict">相同编号冲突</button>
            <button @click="resetServerBaseline">服务器拒绝过期基线</button>
            <button @click="fillRebuildableCache">制造配额压力</button>
            <button @click="installLegacyDraft">载入 v1 格式</button>
            <button @click="openSecondTab">打开第二个标签页</button>
          </div>
        </section>

        <section class="side-card">
          <h3>保存点</h3>
          <ul class="checkpoints">
            <li v-for="checkpoint in state.checkpoints.slice().reverse()" :key="checkpoint.id">
              <strong>{{ checkpoint.name }}</strong>
              <span>v{{ checkpoint.version }} · {{ new Date(checkpoint.createdAt).toLocaleTimeString() }}</span>
            </li>
            <li v-if="!state.checkpoints.length">尚无命名保存点</li>
          </ul>
        </section>

        <section class="side-card">
          <h3>操作审计</h3>
          <div class="audit-log">
            <p v-for="eventItem in ui.events" :key="eventItem.id" :class="eventItem.level">
              <time>{{ new Date(eventItem.at).toLocaleTimeString() }}</time>
              {{ eventItem.message }}
            </p>
          </div>
        </section>
      </aside>

      <section class="panel preview-panel wide">
        <div class="panel-header">
          <h2>预览区</h2>
          <div class="stats">
            <span>{{ lineCount }} 行</span>
            <span>{{ charCount }} 字符</span>
          </div>
        </div>
        <article class="preview markdown-body" v-html="previewHtml"></article>
      </section>
    </main>

    <RecoveryPanel
      v-if="ui.recoveryOpen && ui.recovery"
      :recovery="ui.recovery"
      @resolve="(payload) => chooseRecovery(payload.choices, payload.manualTexts)"
      @cancel="cancelRecovery"
    />
    <IdentityConflictModal
      v-if="ui.hardIdentityConflict"
      :conflict="ui.hardIdentityConflict"
      @resolve="resolveHardIdentity"
      @cancel="ui.hardIdentityConflict = null"
    />
    <button
      v-if="state.branchAudit && !state.branchAudit.undone"
      class="undo-fab"
      @click="undoLastRecovery"
    >撤销恢复动作</button>
  </div>
</template>
