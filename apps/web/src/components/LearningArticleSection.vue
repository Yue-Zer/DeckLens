<script setup lang="ts">
import type { LearningArticleSection } from '@decklens/contracts'
import { api } from '../api'

defineProps<{ section: LearningArticleSection }>()
const emit = defineEmits<{ cite: [blockId: string] }>()
function location(locator: { pageNumber?: number; slideNumber?: number; lineStart?: number }) {
  return locator.slideNumber ? `幻灯片 ${locator.slideNumber}` : locator.pageNumber ? `第 ${locator.pageNumber} 页` : locator.lineStart ? `第 ${locator.lineStart} 行` : '原文'
}
// Split only at Chinese sentence endings; leave short or punctuation-free passages intact.
function displayParagraphs(text: string): string[] {
  const pieces = text.split(/(?<=[。！？])/u)
  const result: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (current.length >= 180) { result.push(current); current = '' }
    current += piece
  }
  if (current) result.push(current)
  return result.length ? result : [text]
}
</script>

<template>
  <section :id="`article-section-${section.id}`" class="article-section">
    <component :is="section.depth > 0 ? 'h3' : 'h2'" class="section-heading">{{ section.title }}</component>
    <figure v-for="figure in section.figures.filter(item => !item.afterParagraphId)" :key="figure.id" class="reader-image">
      <img :src="api.getAssetUrl(figure.assetId)" :alt="figure.caption || '课件原图'" loading="lazy" />
      <figcaption>{{ figure.caption ? `原文图注：${figure.caption}` : '课件原图' }} · <button class="article-source" @click="emit('cite', figure.blockId)">{{ location(figure.locator) }}</button></figcaption>
    </figure>
    <template v-for="paragraph in section.paragraphs" :key="paragraph.id">
      <p v-for="(part, index) in displayParagraphs(paragraph.text)" :key="index" class="reader-paragraph">{{ part }}</p>
      <details v-if="paragraph.sources.length" class="article-sources">
        <summary>查看参考原文（{{ paragraph.sources.length }}）</summary>
        <ul><li v-for="source in paragraph.sources" :key="source.blockId"><button class="article-source" @click="emit('cite', source.blockId)"><strong>{{ location(source.locator) }}</strong><span>{{ source.quote || '定位到原文内容' }}</span></button></li></ul>
      </details>
      <figure v-for="figure in section.figures.filter(item => item.afterParagraphId === paragraph.id)" :key="figure.id" class="reader-image">
        <img :src="api.getAssetUrl(figure.assetId)" :alt="figure.caption || '课件原图'" loading="lazy" />
        <figcaption>{{ figure.caption ? `原文图注：${figure.caption}` : '课件原图' }} · <button class="article-source" @click="emit('cite', figure.blockId)">{{ location(figure.locator) }}</button></figcaption>
      </figure>
    </template>
    <LearningArticleSection v-for="child in section.children" :key="child.id" :section="child" @cite="emit('cite', $event)" />
  </section>
</template>
