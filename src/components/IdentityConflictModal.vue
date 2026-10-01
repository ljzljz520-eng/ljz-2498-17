<script setup>
defineProps({ conflict: { type: Object, required: true } })
const emit = defineEmits(['resolve', 'cancel'])
</script>

<template>
  <div class="modal-backdrop">
    <section class="recovery-modal small">
      <header>
        <div>
          <p class="eyebrow danger-text">409 Operation Identity Conflict</p>
          <h3>{{ conflict.message || conflict.conflictingOperation?.message || '相同编号不同内容' }}</h3>
        </div>
      </header>
      <pre class="conflict-json">{{ JSON.stringify(conflict.conflictingOperation || conflict.items?.[0] || conflict, null, 2) }}</pre>
      <p class="hint">不能覆盖已接收操作，也不能重建整稿。可复制为新操作身份，或丢弃本地冲突意图。</p>
      <footer>
        <button class="ghost-btn" @click="emit('cancel')">暂不处理</button>
        <button class="ghost-btn danger" @click="emit('resolve', 'drop')">丢弃本地冲突操作</button>
        <button class="primary-btn" @click="emit('resolve', 'duplicate')">复制为新编号后提交</button>
      </footer>
    </section>
  </div>
</template>
