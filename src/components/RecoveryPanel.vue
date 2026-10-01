<script setup>
import { computed } from 'vue'
import { serializeBlocks } from '../core/blocks.js'

const props = defineProps({
  open: Boolean,
  checkpoints: { type: Array, default: () => [] },
  recoveryActions: { type: Array, default: () => [] },
  ancestor: { type: Object, default: null },
  cloud: { type: Object, default: null },
  deviceNodes: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'restore-checkpoint', 'undo'])

const lastRecovery = computed(() =>
  props.recoveryActions.length ? props.recoveryActions[props.recoveryActions.length - 1] : null,
)

function fmt(ts) {
  return new Date(ts).toLocaleTimeString()
}
</script>

<template>
  <div v-if="open" class="modal-backdrop">
    <div class="modal recovery-modal">
      <header>
        <h2>恢复与保存点</h2>
        <p class="sub">命名保存点是可靠的版本锚点；合并/恢复动作都可撤销。</p>
      </header>

      <section v-if="ancestor && cloud" class="three-view">
        <h3>三方对照</h3>
        <div class="branches">
          <div class="branch ancestor">
            <h4>共同祖先 v{{ ancestor.version }}</h4>
            <pre>{{ serializeBlocks(ancestor.nodes || []) || '（空）' }}</pre>
          </div>
          <div class="branch device">
            <h4>本机分支</h4>
            <pre>{{ serializeBlocks(deviceNodes) || '（空）' }}</pre>
          </div>
          <div class="branch cloud">
            <h4>云端新稿 v{{ cloud.version }}</h4>
            <pre>{{ serializeBlocks(cloud.nodes || []) || '（空）' }}</pre>
          </div>
        </div>
      </section>

      <section class="cp-section">
        <h3>命名保存点</h3>
        <p v-if="!checkpoints.length" class="empty">还没有保存点。同步成功后点击“建立保存点”。</p>
        <ul v-else class="cp-list">
          <li v-for="cp in checkpoints" :key="cp.name">
            <div>
              <strong>{{ cp.name }}</strong>
              <span class="ver">v{{ cp.version }}</span>
              <span class="time">{{ fmt(cp.createdAt) }}</span>
            </div>
            <button type="button" class="mini" @click="emit('restore-checkpoint', cp)">恢复此版本</button>
          </li>
        </ul>
      </section>

      <section class="undo-section">
        <h3>可撤销的恢复动作</h3>
        <p v-if="!lastRecovery" class="empty">暂无。</p>
        <div v-else class="undo-row">
          <span>rebase 到云端版本 v{{ lastRecovery.prevServerVersion }} 之后的合并（{{ lastRecovery.stamped?.length || 0 }} 个新操作）</span>
          <button type="button" class="mini warn" @click="emit('undo', lastRecovery)">撤销该合并</button>
        </div>
      </section>

      <footer class="modal-actions">
        <button type="button" class="ghost" @click="emit('close')">关闭</button>
      </footer>
    </div>
  </div>
</template>
