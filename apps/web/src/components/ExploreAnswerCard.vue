<script setup lang="ts">
import { ChevronRight, Sparkles, Split } from '@lucide/vue'
import type { ExploreNode, SourceLocator } from '../api'

defineProps<{ node: ExploreNode; kindLabel: string; busy: boolean }>()
defineEmits<{ cite: [blockId: string]; deepen: []; branch: [] }>()
function citationLabel(locator?: SourceLocator) {
  const format = locator?.format?.toUpperCase() ?? '文档'
  if (locator?.slideNumber) return `${format} · 幻灯片 ${locator.slideNumber}`
  if (locator?.pageNumber) return `${format} · 第 ${locator.pageNumber} 页`
  if (locator?.lineStart) return `${format} · 第 ${locator.lineStart} 行`
  return locator?.headingPath?.length ? `${format} · ${locator.headingPath.join(' / ')}` : `${format}原文`
}
</script>

<template>
  <article class="answer-card">
    <div class="answer-meta"><span>{{ kindLabel }}</span><span v-if="node.status === 'pending'">生成中</span><span v-else>{{ node.model ? 'AI 生成，仅供参考' : '本地检索结果' }}</span></div>
    <h3>{{ node.question || node.title }}</h3>
    <p v-if="node.answer" class="answer-text">{{ node.answer }}</p>
    <p v-else class="answer-placeholder">这个节点还没有回答，或当前没有可用的 AI 服务。</p>
    <div v-for="(citation, index) in node.citations ?? []" :key="`${citation.blockId}-${index}`" class="citation-row">
      <span class="citation-index">{{ index + 1 }}</span><div><span class="citation-source">{{ citationLabel(citation.locator) }}</span><p>“{{ citation.quote }}”</p></div><button :aria-label="`跳转引用 ${index + 1}`" title="跳转到原文" @click="$emit('cite', citation.blockId)"><ChevronRight :size="15" /></button>
    </div>
    <p v-if="node.model" class="model-attribution">{{ node.provider }} · {{ node.model }}</p>
    <div class="answer-actions"><button :disabled="busy" @click="$emit('deepen')"><Sparkles :size="14" />继续钻取</button><button :disabled="busy" @click="$emit('branch')"><Split :size="14" />新分支</button></div>
  </article>
</template>
