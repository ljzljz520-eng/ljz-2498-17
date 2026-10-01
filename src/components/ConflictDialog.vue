<script setup>
import { ref, computed, watch } from 'vue'
import { serializeBlocks } from '../core/blocks.js'

const props = defineProps({
  context: { type: Object, default: null },
})
const emit = defineEmits(['resolve', 'defer'])

const choices = ref({}) // conflictId -> 'local'|'remote'|'custom'
const customText = ref({}) // conflictId -> text

watch(
  () => props.context,
  (ctx) => {
    choices.value = {}
    customText.value = {}
    if (ctx) {
      for (const c of ctx.conflicts || []) {
        choices.value[c.id] = 'custom'
        if (c.wholeDocument) {
          customText.value[c.id] = serializeBlocks(ctx.device.nodes)
        } else {
          // prefill custom with the local text for easy manual reconciliation
          customText.value[c.id] = c.local.node
            ? c.local.node.text
            : c.remote.node
              ? c.remote.node.text
              : ''
        }
      }
    }
  },
  { immediate: true },
)

const isDocLock = computed(() =>
  (props.context?.conflicts || []).some((c) => c.wholeDocument),
)

function kindLabel(k) {
  return {
    update_update: '同一节点双方都修改',
    delete_update: '一方删除，另一方修改（结构冲突）',
    doc_lock: '文档级乐观锁：云端已有新稿，需整篇确认',
  }[k] || k
}

function confirm() {
  const decisions = new Map()
  for (const c of props.context.conflicts || []) {
    const choice = choices.value[c.id]
    if (choice === 'custom') {
      decisions.set(c.id, {
        resolution: 'custom',
        content: c.wholeDocument
          ? null
          : { kind: c.local.node?.kind || c.remote.node?.kind || 'paragraph', text: customText.value[c.id] },
        nodes: c.wholeDocument ? parseCustomDoc(customText.value[c.id]) : undefined,
      })
    } else {
      decisions.set(c.id, { resolution: choice })
    }
  }
  emit('resolve', decisions)
}

// doc-lock custom text is raw Catalpa; parse it into nodes on confirm.
function parseCustomDoc(text) {
  // Lazy import would be async; use exposed parser through window-free module.
  return parseSource(text)
}

import { parseBlocks } from '../core/blocks.js'
function parseSource(text) {
  return parseBlocks(text).map((b, idx) => ({ id: `custom_${idx}_${Math.random().toString(36).slice(2, 6)}`, ...b }))
}
</script>

<template>
  <div v-if="context" class="modal-backdrop">
    <div class="modal conflict-modal">
      <header>
        <h2>需要人工处理的合并冲突</h2>
        <p class="sub">
          基于共同祖先比较了<strong>本机分支</strong>与<strong>云端新稿</strong>
          （不是简单比较最后修改时间）。
        </p>
      </header>

      <div class="branches">
        <div class="branch ancestor">
          <h3>共同祖先 <span class="ver">v{{ context.ancestorVersion }}</span></h3>
          <pre>{{ serializeBlocks(context.ancestor) || '（空文档）' }}</pre>
        </div>
        <div class="branch device">
          <h3>本机分支 · {{ context.device.deviceId }}</h3>
          <pre>{{ serializeBlocks(context.device.nodes) }}</pre>
        </div>
        <div class="branch cloud">
          <h3>云端新稿 <span class="ver">v{{ context.cloud.version }}</span></h3>
          <pre>{{ serializeBlocks(context.cloud.nodes) }}</pre>
        </div>
      </div>

      <div class="conflict-list">
        <div v-for="c in context.conflicts" :key="c.id" class="conflict-item">
          <div class="conflict-head">
            <span class="tag">{{ kindLabel(c.kind) }}</span>
          </div>

          <template v-if="!c.wholeDocument">
            <div class="conflict-cols">
              <label :class="['opt', choices[c.id] === 'local' && 'on']">
                <input type="radio" v-model="choices[c.id]" :value="'local'" />
                <span>采用本机</span>
                <pre>{{ c.local.node ? c.local.node.text : '（本机删除了该节点）' }}</pre>
              </label>
              <label :class="['opt', choices[c.id] === 'remote' && 'on']">
                <input type="radio" v-model="choices[c.id]" :value="'remote'" />
                <span>采用云端</span>
                <pre>{{ c.remote.node ? c.remote.node.text : '（云端删除了该节点）' }}</pre>
              </label>
            </div>
            <label class="custom-row" :class="choices[c.id] === 'custom' && 'on'">
              <input type="radio" v-model="choices[c.id]" :value="'custom'" />
              <span>人工合并为：</span>
              <textarea v-model="customText[c.id]" rows="3" />
            </label>
          </template>

          <template v-else>
            <div class="conflict-cols">
              <label :class="['opt', choices[c.id] === 'local' && 'on']">
                <input type="radio" v-model="choices[c.id]" :value="'local'" />
                <span>整篇采用本机</span>
              </label>
              <label :class="['opt', choices[c.id] === 'remote' && 'on']">
                <input type="radio" v-model="choices[c.id]" :value="'remote'" />
                <span>整篇采用云端</span>
              </label>
            </div>
            <label class="custom-row" :class="choices[c.id] === 'custom' && 'on'">
              <input type="radio" v-model="choices[c.id]" :value="'custom'" />
              <span>在下方整稿人工合并：</span>
              <textarea v-model="customText[c.id]" rows="8" />
            </label>
          </template>
        </div>
      </div>

      <footer class="modal-actions">
        <button type="button" class="ghost" @click="emit('defer')">稍后处理（保留本机稿，不丢内容）</button>
        <button type="button" class="primary" @click="confirm">应用人工合并</button>
      </footer>
      <p class="undo-hint">合并（rebase）动作可在恢复面板中撤销。</p>
    </div>
  </div>
</template>
