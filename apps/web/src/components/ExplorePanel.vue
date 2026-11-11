<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { ChevronDown, ChevronRight, FileText, GitBranch, Layers3, Settings2, Sparkles, Trash2, X } from '@lucide/vue'
import type { ExploreEdge, ExploreNode, SourceLocator, Term } from '../api'

type TreeRow = { node: ExploreNode; depth: number; hasChildren: boolean }
type ActionKind = 'deepens' | 'related' | 'branch'

const props = defineProps<{
  nodes: ExploreNode[]
  edges: ExploreEdge[]
  terms: Term[]
  activeNodeId: string
  expandedNodeIds: string[]
  busy: boolean
  aiAvailable: boolean
  loading: boolean
  error: string
}>()
const emit = defineEmits<{
  activate: [nodeId: string]
  toggle: [nodeId: string]
  deleteBranch: [nodeId: string]
  createNote: [parentNodeId?: string]
  ask: [nodeId: string, question: string, kind: ActionKind | 'qa']
  saveNote: [nodeId: string, title: string, answer: string]
  cite: [blockId: string, annotationId?: string]
  configure: []
  close: []
  term: [term: Term, parentNodeId: string]
}>()

const drafts = reactive<Record<string, string>>({})
const noteTitles = reactive<Record<string, string>>({})
const noteBodies = reactive<Record<string, string>>({})
const questions = reactive<Record<string, string>>({})
const expanded = computed(() => new Set(props.expandedNodeIds))
const nodeById = computed(() => new Map(props.nodes.map(node => [id(node), node])))
const parentById = computed(() => {
  const map = new Map<string, string>()
  for (const edge of props.edges) if (edge.kind !== 'related') map.set(edge.toNodeId, edge.fromNodeId)
  return map
})
const childrenById = computed(() => {
  const map = new Map<string, ExploreNode[]>()
  for (const edge of props.edges) {
    if (edge.kind === 'related') continue
    const child = nodeById.value.get(edge.toNodeId)
    if (child) map.set(edge.fromNodeId, [...(map.get(edge.fromNodeId) ?? []), child])
  }
  for (const children of map.values()) children.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  return map
})
const rows = computed<TreeRow[]>(() => {
  const result: TreeRow[] = []
  const visited = new Set<string>()
  const visit = (node: ExploreNode, depth: number) => {
    const key = id(node)
    if (visited.has(key)) return
    visited.add(key)
    const children = childrenById.value.get(key) ?? []
    result.push({ node, depth, hasChildren: children.length > 0 })
    if (expanded.value.has(key)) for (const child of children) visit(child, depth + 1)
  }
  const roots = props.nodes.filter(node => !parentById.value.has(id(node))).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  for (const root of roots) visit(root, 0)
  for (const node of props.nodes) visit(node, 0)
  return result
})
const active = computed(() => nodeById.value.get(props.activeNodeId))
const breadcrumbs = computed(() => {
  const result: ExploreNode[] = []
  const visited = new Set<string>()
  let current = active.value
  while (current && !visited.has(id(current))) {
    visited.add(id(current))
    result.unshift(current)
    current = nodeById.value.get(parentById.value.get(id(current)) ?? '')
  }
  return result
})
const activeAnchor = computed(() => active.value?.sources?.find(source => source.role === 'anchor') ?? active.value?.sources?.[0])
const activeEvidence = computed(() => active.value?.citations ?? active.value?.sources?.filter(source => source.role === 'evidence') ?? [])

function id(node: ExploreNode) { return node.nodeId || node.id }
function annotationId(node?: ExploreNode) { return typeof node?.context?.annotationId === 'string' ? node.context.annotationId : undefined }
function relation(node: ExploreNode) {
  const parentId = parentById.value.get(id(node))
  if (!parentId) return node.kind === 'note' ? '笔记' : node.kind === 'explanation' ? '术语' : '问答'
  return node.relationKind ?? props.edges.find(edge => edge.toNodeId === id(node) && edge.kind === 'related')?.kind
    ?? props.edges.find(edge => edge.toNodeId === id(node) && edge.kind !== 'related')?.kind ?? 'deepens'
}
function relationLabel(node: ExploreNode) {
  return ({ deepens: '深挖', related: '关联', branch: '分叉', note: '笔记', explanation: '术语', qa: '问答' } as Record<string, string>)[relation(node)] ?? '探索'
}
function originLabel(node: ExploreNode) {
  if (node.kind === 'note') return '本地笔记'
  if (node.origin === 'source') return '文档来源'
  if (node.origin === 'ai' || node.model) return 'AI 生成，仅供参考'
  return '本地检索'
}
function sourceLabel(locator?: SourceLocator) {
  if (locator?.slideNumber) return `幻灯片 ${locator.slideNumber}`
  if (locator?.pageNumber) return `第 ${locator.pageNumber} 页`
  if (locator?.lineStart) return `第 ${locator.lineStart} 行`
  return locator?.headingPath?.join(' / ') || '文档原文'
}
function answerSegments(text: string) {
  const found: Array<{ start: number; end: number; term: Term }> = []
  const occupied: Array<{ start: number; end: number }> = []
  for (const term of [...props.terms].sort((a, b) => (b.canonicalText ?? b.text).length - (a.canonicalText ?? a.text).length)) {
    const word = term.canonicalText || term.text
    if (word.length < 2) continue
    let offset = 0
    while ((offset = text.toLocaleLowerCase().indexOf(word.toLocaleLowerCase(), offset)) >= 0) {
      const end = offset + word.length
      const latinWord = /[A-Za-z0-9_]/u.test(word[0]) || /[A-Za-z0-9_]/u.test(word.at(-1) ?? '')
      const boundary = !latinWord || (!/[A-Za-z0-9_]/u.test(text[offset - 1] ?? '') && !/[A-Za-z0-9_]/u.test(text[end] ?? ''))
      if (boundary && !occupied.some(item => offset < item.end && end > item.start) && found.length < 8) {
        found.push({ start: offset, end, term })
        occupied.push({ start: offset, end })
      }
      offset = end
    }
  }
  found.sort((a, b) => a.start - b.start)
  const result: Array<{ text: string; term?: Term }> = []
  let cursor = 0
  for (const item of found) {
    if (item.start > cursor) result.push({ text: text.slice(cursor, item.start) })
    result.push({ text: text.slice(item.start, item.end), term: item.term })
    cursor = item.end
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor) })
  return result
}
function submitQuestion(kind: ActionKind | 'qa', defaultQuestion?: string) {
  if (!active.value || !props.aiAvailable) { emit('configure'); return }
  const value = questions[id(active.value)]?.trim()
  const title = active.value.title
  const question = value || defaultQuestion || (kind === 'related'
    ? `请结合文档，说明「${title}」与其他概念的关联，并给出原文依据。`
    : kind === 'branch'
      ? `请从另一个角度重新理解「${title}」，保留与当前节点的上下文关联，并引用原文。`
      : `请继续深入解释「${title}」的原理和前置知识，并引用原文。`)
  emit('ask', id(active.value), question, kind)
  questions[id(active.value)] = ''
}
function syncNote(node: ExploreNode) {
  const key = id(node)
  if (!(key in noteTitles)) noteTitles[key] = node.title
  if (!(key in noteBodies)) noteBodies[key] = node.answer ?? ''
}
watch(active, node => { if (node?.kind === 'note') syncNote(node) }, { immediate: true })
</script>

<template>
  <section class="explore-panel" aria-label="AI 层级探索">
    <header class="explore-panel-header">
      <div><p class="eyebrow">EXPLORE</p><h2>知识探索</h2></div>
      <div class="explore-header-actions"><button class="secondary-button note-create" @click="emit('createNote', active ? id(active) : undefined)">+ 笔记</button><button class="icon-button explore-panel-close" aria-label="关闭探索面板" @click="emit('close')"><X :size="17" /></button></div>
    </header>
    <div class="explore-tree-region">
      <div class="explore-tree-title"><strong>探索树</strong><span>{{ nodes.length }}</span></div>
      <div v-if="loading" class="explore-state"><span class="loading-rule"></span><span>正在恢复探索路径…</span></div>
      <div v-else-if="error" class="explore-state error" role="alert">{{ error }}</div>
      <div v-else-if="!nodes.length" class="explore-state"><strong>从正文建立第一条路径</strong><span>点击术语可展开解释；也可以先创建一条本地笔记。</span><button class="text-button" @click="emit('createNote')">新建笔记</button></div>
      <ul v-else class="explore-tree" aria-label="探索节点列表">
        <li v-for="row in rows" :key="id(row.node)" class="explore-tree-row" :style="{ '--depth': row.depth }">
          <button v-if="row.hasChildren" class="tree-toggle" :aria-label="expanded.has(id(row.node)) ? '收起子节点' : '展开子节点'" @click="emit('toggle', id(row.node))">
            <ChevronDown v-if="expanded.has(id(row.node))" :size="14" /><ChevronRight v-else :size="14" />
          </button><span v-else class="tree-spacer"></span>
          <button class="tree-node" :class="{ selected: id(row.node) === activeNodeId }" :aria-current="id(row.node) === activeNodeId ? 'true' : undefined" @click="emit('activate', id(row.node))">
            <span class="tree-kind" :class="`edge-${relation(row.node)}`">{{ relationLabel(row.node) }}</span><span class="tree-title">{{ row.node.title }}</span>
          </button>
          <button class="tree-delete" :aria-label="`删除「${row.node.title}」及其子分支`" title="删除分支" @click="emit('deleteBranch', id(row.node))"><Trash2 :size="14" /></button>
        </li>
      </ul>
    </div>

    <article v-if="active" class="explore-node-card">
      <header class="node-card-header">
        <div class="node-badges"><span class="node-kind-badge" :class="`edge-${relation(active)}`">{{ relationLabel(active) }}</span><span class="node-origin-badge" :class="{ 'ai-origin': originLabel(active).startsWith('AI') }">{{ originLabel(active) }}</span></div>
        <button class="tree-delete card-delete" :aria-label="`删除「${active.title}」及其子分支`" title="删除分支" @click="emit('deleteBranch', id(active))"><Trash2 :size="15" /></button>
      </header>
      <nav v-if="breadcrumbs.length" class="node-breadcrumbs" aria-label="探索路径">
        <template v-for="(node, index) in breadcrumbs" :key="id(node)"><button :class="{ current: index === breadcrumbs.length - 1 }" @click="emit('activate', id(node))">{{ node.title }}</button><ChevronRight v-if="index < breadcrumbs.length - 1" :size="13" /></template>
      </nav>
      <div class="node-card-content">
        <h3>{{ active.title }}</h3>
        <p v-if="active.question && active.question !== active.title" class="node-question">{{ active.question }}</p>
        <template v-if="active.kind === 'note'">
          <label class="note-editor"><span>本地笔记</span><input v-model="noteTitles[id(active)]" :aria-label="`笔记标题：${active.title}`" @blur="emit('saveNote', id(active), noteTitles[id(active)] || active.title, noteBodies[id(active)] || '')" /><textarea v-model="noteBodies[id(active)]" placeholder="记录你的理解、疑问或阅读摘录…" @blur="emit('saveNote', id(active), noteTitles[id(active)] || active.title, noteBodies[id(active)] || '')"></textarea></label>
        </template>
        <p v-else-if="active.answer" class="node-answer"><template v-for="(segment, index) in answerSegments(active.answer)" :key="index"><button v-if="segment.term" class="term-anchor card-term" @click="emit('term', segment.term, id(active))">{{ segment.text }}</button><span v-else>{{ segment.text }}</span></template></p>
        <p v-else class="node-empty-answer">该节点暂时没有回答。</p>
        <button v-if="activeAnchor" class="node-source-link" @click="emit('cite', activeAnchor.blockId, annotationId(active))"><FileText :size="14" /><span>原文锚点 · {{ sourceLabel(activeAnchor.locator) }}</span><ChevronRight :size="14" /></button>
        <div v-for="(citation, index) in activeEvidence" :key="`${citation.blockId}-${index}`" class="node-citation">
          <div><span>原文引用 {{ index + 1 }} · {{ sourceLabel(citation.locator) }}</span><p>“{{ citation.quote }}”</p></div><button :aria-label="`跳转到引用 ${index + 1}`" @click="emit('cite', citation.blockId)"><ChevronRight :size="15" /></button>
        </div>
        <p v-if="active.model" class="node-model">{{ active.provider }} · {{ active.model }} · AI 生成，仅供参考</p>
      </div>
      <footer v-if="active.kind !== 'note'" class="node-card-footer">
        <div class="node-question-form"><input v-model="questions[id(active)]" :disabled="busy" aria-label="继续追问" placeholder="沿当前节点继续提问…" @keydown.enter.prevent="submitQuestion('qa')" /><button :disabled="busy" aria-label="发送追问" @click="submitQuestion('qa')"><ChevronRight :size="17" /></button></div>
        <div v-if="!aiAvailable" class="model-required"><span>配置模型后可生成 AI 探索；本地笔记仍可使用。</span><button @click="emit('configure')"><Settings2 :size="14" />配置模型</button></div>
        <div class="node-actions"><button :disabled="busy" @click="submitQuestion('deepens')"><Sparkles :size="14" />深挖</button><button :disabled="busy" @click="submitQuestion('related')"><Layers3 :size="14" />关联</button><button :disabled="busy" @click="submitQuestion('branch')"><GitBranch :size="14" />分叉</button></div>
      </footer>
      <footer v-else class="node-card-footer note-footer"><button class="secondary-button" @click="emit('createNote', id(active))">在此分支添加笔记</button><div v-if="!aiAvailable" class="model-required"><span>AI 深挖、关联和分叉需要先配置模型。</span><button @click="emit('configure')"><Settings2 :size="14" />配置模型</button></div><div v-else class="node-actions"><button :disabled="busy" @click="submitQuestion('deepens', `围绕「${active.title}」深入解释，并引用文档。`)"><Sparkles :size="14" />深挖</button><button :disabled="busy" @click="submitQuestion('related')"><Layers3 :size="14" />关联</button><button :disabled="busy" @click="submitQuestion('branch')"><GitBranch :size="14" />分叉</button></div></footer>
    </article>
    <div v-else-if="!loading && !error && nodes.length" class="explore-card-placeholder"><Layers3 :size="20" /><strong>选择一个节点</strong><span>探索卡片和引用会显示在这里。</span></div>
  </section>
</template>
