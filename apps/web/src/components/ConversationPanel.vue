<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, CornerDownRight, FileText, GitBranch, History, Plus, Trash2, X } from '@lucide/vue'
import type { ChatSummary, ExploreEdge, ExploreNode, SourceLocator, Term } from '../api'
import { conversationLeaves, conversationPath, nodeId, type ReplyKind } from '../conversation'

const props = defineProps<{
  nodes: ExploreNode[]
  edges: ExploreEdge[]
  terms: Term[]
  chats: ChatSummary[]
  chatId: string
  activeNodeId: string
  expandedNodeIds: string[]
  documentTitle: string
  pendingQuestion: string
  busy: boolean
  loading: boolean
  error: string
}>()
const emit = defineEmits<{
  activate: [nodeId: string]
  toggle: [nodeId: string]
  deleteBranch: [nodeId: string]
  reply: [nodeId: string, kind: ReplyKind]
  newChat: []
  switchChat: [chatId: string]
  cite: [blockId: string, annotationId?: string]
  article: [node: ExploreNode]
  close: []
  term: [term: Term, parentNodeId: string]
}>()
const messages = ref<HTMLElement | null>(null)
const history = ref<HTMLDetailsElement | null>(null)
const path = computed(() => conversationPath(props.nodes, props.edges, props.activeNodeId))
const leaves = computed(() => conversationLeaves(props.nodes, props.edges))
const expanded = computed(() => new Set(props.expandedNodeIds))
const trail = computed(() => path.value.slice(-3))

function sourceLabel(locator?: SourceLocator) {
  if (locator?.slideNumber) return `幻灯片 ${locator.slideNumber}`
  if (locator?.pageNumber) return `第 ${locator.pageNumber} 页`
  if (locator?.lineStart) return `第 ${locator.lineStart} 行`
  return locator?.headingPath?.join(' / ') || '文档原文'
}
function annotationId(node: ExploreNode) { return typeof node.context?.annotationId === 'string' ? node.context.annotationId : undefined }
function anchor(node: ExploreNode) { return node.sources?.find(source => source.role === 'anchor') }
function citations(node: ExploreNode) { return node.citations ?? node.sources?.filter(source => source.role === 'evidence') ?? [] }
function originLabel(node: ExploreNode) {
  if (node.origin === 'source') return '文档原文'
  if (node.origin === 'ai' || node.model) return 'AI 生成，仅供参考'
  return '本地文档检索'
}
function selectPath(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value) emit('activate', value)
  if (history.value) history.value.open = false
}
function selectChat(event: Event) {
  emit('switchChat', (event.target as HTMLSelectElement).value)
  if (history.value) history.value.open = false
}
function reply(node: ExploreNode, kind: ReplyKind) {
  emit('reply', nodeId(node), kind)
}
function answerSegments(text: string) {
  const found: Array<{ start: number; end: number; term: Term }> = []
  for (const term of [...props.terms].sort((a, b) => (b.canonicalText ?? b.text).length - (a.canonicalText ?? a.text).length)) {
    const word = term.canonicalText || term.text
    if (word.length < 2) continue
    let offset = 0
    while ((offset = text.toLocaleLowerCase().indexOf(word.toLocaleLowerCase(), offset)) >= 0) {
      const end = offset + word.length
      const validBoundary = (!/[A-Za-z0-9_]/u.test(word[0]) || !/[A-Za-z0-9_]/u.test(text[offset - 1] ?? ''))
        && (!/[A-Za-z0-9_]/u.test(word.at(-1) ?? '') || !/[A-Za-z0-9_]/u.test(text[end] ?? ''))
      if (validBoundary && found.length < 6 && !found.some(item => offset < item.end && end > item.start)) found.push({ start: offset, end, term })
      offset = end
    }
  }
  found.sort((a, b) => a.start - b.start)
  const segments: Array<{ text: string; term?: Term }> = []
  let cursor = 0
  for (const item of found) {
    if (item.start > cursor) segments.push({ text: text.slice(cursor, item.start) })
    segments.push({ text: text.slice(item.start, item.end), term: item.term })
    cursor = item.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}
watch(() => [props.activeNodeId, props.busy, props.chatId], async () => {
  await nextTick()
  messages.value?.scrollTo({ top: messages.value.scrollHeight, behavior: 'smooth' })
})
</script>

<template>
  <section class="conversation-panel" aria-label="AI 对话">
    <header class="conversation-header">
      <h2>对话</h2>
      <div class="conversation-header-actions">
        <details ref="history" class="conversation-history">
          <summary class="icon-button" aria-label="对话历史" title="对话历史"><History :size="17" /></summary>
          <div class="conversation-history-menu">
            <label>对话记录<select :value="chatId" :disabled="busy || loading || !chats.length" @change="selectChat"><option v-for="chat in chats" :key="chat.chatId" :value="chat.chatId">{{ chat.title }}</option></select></label>
            <label v-if="leaves.length">已保存的对话路径<select :value="leaves.some(node => nodeId(node) === activeNodeId) ? activeNodeId : ''" :disabled="busy" @change="selectPath"><option disabled value="">选择一条路径</option><option v-for="(node, index) in leaves" :key="nodeId(node)" :value="nodeId(node)">{{ index + 1 }} · {{ node.question || node.title }}</option></select></label>
            <p>切换路径后，仅沿该路径继续对话。</p>
          </div>
        </details>
        <button class="icon-button" :disabled="busy || loading || !documentTitle" aria-label="新建对话" title="新建对话" @click="emit('newChat')"><Plus :size="18" /></button>
        <button class="icon-button conversation-close" aria-label="关闭对话面板" @click="emit('close')"><X :size="18" /></button>
      </div>
    </header>
    <nav v-if="leaves.length > 1 && trail.length" class="conversation-trail" aria-label="当前分支路径">
      <template v-for="(node, index) in trail" :key="nodeId(node)"><ChevronRight v-if="index" :size="12" /><button :disabled="busy" :title="node.question || node.title" :aria-current="nodeId(node) === activeNodeId ? 'step' : undefined" @click="emit('activate', nodeId(node))">{{ node.question || node.title }}</button></template>
    </nav>
    <div ref="messages" class="conversation-messages branch-conversation" role="log" aria-label="对话消息" :aria-busy="busy">
      <div v-if="loading" class="conversation-state" role="status"><span class="loading-rule"></span><p>正在恢复对话…</p></div>
      <article v-for="(node, index) in path" :key="nodeId(node)" class="conversation-turn" :class="{ 'has-parent': index > 0 }" :data-conversation-node="nodeId(node)">
        <p class="chat-user-message">{{ node.question || node.title }}</p>
        <div class="chat-assistant-message">
          <button class="turn-collapse" :aria-expanded="expanded.has(nodeId(node))" :aria-label="expanded.has(nodeId(node)) ? '收起这条回答' : '展开这条回答'" @click="emit('toggle', nodeId(node))"><ChevronDown v-if="expanded.has(nodeId(node))" :size="14" /><ChevronRight v-else :size="14" /><span>{{ expanded.has(nodeId(node)) ? '回答' : '回答已收起' }}</span></button>
          <template v-if="expanded.has(nodeId(node))">
            <p class="chat-answer"><template v-for="(segment, segmentIndex) in answerSegments(node.answer || '该条对话尚无回答。')" :key="segmentIndex"><button v-if="segment.term" class="term-anchor chat-term" :disabled="busy" @click="emit('term', segment.term, nodeId(node))">{{ segment.text }}</button><span v-else>{{ segment.text }}</span></template></p>
            <div class="chat-answer-meta"><span>{{ originLabel(node) }}</span><span v-if="node.model" :title="`${node.provider || ''} · ${node.model}`">{{ node.model }}</span></div>
            <button v-if="node.context?.articleSelection" class="chat-source" @click="emit('article', node)"><FileText :size="13" />查看文章圈选<ChevronRight :size="12" /></button>
            <button v-if="anchor(node)" class="chat-source" @click="emit('cite', anchor(node)!.blockId, node.context?.articleSelection ? undefined : annotationId(node))"><FileText :size="13" />{{ annotationId(node) && !node.context?.articleSelection ? '查看圈选原文' : sourceLabel(anchor(node)?.locator) }}<ChevronRight :size="12" /></button>
            <details v-if="citations(node).length" class="chat-citations"><summary>{{ citations(node).length }} 处原文引用</summary><button v-for="(citation, citationIndex) in citations(node)" :key="`${citation.blockId}-${citationIndex}`" @click="emit('cite', citation.blockId)"><span>{{ sourceLabel(citation.locator) }}</span><q>{{ citation.quote }}</q></button></details>
            <div class="chat-turn-actions">
              <button :disabled="busy" title="沿这条回答深入" @click="reply(node, 'deepens')"><CornerDownRight :size="13" />深入</button><button :disabled="busy" title="探索相关概念" @click="reply(node, 'related')">关联</button>
              <button :disabled="busy" title="继承到这条回答为止的上下文，另开一条对话" @click="reply(node, 'branch')"><GitBranch :size="13" />从这里分支</button>
              <button class="chat-delete" :disabled="busy" aria-label="删除这条对话及后续分支" title="删除这条对话及后续分支" @click="emit('deleteBranch', nodeId(node))"><Trash2 :size="13" /></button>
            </div>
          </template>
        </div>
      </article>
      <div v-if="busy" class="chat-pending" role="status"><p v-if="pendingQuestion" class="chat-user-message">{{ pendingQuestion }}</p><span class="loading-rule"></span><p>正在依据文档生成回答…</p></div>
      <p v-if="error" class="conversation-error" role="alert">{{ error }}</p>
    </div>
    <slot name="composer" />
  </section>
</template>
