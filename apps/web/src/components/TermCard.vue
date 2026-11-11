<script setup lang="ts">
import { ChevronRight, FileText, GitBranch, Layers3, Sparkles, X } from '@lucide/vue'
import type { Term } from '../api'

defineProps<{ term: Term; sourceLabel: string; busy: boolean; explaining: boolean }>()
defineEmits<{ close: []; source: []; explain: []; explore: [kind: 'deepens' | 'related' | 'branch'] }>()
</script>

<template>
  <article class="term-detail">
    <div class="detail-topline"><span class="term-kicker">术语</span><button class="icon-button tiny" aria-label="关闭术语卡" @click="$emit('close')"><X :size="15" /></button></div>
    <h3>{{ term.canonicalText || term.text }}</h3>
    <div class="definition-label" :class="term.kind === 'ai' ? 'ai-origin' : 'source-origin'">{{ term.kind === 'ai' ? 'AI 生成，仅供参考' : term.definition ? '文档原文定义' : '文档中出现' }}</div>
    <p class="term-definition">{{ term.definition || term.locator?.excerpt || '文档中尚未提取到明确释义。可以基于原文继续提问。' }}</p>
    <button v-if="term.locator || term.sourceBlockId" class="jump-source" @click="$emit('source')"><FileText :size="14" />{{ sourceLabel }}<ChevronRight :size="14" /></button>
    <button v-if="!term.definition" class="text-tool explain-term" :disabled="explaining" @click="$emit('explain')">{{ explaining ? '正在生成释义…' : '用模型解释术语' }}</button>
    <div class="term-actions">
      <button :disabled="busy" @click="$emit('explore', 'deepens')"><Sparkles :size="14" />深挖</button>
      <button :disabled="busy" @click="$emit('explore', 'related')"><Layers3 :size="14" />关联</button>
      <button :disabled="busy" @click="$emit('explore', 'branch')"><GitBranch :size="14" />分叉</button>
    </div>
  </article>
</template>
