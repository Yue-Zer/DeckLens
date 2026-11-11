<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, ChevronRight, FileText, GitBranch, Layers3, Sparkles, X } from '@lucide/vue'
import type { ExploreNode, SourceLocator, Term } from '../api'

const props = defineProps<{
  path: ExploreNode[]
  activeId: string
  terms: Term[]
  busy: boolean
  anchors: Map<string, HTMLElement>
  scrollOffsets: Record<string, number>
}>()
const emit = defineEmits<{
  close: [nodeId: string]
  closeAll: []
  activate: [node: ExploreNode]
  cite: [blockId: string]
  term: [term: Term, parent: ExploreNode, element: HTMLElement]
  ask: [node: ExploreNode, question: string, kind: 'qa' | 'deepens' | 'related' | 'branch']
  scroll: [nodeId: string, offset: number]
}>()

type CardLayout = { id: string; left: number; top: number; width: number; maxHeight: number; side: 'left' | 'right'; path?: string; kind?: string }
const layouts = ref<CardLayout[]>([])
const compact = ref(false)
const mobile = ref(false)
const anchorVisible = ref(true)
const drafts = ref<Record<string, string>>({})
const touchStartY = ref<number | null>(null)
const viewportHeight = ref(window.innerHeight)
const viewportWidth = ref(window.innerWidth)
let frame = 0
let resizeObserver: ResizeObserver | null = null
const cardElements = new Map<string, HTMLElement>()
const bodyElements = new Map<string, HTMLElement>()
const active = computed(() => props.path.find(node => id(node) === props.activeId) ?? props.path.at(-1))
const visibleCards = computed(() => compact.value || props.path.length > 3 ? active.value ? [active.value] : [] : props.path.slice(-3))
const byId = computed(() => new Map(layouts.value.map(layout => [layout.id, layout])))

function id(node: ExploreNode) { return node.nodeId || node.id }
function label(locator?: SourceLocator) {
  if (locator?.slideNumber) return `原文 · 幻灯片 ${locator.slideNumber}`
  if (locator?.pageNumber) return `原文 · 第 ${locator.pageNumber} 页`
  if (locator?.lineStart) return `原文 · 第 ${locator.lineStart} 行`
  return locator?.headingPath?.length ? `原文 · ${locator.headingPath.join(' / ')}` : '文档原文'
}
function source(node: ExploreNode) { return node.sources?.find(item => item.role === 'anchor') ?? node.sources?.[0] }
function kind(node: ExploreNode) {
  if (node.context?.termId && !node.parentNodeId) return '原文术语'
  return ({ deepens: '深挖', deepening: '深挖', related: '关联', branch: '分叉', explanation: '术语', qa: '问答' } as Record<string, string>)[node.kind ?? 'qa'] ?? '探索'
}
function origin(node: ExploreNode) {
  if (node.origin === 'source') return '文档原文定义'
  if (node.origin === 'local') return node.context?.termId ? '文档中出现' : '本地检索结果'
  if (node.origin === 'ai' || node.context?.definitionKind === 'ai' || node.model) return 'AI 生成，仅供参考'
  if (node.context?.definitionKind === 'source') return '文档原文定义'
  if (node.context?.termId) return '文档中出现'
  return '本地检索结果'
}
function sourceBlock(node: ExploreNode) { return node.sourceBlockId ?? source(node)?.blockId ?? node.citations?.[0]?.blockId ?? '' }
function sourceElement(node: ExploreNode): HTMLElement | null {
  const remembered = props.anchors.get(id(node))
  if (remembered?.isConnected) return remembered
  const blockId = sourceBlock(node)
  const block = blockId ? document.getElementById(`block-${blockId}`) : null
  const offset = source(node)?.startOffset
  const matchingTerm = block && offset !== undefined ? block.querySelector<HTMLElement>(`[data-term-start="${offset}"]`) : null
  return matchingTerm ?? block
}
function rootRect() {
  const root = props.path[0]
  const element = root && sourceElement(root)
  return element?.getBoundingClientRect() ?? document.querySelector('.bottom-ask')?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2, 160, 0, 0)
}
function setCard(node: ExploreNode, value: unknown) {
  const key = id(node)
  if (value instanceof HTMLElement) {
    cardElements.set(key, value)
    resizeObserver?.observe(value)
  } else cardElements.delete(key)
}
function setBody(node: ExploreNode, value: unknown) {
  if (!(value instanceof HTMLElement)) { bodyElements.delete(id(node)); return }
  bodyElements.set(id(node), value)
  const offset = props.scrollOffsets[id(node)]
  if (offset !== undefined && value.scrollTop !== offset) value.scrollTop = offset
}
function scheduleLayout() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(layout)
}
function layout() {
  const width = window.innerWidth
  const height = window.innerHeight
  viewportWidth.value = width
  viewportHeight.value = height
  mobile.value = width <= 680
  const rect = rootRect()
  const headerBottom = document.querySelector('.reader-toolbar')?.getBoundingClientRect().bottom ?? 64
  anchorVisible.value = !props.path.length || (rect.bottom > headerBottom && rect.top < height - 32)
  const cardWidth = Math.min(360, width - 32)
  const rightFits = rect.right + 16 + cardWidth <= width - 16
  const leftFits = rect.left - 16 - cardWidth >= 16
  const side: 'right' | 'left' = rightFits || !leftFits ? 'right' : 'left'
  const desired = side === 'right' ? rect.right + 16 : rect.left - cardWidth - 16
  const rootLeft = Math.max(16, Math.min(width - cardWidth - 16, desired))
  const pathWidth = cardWidth + Math.max(0, Math.min(3, props.path.length) - 1) * 32
  const cascadeFits = side === 'right' ? rootLeft + pathWidth <= width - 16 : rootLeft - (pathWidth - cardWidth) >= 16
  const shouldCompact = mobile.value || !cascadeFits || (!rightFits && !leftFits) || props.path.length > 3
  if (compact.value !== shouldCompact) { compact.value = shouldCompact; void nextTick(scheduleLayout) }
  const visible = shouldCompact ? active.value ? [active.value] : [] : props.path.slice(-3)
  const maxHeight = Math.min(height * .66, height - headerBottom - 32)
  const next: CardLayout[] = []
  for (let index = 0; index < visible.length; index += 1) {
    const node = visible[index]
    const measured = cardElements.get(id(node))?.getBoundingClientRect().height ?? Math.min(440, maxHeight)
    const actualHeight = Math.min(measured, maxHeight)
    let top = Math.max(headerBottom + 12, Math.min(rect.top - 8 + index * 24, height - actualHeight - 16))
    let left = rootLeft + (side === 'right' ? 1 : -1) * index * 32
    if (!rightFits && !leftFits) {
      // Narrow desktop windows use the free space below or above the selected words.
      top = rect.bottom + 12 + actualHeight <= height - 16 ? rect.bottom + 12 : Math.max(headerBottom + 12, rect.top - actualHeight - 12)
      left = Math.max(16, Math.min(width - cardWidth - 16, rect.left))
    }
    if (mobile.value) { left = 0; top = height * .28 }
    const anchor = index === 0 ? rect : (sourceElement(node)?.getBoundingClientRect() ?? rect)
    const cardEdge = side === 'right' ? left : left + cardWidth
    const anchorX = side === 'right' ? anchor.right : anchor.left
    const anchorY = Math.max(headerBottom, Math.min(height - 16, anchor.top + Math.min(12, anchor.height / 2)))
    const endY = Math.max(top + 24, Math.min(top + actualHeight - 24, anchorY))
    const bend = anchorX + (side === 'right' ? 8 : -8)
    next.push({ id: id(node), left, top, width: mobile.value ? width : cardWidth, maxHeight: mobile.value ? height * .72 : maxHeight, side,
      path: mobile.value || (!rightFits && !leftFits) ? undefined : `M ${anchorX} ${anchorY} L ${bend} ${anchorY} L ${bend} ${endY} L ${cardEdge} ${endY}`,
      kind: node.kind,
    })
  }
  layouts.value = next
}
function style(node: ExploreNode) {
  const item = byId.value.get(id(node))
  return item ? { left: `${item.left}px`, top: `${item.top}px`, width: `${item.width}px`, maxHeight: `${item.maxHeight}px`, '--card-depth': props.path.findIndex(value => id(value) === id(node)) } : { visibility: 'hidden' as const }
}
function answerSegments(node: ExploreNode) {
  const text = node.answer ?? ''
  const found: Array<{ start: number; end: number; term: Term }> = []
  const occupied: Array<{ start: number; end: number }> = []
  for (const term of [...props.terms].sort((a, b) => b.text.length - a.text.length)) {
    const word = term.canonicalText || term.text
    if (word.length < 2) continue
    let cursor = 0
    while ((cursor = text.toLocaleLowerCase().indexOf(word.toLocaleLowerCase(), cursor)) >= 0) {
      const end = cursor + word.length
      const boundary = !/^[\p{L}\p{N}_]+$/u.test(word) || (!/[\p{L}\p{N}_]/u.test(text[cursor - 1] ?? '') && !/[\p{L}\p{N}_]/u.test(text[end] ?? ''))
      if (boundary && !occupied.some(span => cursor < span.end && end > span.start) && found.length < 6) {
        found.push({ start: cursor, end, term }); occupied.push({ start: cursor, end })
      }
      cursor = end
      if (found.length >= 6) break
    }
    if (found.length >= 6) break
  }
  found.sort((a, b) => a.start - b.start)
  const result: Array<{ text: string; term?: Term }> = []
  let cursor = 0
  for (const match of found) {
    if (match.start > cursor) result.push({ text: text.slice(cursor, match.start) })
    result.push({ text: text.slice(match.start, match.end), term: match.term })
    cursor = match.end
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor) })
  return result
}
function clickTerm(term: Term, node: ExploreNode, event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement) emit('term', term, node, event.currentTarget)
}
function ask(node: ExploreNode, action: 'qa' | 'deepens' | 'related' | 'branch') {
  const value = drafts.value[id(node)]?.trim()
  const title = node.context?.termText || node.title
  const prompt = value || (action === 'related' ? `「${title}」与文档中哪些概念相关？请引用文档依据。` : action === 'branch' ? `从另一个角度解释「${title}」，并引用文档依据。` : `围绕「${title}」继续深入解释，并引用文档依据。`)
  if (action === 'qa' && !value) return
  emit('ask', node, prompt, action)
  drafts.value[id(node)] = ''
}
function ancestorPath(node: ExploreNode) { return props.path.slice(0, props.path.findIndex(item => id(item) === id(node)) + 1) }
function restoreAnchor() {
  const node = props.path[0]
  if (node) emit('cite', sourceBlock(node))
  scheduleLayout()
}
function finishTouch(event: TouchEvent) {
  if (touchStartY.value !== null && event.changedTouches[0] && event.changedTouches[0].clientY - touchStartY.value > 80) emit('closeAll')
  touchStartY.value = null
}
watch(() => `${props.path.map(id).join('|')}:${props.activeId}`, async () => { await nextTick(); scheduleLayout() }, { immediate: true })
onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleLayout)
  for (const element of cardElements.values()) resizeObserver.observe(element)
  window.addEventListener('resize', scheduleLayout)
  window.addEventListener('scroll', scheduleLayout, true)
})
onUnmounted(() => {
  cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', scheduleLayout)
  window.removeEventListener('scroll', scheduleLayout, true)
})
</script>

<template>
  <div v-if="path.length" class="exploration-layer" :class="{ 'anchor-away': !anchorVisible, 'compact-cards': compact, 'mobile-cards': mobile }">
    <svg v-if="!mobile && anchorVisible" class="exploration-connectors" aria-hidden="true" :viewBox="`0 0 ${viewportWidth} ${viewportHeight}`">
      <path v-for="item in layouts.filter(value => value.path)" :key="item.id" :d="item.path" :class="`connector-${item.kind || 'deepens'}`" />
    </svg>
    <article v-for="node in visibleCards" :key="id(node)" :ref="value => setCard(node, value)" class="exploration-card" :class="{ 'current-card': id(node) === active?.id, 'ancestor-card': id(node) !== active?.id }" :style="style(node)" :aria-label="`探索：${node.title}`" @pointerdown="id(node) !== active?.id && $emit('activate', node)">
      <div v-if="mobile" class="card-drag-handle" aria-label="向下滑动收起探索卡" @touchstart="touchStartY = $event.touches[0]?.clientY ?? null" @touchend="finishTouch"><span></span></div>
      <header class="floating-card-header">
        <div class="floating-type"><span :class="`type-${node.kind || 'deepens'}`">{{ kind(node) }}</span><span>{{ origin(node) }}</span></div>
        <div class="floating-close-tools"><button class="icon-button tiny" aria-label="收起全部探索卡" title="收起全部" @click.stop="$emit('closeAll')"><Layers3 :size="14" /></button><button class="icon-button tiny" aria-label="关闭当前探索卡及其子卡" title="关闭当前及子卡" @click.stop="$emit('close', id(node))"><X :size="16" /></button></div>
      </header>
      <nav class="card-breadcrumbs" aria-label="卡片探索路径">
        <button :title="label(source(node)?.locator)" @click="$emit('cite', sourceBlock(node))">{{ label(source(node)?.locator) }}</button>
        <template v-for="ancestor in ancestorPath(node)" :key="id(ancestor)"><ChevronRight :size="12" /><button :class="{ current: id(ancestor) === id(node) }" :title="ancestor.title" @click="$emit('activate', ancestor)">{{ ancestor.title }}</button></template>
      </nav>
      <div :ref="value => setBody(node, value)" class="floating-card-body" @scroll="$emit('scroll', id(node), ($event.currentTarget as HTMLElement).scrollTop)">
        <h3>{{ node.title }}</h3>
        <p v-if="node.question && node.question !== node.title" class="floating-question">{{ node.question }}</p>
        <p v-if="node.answer" class="floating-answer"><template v-for="(segment, index) in answerSegments(node)" :key="index"><button v-if="segment.term" class="term-anchor card-term" @click.stop="clickTerm(segment.term, node, $event)">{{ segment.text }}</button><span v-else>{{ segment.text }}</span></template></p>
        <p v-else class="answer-placeholder">{{ node.status === 'pending' ? '正在保存原文节点…' : '当前节点尚无回答，可以基于文档继续提问。' }}</p>
        <button v-if="sourceBlock(node)" class="floating-source" @click="$emit('cite', sourceBlock(node))"><FileText :size="14" /><span>{{ label(source(node)?.locator) }}</span><ChevronRight :size="14" /></button>
        <div v-for="(citation, index) in node.citations ?? []" :key="`${citation.blockId}-${index}`" class="citation-row"><span class="citation-index">{{ index + 1 }}</span><div><span class="citation-source">{{ label(citation.locator) }}</span><p>“{{ citation.quote }}”</p></div><button :aria-label="`定位引用 ${index + 1}`" @click="$emit('cite', citation.blockId)"><ChevronRight :size="15" /></button></div>
        <p v-if="node.model" class="model-attribution">{{ node.provider }} · {{ node.model }}</p>
      </div>
      <footer class="floating-card-footer">
        <div v-if="compact && path.length > 1" class="card-history"><button :disabled="ancestorPath(node).length <= 1" @click="$emit('activate', path[Math.max(0, ancestorPath(node).length - 2)])"><ArrowLeft :size="14" />上一步</button><span>{{ ancestorPath(node).length }} / {{ path.length }}</span><button :disabled="ancestorPath(node).length >= path.length" @click="$emit('activate', path[Math.min(path.length - 1, ancestorPath(node).length)])">下一步<ArrowRight :size="14" /></button></div>
        <form class="card-ask" @submit.prevent="ask(node, 'qa')"><input v-model="drafts[id(node)]" :disabled="busy || node.status === 'pending'" :aria-label="`追问 ${node.title}`" placeholder="沿这个节点继续提问…" /><button :disabled="busy || !drafts[id(node)]?.trim() || node.status === 'pending'" aria-label="提交节点追问"><ArrowRight :size="16" /></button></form>
        <div class="card-explore-actions"><button :disabled="busy || node.status === 'pending'" @click="ask(node, 'deepens')"><Sparkles :size="14" />深挖</button><button :disabled="busy || node.status === 'pending'" @click="ask(node, 'related')"><Layers3 :size="14" />关联</button><button :disabled="busy || node.status === 'pending'" @click="ask(node, 'branch')"><GitBranch :size="14" />分叉</button></div>
      </footer>
    </article>
    <button v-if="!anchorVisible" class="return-to-branch" @click="restoreAnchor"><GitBranch :size="16" /><span>回到「{{ path[0]?.title }}」分支</span><ArrowRight :size="15" /></button>
  </div>
</template>
