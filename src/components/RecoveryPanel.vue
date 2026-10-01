<script setup>
import { computed, reactive, watch } from 'vue'
import { textFromBlocks } from '../autosave/blocks.js'

const props = defineProps({
  recovery: { type: Object, required: true },
})
const emit = defineEmits(['resolve', 'cancel'])

const choices = reactive({})
const manualTexts = reactive({})

watch(() => props.recovery, (recovery) => {
  for (const key of Object.keys(choices)) delete choices[key]
  for (const key of Object.keys(manualTexts)) delete manualTexts[key]
  for (const conflict of recovery.conflicts) {
    choices[conflict.id] = conflict.type === 'structure' ? 'local' : 'local'
    manualTexts[conflict.id] = [conflict.local, conflict.remote].filter(Boolean).join('\n')
  }
}, { immediate: true })

const ancestorText = computed(() => textFromBlocks(props.recovery.ancestorBlocks))
const localText = computed(() => textFromBlocks(props.recovery.localBlocks))
const remoteText = computed(() => textFromBlocks(props.recovery.remoteBlocks))
</script>

<template>
  <div class="modal-backdrop" role="dialog" aria-modal="true">
    <section class="recovery-modal">
      <header>
        <div>
          <p class="eyebrow">三方恢复</p>
          <h3>共同祖先 / 设备分支 / 云端新稿</h3>
          <p class="hint">按节点拓扑合并；不是比较最后修改时间。结构冲突必须人工确认。</p>
        </div>
        <button type="button" class="ghost-btn" @click="emit('cancel')">稍后处理</button>
      </header>

      <div class="three-columns">
        <article>
          <h4>共同祖先</h4>
          <pre>{{ ancestorText }}</pre>
        </article>
        <article>
          <h4>本设备分支</h4>
          <pre>{{ localText }}</pre>
        </article>
        <article>
          <h4>云端新稿 v{{ recovery.remote.version }}</h4>
          <pre>{{ remoteText }}</pre>
        </article>
      </div>

      <div class="conflict-list">
        <h4>人工处理（{{ recovery.conflicts.length }}）</h4>
        <div v-for="conflict in recovery.conflicts" :key="conflict.id" class="conflict-card">
          <div class="conflict-title">
            <strong>{{ conflict.title }}</strong>
            <span class="badge" :class="conflict.type">{{ conflict.type === 'structure' ? '结构冲突' : '内容冲突' }}</span>
          </div>
          <div class="conflict-choice">
            <label><input v-model="choices[conflict.id]" type="radio" value="local" /> 保留本设备</label>
            <label><input v-model="choices[conflict.id]" type="radio" value="remote" /> 采用云端</label>
            <label><input v-model="choices[conflict.id]" type="radio" value="manual" /> 手工编辑</label>
          </div>
          <textarea
            v-if="choices[conflict.id] === 'manual'"
            v-model="manualTexts[conflict.id]"
            rows="5"
          />
        </div>
      </div>

      <footer>
        <p>提交时会生成新的变基操作并保留 supersedes 审计；本次恢复之后可一键撤销。</p>
        <button type="button" class="primary-btn" @click="emit('resolve', { choices, manualTexts })">
          接受合并并重新提交
        </button>
      </footer>
    </section>
  </div>
</template>
