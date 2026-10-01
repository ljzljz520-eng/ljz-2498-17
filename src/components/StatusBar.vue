<script setup>
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, default: 'idle' }, // idle|offline|syncing|local|received|saved|error|conflict
  serverVersion: { type: Number, default: 0 },
  pendingCount: { type: Number, default: 0 },
  pendingRanges: { type: Array, default: () => [] },
  checkpointName: { type: String, default: '' },
  lastMessage: { type: String, default: '' },
  mode: { type: String, default: 'nodes' },
})

defineEmits(['checkpoint', 'sync-now', 'undo-recovery', 'toggle-mode'])

const META = {
  idle: { label: '就绪', cls: 'idle' },
  upToDate: { label: '全部已保存', cls: 'saved' },
  offline: { label: '离线 · 已存本地', cls: 'local' },
  syncing: { label: '同步中…', cls: 'syncing' },
  local: { label: '仅本地保存', cls: 'local' },
  received: { label: '服务器已接收', cls: 'received' },
  saved: { label: '已形成保存点', cls: 'saved' },
  error: { label: '同步异常（编辑安全）', cls: 'error' },
  conflict: { label: '等待人工合并', cls: 'conflict' },
}

const meta = computed(() => META[props.status] || META.idle)

// Worst (least reliable) state across pending ranges drives the headline.
const headline = computed(() => {
  if (props.status === 'conflict') return META.conflict
  if (props.status === 'syncing') return META.syncing
  if (props.status === 'offline') return META.offline
  if (props.pendingCount === 0) return META.upToDate
  const hasLocal = props.pendingRanges.some((r) => r.state === 'local')
  return hasLocal ? META.local : META.received
})
</script>

<template>
  <div class="status-bar">
    <div class="status-left">
      <span class="dot" :class="headline.cls" />
      <strong>{{ headline.label }}</strong>
      <span class="version">云端版本 v{{ serverVersion }}</span>
      <span class="mode-pill" :class="mode" @click="$emit('toggle-mode')">
        {{ mode === 'doc' ? '文档级乐观锁' : '节点操作合并' }}
      </span>
    </div>

    <div class="status-center">
      <template v-if="pendingRanges.length">
        <span class="pending-hint">尚未可靠保存的范围：</span>
        <ul class="range-list">
          <li v-for="(r, i) in pendingRanges" :key="i" :class="r.state">
            {{ r.state === 'local' ? '仅本地' : '已接收未存点' }}
            · {{ r.blocks.length }} 段
          </li>
        </ul>
      </template>
      <span v-else-if="checkpointName" class="cp-hint">
        保存点「{{ checkpointName }}」之后无改动
      </span>
    </div>

    <div class="status-actions">
      <span v-if="lastMessage" class="last-msg">{{ lastMessage }}</span>
      <button type="button" class="mini" @click="$emit('sync-now')">立即同步</button>
      <button type="button" class="mini primary" @click="$emit('checkpoint')">
        建立保存点
      </button>
    </div>
  </div>
</template>
