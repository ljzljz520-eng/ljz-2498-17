<script setup>
import { computed, ref } from 'vue'
import { renderCatalpa } from './utils/catalpa'

const initialDoc = `# Catalpa 编辑器

欢迎使用 **Catalpa 实时预览**。

## 基础语法
- 支持标题、列表、引用
- 支持 *斜体* 与 **粗体**
- 支持 [链接](https://vuejs.org/)

> 右侧预览会跟随左侧编辑器实时更新。

### 代码块
\`\`\`js
const message = "Hello Catalpa"
console.log(message)
\`\`\`
`

const source = ref(initialDoc)

const previewHtml = computed(() => renderCatalpa(source.value))
const lineCount = computed(() => source.value.split(/\r?\n/).length)
const charCount = computed(() => source.value.length)

function resetToDemo() {
  source.value = initialDoc
}

function clearAll() {
  source.value = ''
}
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">Vue 3 + Vite</p>
        <h1>Catalpa 编辑与预览</h1>
        <p class="subtitle">左侧输入 Catalpa 文本，右侧实时渲染预览。</p>
      </div>
      <div class="stats">
        <span>{{ lineCount }} 行</span>
        <span>{{ charCount }} 字符</span>
      </div>
    </header>

    <main class="workspace">
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区</h2>
          <div class="actions">
            <button class="ghost-btn" type="button" @click="resetToDemo">恢复示例</button>
            <button class="ghost-btn danger" type="button" @click="clearAll">清空</button>
          </div>
        </div>
        <textarea
          v-model="source"
          class="editor"
          placeholder="在这里输入 Catalpa 内容..."
          spellcheck="false"
        />
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>预览区</h2>
        </div>
        <article class="preview markdown-body" v-html="previewHtml"></article>
      </section>
    </main>
  </div>
</template>
