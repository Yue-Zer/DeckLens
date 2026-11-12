<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { BookOpen, ChevronDown, ChevronRight, Eraser, FilePlus2, FileText, Highlighter, Lasso, Menu, MousePointer2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pencil, Search, Settings2, Trash2, X } from '@lucide/vue'
import { api, type AnnotationTool, type ContentBlock, type DocumentSummary, type ExploreEdge, type ExploreNode, type ImportJob, type ReaderViewState, type Section, type SourceLocator, type Term } from './api'
import AnnotationLayer from './components/AnnotationLayer.vue'
import ExplorePanel from './components/ExplorePanel.vue'
import ProviderSettings from './components/ProviderSettings.vue'
import { resolveSourceBlock } from './source-navigation'

type FlatSection = Section & { depth: number; ancestors: string[] }
type ReaderEntry = { kind: 'section'; section: Section; blockId?: string } | { kind: 'block'; block: ContentBlock }
type TextSegment = { text: string; term?: Term; start?: number; end?: number; selected?: boolean; bold?: boolean; italic?: boolean; code?: boolean }

const documents = ref<DocumentSummary[]>([])
const activeDocumentId = ref('')
const sections = ref<Section[]>([])
const blocks = ref<ContentBlock[]>([])
const parseMetadata = ref<Record<string, unknown>>({})
const terms = ref<Term[]>([])
const exploreNodes = ref<ExploreNode[]>([])
const exploreEdges = ref<ExploreEdge[]>([])
const exploreChatId = ref('')
const activeExploreNodeId = ref('')
const expandedExploreNodes = ref(new Set<string>())
const exploreLoading = ref(false)
const exploreBusy = ref(false)
const exploreError = ref('')
const documentQuestion = ref('')
const documentQuestionError = ref('')
const aiAvailable = ref(false)
const visionAvailable = ref(false)
const selectedAnchor = ref<{ termId: string; blockId: string; startOffset: number; endOffset: number; text: string } | null>(null)
const expandedSections = ref(new Set<string>())
const activeBlockId = ref('')
const searchText = ref('')
const libraryLoading = ref(true)
const readerLoading = ref(false)
const libraryError = ref('')
const readerError = ref('')
const importing = ref(false)
const importProgress = ref(0)
const importMessage = ref('')
const importFailures = ref<Array<{ name: string; message: string }>>([])
const reparsing = ref(false)
const notice = ref('')
const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const leftDrawerOpen = ref(false)
const rightDrawerOpen = ref(false)
const providerSettingsOpen = ref(false)
const draggingFiles = ref(false)
const readerScroller = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const annotationLayer = ref<InstanceType<typeof AnnotationLayer> | null>(null)
const annotationTool = ref<AnnotationTool>('pointer')
const highlightedAnnotationId = ref('')
const annotationSelection = ref<{
  annotationId: string
  blockIds: string[]
  selectedText: string
  imageRefs: Array<{ blockId: string; assetId: string }>
  imageRegions: Array<{ blockId: string; points: Array<{ x: number; y: number }> }>
  clientX: number
  clientY: number
} | null>(null)
const selectionQuestion = ref('')
const selectionQuestionOpen = ref(false)
const selectionError = ref('')
const viewportWidth = ref(1280)

let viewRequest = 0
let saveTimer = 0
let exploreSaveTimer = 0
let noticeTimer = 0
let dragDepth = 0
let disposed = false
let blockObserver: IntersectionObserver | null = null
let importGeneration = 0

const activeDocument = computed(() => documents.value.find(item => item.id === activeDocumentId.value) ?? null)
const blocksById = computed(() => new Map(blocks.value.map(block => [block.id, block])))
const filteredDocuments = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase()
  return query ? documents.value.filter(item => `${item.title} ${item.name} ${item.format}`.toLocaleLowerCase().includes(query)) : documents.value
})

function sectionChildren(items: Section[]) {
  const seen = new Set<string>()
  return [...items].filter(item => {
    if (!item?.id || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  }).sort((a, b) => (a.displayOrder ?? a.order ?? a.sourceOrder ?? 0) - (b.displayOrder ?? b.order ?? b.sourceOrder ?? 0))
}

const allSections = computed<FlatSection[]>(() => {
  const result: FlatSection[] = []
  const visited = new Set<string>()
  const visit = (items: Section[], depth: number, ancestors: string[]) => {
    for (const section of sectionChildren(items)) {
      if (visited.has(section.id)) continue
      visited.add(section.id)
      const item = { ...section, depth, ancestors }
      result.push(item)
      visit(section.children ?? [], depth + 1, [...ancestors, section.id])
    }
  }
  visit(sections.value, 0, [])
  return result
})

const visibleSections = computed(() => allSections.value.filter(section => section.ancestors.every(id => expandedSections.value.has(id))))
const orderedBlocks = computed(() => {
  const seenIds = new Set<string>()
  const seenSourceKeys = new Set<string>()
  return blocks.value
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => {
      if (!block.id || seenIds.has(block.id)) return false
      seenIds.add(block.id)
      const sourceKey = block.sourceBlockKey ? `${block.documentVersionId ?? activeDocument.value?.activeVersionId ?? ''}:${block.sourceBlockKey}` : ''
      if (sourceKey && seenSourceKeys.has(sourceKey)) return false
      if (sourceKey) seenSourceKeys.add(sourceKey)
      return true
    })
    .sort((a, b) => (a.block.sourceOrder ?? a.block.order ?? a.index) - (b.block.sourceOrder ?? b.block.order ?? b.index) || a.index - b.index)
    .map(item => item.block)
})

const readerEntries = computed<ReaderEntry[]>(() => {
  const sectionById = new Map(allSections.value.map(section => [section.id, section]))
  const emittedSections = new Set<string>()
  const entries: ReaderEntry[] = []
  const title = normalizeHeading(activeDocument.value?.title ?? '')
  let docTitleBlockId = ''
  for (const block of orderedBlocks.value) {
    const text = blockText(block)
    const section = block.sectionId ? sectionById.get(block.sectionId) : undefined
    const isDocumentTitle = isHeading(block) && Boolean(title) && normalizeHeading(text) === title
    let sectionHeadingBlock = false
    if (section) for (const ancestorId of section.ancestors) {
      const ancestor = sectionById.get(ancestorId)
      if (ancestor && !emittedSections.has(ancestorId)) {
        emittedSections.add(ancestorId)
        entries.push({ kind: 'section', section: ancestor })
      }
    }
    if (section && !emittedSections.has(section.id)) {
      emittedSections.add(section.id)
      sectionHeadingBlock = isHeading(block) && normalizeHeading(text) === normalizeHeading(section.title)
      if (!(sectionHeadingBlock && isDocumentTitle)) entries.push({ kind: 'section', section, blockId: sectionHeadingBlock ? block.id : undefined })
    }
    if (!docTitleBlockId && isDocumentTitle) {
      docTitleBlockId = block.id
      continue
    }
    if (sectionHeadingBlock) continue
    entries.push({ kind: 'block', block })
  }
  const emptySections = allSections.value.filter(section => !emittedSections.has(section.id))
  for (const section of emptySections) entries.push({ kind: 'section', section })
  return entries
})

const documentTitleBlockId = computed(() => orderedBlocks.value.find(block => isHeading(block) && normalizeHeading(blockText(block)) === normalizeHeading(activeDocument.value?.title ?? ''))?.id ?? '')
const activeFormat = computed(() => activeDocument.value?.format?.toUpperCase() || activeDocument.value?.name.split('.').pop()?.toUpperCase() || 'DOC')
const parseWarningText = computed(() => {
  const warnings = Array.isArray(parseMetadata.value.warnings) ? parseMetadata.value.warnings.map(value => String(value)).join('；') : ''
  return warnings || (parseMetadata.value.readingOrderWarning ? '阅读顺序可能不准。' : '')
})
const annotationMenuStyle = computed(() => {
  const selection = annotationSelection.value
  if (!selection) return {}
  if (viewportWidth.value <= 767) return { left: '12px', right: '12px', width: 'auto', top: 'auto', bottom: '12px' }
  const width = 360
  const height = selectionQuestionOpen.value ? 330 : 280
  const left = Math.max(12, Math.min(selection.clientX + 16, window.innerWidth - width - 12))
  const top = Math.max(76, Math.min(selection.clientY + 16, window.innerHeight - height - 12))
  return { left: `${left}px`, top: `${top}px` }
})
const mentionsByBlock = computed(() => {
  const result = new Map<string, Array<{ term: Term; start: number; end: number; text: string }>>()
  for (const term of terms.value) {
    for (const mention of term.occurrences ?? []) {
      if (mention.displayMode === 'hover' || mention.end <= mention.start) continue
      const values = result.get(mention.blockId) ?? []
      values.push({ term, start: mention.start, end: mention.end, text: term.canonicalText || term.text })
      result.set(mention.blockId, values)
    }
  }
  for (const values of result.values()) values.sort((a, b) => a.start - b.start || b.end - a.end)
  return result
})

function normalizeHeading(value: string) { return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase() }
function isHeading(block: ContentBlock) { return block.type === 'heading' || block.type === 'title' }
function blockText(block: ContentBlock) { return String(block.plainText ?? block.text ?? '') }
function textSegments(blockId: string, text: string, sourceStart = 0) {
  const matches = mentionsByBlock.value.get(blockId) ?? []
  const result: TextSegment[] = []
  let cursor = 0
  for (const match of matches) {
    const start = match.start - sourceStart
    const end = match.end - sourceStart
    if (start < cursor || end > text.length || start < 0 || text.slice(start, end).toLocaleLowerCase() !== match.text.toLocaleLowerCase()) continue
    if (start > cursor) result.push({ text: text.slice(cursor, start) })
    result.push({ text: text.slice(start, end), term: match.term, start: match.start, end: match.end,
      selected: selectedAnchor.value?.blockId === blockId && selectedAnchor.value.startOffset === match.start })
    cursor = end
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor) })
  const base = result.length ? result : [{ text }]
  const runs = blocksById.value.get(blockId)?.payload?.runs
  if (!Array.isArray(runs)) return base
  let runCursor = 0
  const ranges = runs.map(value => {
    const run = value as { text?: string; bold?: boolean; italic?: boolean; code?: boolean }
    const start = runCursor; runCursor += String(run.text ?? '').length
    return { ...run, start, end: runCursor }
  })
  let styleCursor = sourceStart
  return base.flatMap((segment): TextSegment[] => {
    const start = styleCursor; styleCursor += segment.text.length
    const overlaps = ranges.filter(run => run.end > start && run.start < styleCursor)
    if (!overlaps.length) return [segment]
    if (segment.term) return [{ ...segment, bold: overlaps.every(run => run.bold), italic: overlaps.every(run => run.italic), code: overlaps.every(run => run.code) }]
    return overlaps.map(run => ({ text: segment.text.slice(Math.max(start, run.start) - start, Math.min(styleCursor, run.end) - start), bold: run.bold, italic: run.italic, code: run.code }))
  })
}
function listTextSegments(block: ContentBlock, itemIndex: number): TextSegment[] {
  const items = listItems(block)
  const item = items[itemIndex] ?? ''
  const source = blockText(block)
  let cursor = 0
  for (const previous of items.slice(0, itemIndex)) {
    const position = source.indexOf(previous, cursor)
    if (position >= 0) cursor = position + previous.length
  }
  const start = source.indexOf(item, cursor)
  return start >= 0 ? textSegments(block.id, item, start) : [{ text: item }]
}
function formatBytes(size?: number) {
  if (!size || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
function sourceLabel(locator?: SourceLocator) {
  if (!locator) return '原文位置未提供'
  if (locator.slideNumber) return `幻灯片 ${locator.slideNumber}`
  if (locator.pageNumber) return `第 ${locator.pageNumber} 页`
  if (locator.lineStart) return locator.lineEnd && locator.lineEnd !== locator.lineStart ? `第 ${locator.lineStart}-${locator.lineEnd} 行` : `第 ${locator.lineStart} 行`
  if (locator.headingPath?.length) return locator.headingPath.join(' / ')
  if (locator.paragraphIndex !== undefined) return `段落 ${locator.paragraphIndex + 1}`
  return '原文位置未提供'
}
function payload(block: ContentBlock) { return block.payload ?? {} }
function assetId(block: ContentBlock) {
  const data = payload(block)
  const asset = data.asset && typeof data.asset === 'object' ? data.asset as Record<string, unknown> : {}
  const value = data.assetId ?? asset.id ?? asset.assetId
  return typeof value === 'string' && value.length ? value : ''
}
function imageDimensions(block: ContentBlock) {
  const width = Number(payload(block).width)
  const height = Number(payload(block).height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return {}
  return { width, height, style: { width: `${Math.min(width, 640 * width / height)}px`, aspectRatio: `${width} / ${height}` } }
}
function listItems(block: ContentBlock): string[] {
  const data = payload(block)
  const source = Array.isArray(data.items) ? data.items : Array.isArray(data.paragraphs) ? data.paragraphs : []
  const rows = source.map(item => {
    if (typeof item === 'string' || typeof item === 'number') return String(item)
    if (item && typeof item === 'object') return String((item as Record<string, unknown>).text ?? '')
    return ''
  }).filter(Boolean)
  return rows.length ? rows : blockText(block).split(/\r?\n/).filter(Boolean)
}
function tableRows(block: ContentBlock): string[][] {
  const rows = payload(block).rows
  return Array.isArray(rows) ? rows.map(row => Array.isArray(row) ? row.map(cell => {
    if (typeof cell === 'string' || typeof cell === 'number') return String(cell)
    if (cell && typeof cell === 'object') return String((cell as Record<string, unknown>).text ?? '')
    return ''
  }) : []) : []
}
function onAssetError(event: Event) {
  const image = event.currentTarget
  if (!(image instanceof HTMLImageElement)) return
  image.hidden = true
  const caption = image.parentElement?.querySelector('figcaption')
  if (caption) caption.textContent = '本地图片文件无法读取。'
}
function toggleSection(section: Section) {
  const next = new Set(expandedSections.value)
  if (next.has(section.id)) next.delete(section.id)
  else next.add(section.id)
  expandedSections.value = next
}
function jumpToSection(sectionId: string) {
  const firstBlock = orderedBlocks.value.find(block => block.sectionId === sectionId)
  const targetId = firstBlock ? `block-${firstBlock.id}` : `section-${sectionId}`
  document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (firstBlock) activeBlockId.value = firstBlock.id
  leftDrawerOpen.value = false
}
function jumpToBlock(blockId: string) {
  document.getElementById(`block-${blockId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  activeBlockId.value = blockId
  rightDrawerOpen.value = false
  saveExploreViewSoon()
}
async function jumpToSource(blockId: string, annotationId?: string) {
  const documentId = activeDocumentId.value
  if (!blocksById.value.has(blockId)) {
    try {
      const historical = await api.getBlock(blockId)
      if (activeDocumentId.value !== documentId) return
      const current = resolveSourceBlock(historical, blocks.value)
      if (!current) { notify('该引用属于历史解析版本，当前正文无法安全匹配原位置。'); return }
      blockId = current.id
      annotationId = undefined
      notify('已定位到当前版本中来源和内容一致的位置；旧标注仍保留在历史版本。')
    } catch (error) { notify(errorMessage(error)); return }
  }
  highlightedAnnotationId.value = annotationId ?? ''
  jumpToBlock(blockId)
  const target = document.getElementById(`block-${blockId}`)
  if (target) {
    target.classList.remove('citation-flash')
    void target.getBoundingClientRect()
    target.classList.add('citation-flash')
    window.setTimeout(() => target.classList.remove('citation-flash'), 1500)
  }
}
function saveViewSoon() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveViewNow(activeDocumentId.value)
  }, 180)
}
function saveViewNow(documentId: string) {
  if (!documentId) return
  api.saveReaderView({
      documentId,
      chatId: exploreChatId.value || undefined,
      activeBlockId: activeBlockId.value,
      expandedSections: [...expandedSections.value],
      scrollTop: readerScroller.value?.scrollTop ?? 0,
      leftCollapsed: leftCollapsed.value,
      rightCollapsed: rightCollapsed.value,
    })
}
function onPageHide() {
  saveViewNow(activeDocumentId.value)
  void saveExploreViewNow()
}
function saveExploreViewSoon() {
  window.clearTimeout(exploreSaveTimer)
  exploreSaveTimer = window.setTimeout(() => { void saveExploreViewNow() }, 180)
}
async function saveExploreViewNow() {
  if (!exploreChatId.value || !activeDocumentId.value) return
  try {
    const path = explorePath(activeExploreNodeId.value)
    await api.saveExploreState(exploreChatId.value, {
      activeNodeId: activeExploreNodeId.value || undefined,
      activeBlockId: selectedAnchor.value?.blockId || activeBlockId.value || undefined,
      textOffset: selectedAnchor.value?.startOffset,
      expandedNodes: [...expandedExploreNodes.value],
      floatingCards: { openNodeIds: path, activeCardId: activeExploreNodeId.value || undefined },
    })
  } catch (error) { exploreError.value = errorMessage(error) }
}
function explorePath(nodeId: string) {
  const path: string[] = []
  const seen = new Set<string>()
  let current: string | undefined = nodeId || undefined
  while (current && !seen.has(current)) {
    seen.add(current); path.unshift(current)
    current = exploreEdges.value.find(edge => edge.toNodeId === current && edge.kind !== 'related')?.fromNodeId
  }
  return path
}
function nodeAnchor(node?: ExploreNode) {
  return node?.sources?.find(source => source.role === 'anchor') ?? node?.sources?.[0]
}
function restoreAnchorForNode(node?: ExploreNode, blockId?: string, textOffset?: number) {
  if (node) {
    const anchor = nodeAnchor(node)
    const termId = typeof node.context?.termId === 'string' ? node.context.termId : ''
    const term = terms.value.find(item => item.id === termId)
    if (anchor && term) {
      const startOffset = anchor.startOffset ?? 0
      const endOffset = anchor.endOffset ?? startOffset + term.text.length
      selectedAnchor.value = { termId, blockId: anchor.blockId, startOffset, endOffset, text: anchor.quote || term.text }
      return
    }
    if (anchor) selectedAnchor.value = { termId: '', blockId: anchor.blockId, startOffset: anchor.startOffset ?? 0, endOffset: anchor.endOffset ?? 0, text: anchor.quote }
  } else if (blockId && textOffset !== undefined) {
    const term = terms.value.find(item => item.occurrences?.some(mention => mention.blockId === blockId && mention.start === textOffset))
    const mention = term?.occurrences?.find(item => item.blockId === blockId && item.start === textOffset)
    selectedAnchor.value = term && mention ? { termId: term.id, blockId, startOffset: mention.start, endOffset: mention.end, text: term.text } : null
  } else selectedAnchor.value = null
}
async function refreshModelAvailability() {
  try {
    const profiles = await api.listProviderProfiles()
    const selected = profiles.profiles.find(profile => profile.id === profiles.activeId) ?? profiles.profiles.find(profile => profile.active)
    aiAvailable.value = Boolean(selected?.model && (selected.hasApiKey || selected.protocol === 'ollama-chat'))
    visionAvailable.value = Boolean(selected?.supportsVision)
  } catch { aiAvailable.value = false; visionAvailable.value = false }
}
async function loadExploration(documentId: string, requestId: number, preferredChatId?: string) {
  exploreLoading.value = true
  exploreError.value = ''
  exploreChatId.value = ''
  exploreNodes.value = []; exploreEdges.value = []; activeExploreNodeId.value = ''; expandedExploreNodes.value = new Set(); selectedAnchor.value = null
  try {
    const chats = await api.listChats(documentId)
    let chat = chats.find(item => item.chatId === preferredChatId) ?? chats[0]
    if (!chat) chat = await api.createChat({ documentId })
    if (disposed || requestId !== viewRequest) return
    exploreChatId.value = chat.chatId
    const [graph, saved] = await Promise.all([api.getGraph(documentId, chat.chatId), api.getExploreState(chat.chatId)])
    if (disposed || requestId !== viewRequest) return
    exploreNodes.value = graph.nodes
    exploreEdges.value = graph.edges
    const ids = new Set(graph.nodes.map(node => node.nodeId || node.id))
    activeExploreNodeId.value = saved?.activeNodeId && ids.has(saved.activeNodeId) ? saved.activeNodeId : ''
    expandedExploreNodes.value = new Set((saved?.expandedNodes ?? []).filter(id => ids.has(id)))
    for (const id of explorePath(activeExploreNodeId.value)) expandedExploreNodes.value.add(id)
    const active = graph.nodes.find(node => (node.nodeId || node.id) === activeExploreNodeId.value)
    restoreAnchorForNode(active, saved?.activeBlockId, saved?.textOffset)
    await refreshModelAvailability()
  } catch (error) { if (requestId === viewRequest) exploreError.value = errorMessage(error) }
  finally { if (requestId === viewRequest) exploreLoading.value = false }
}
async function refreshExplore(preferredNodeId?: string) {
  const documentId = activeDocumentId.value
  const chatId = exploreChatId.value
  const requestId = viewRequest
  if (!documentId || !chatId) return
  const graph = await api.getGraph(documentId, chatId)
  if (disposed || requestId !== viewRequest || chatId !== exploreChatId.value) return
  exploreNodes.value = graph.nodes
  exploreEdges.value = graph.edges
  const ids = new Set(graph.nodes.map(node => node.nodeId || node.id))
  activeExploreNodeId.value = preferredNodeId && ids.has(preferredNodeId) ? preferredNodeId : ids.has(activeExploreNodeId.value) ? activeExploreNodeId.value : ''
  for (const id of explorePath(activeExploreNodeId.value)) expandedExploreNodes.value.add(id)
  restoreAnchorForNode(graph.nodes.find(node => (node.nodeId || node.id) === activeExploreNodeId.value))
  await saveExploreViewNow()
}
function activateExploreNode(nodeId: string) {
  activeExploreNodeId.value = nodeId
  const node = exploreNodes.value.find(item => (item.nodeId || item.id) === nodeId)
  restoreAnchorForNode(node)
  highlightedAnnotationId.value = typeof node?.context?.annotationId === 'string' ? node.context.annotationId : ''
  for (const id of explorePath(nodeId)) expandedExploreNodes.value.add(id)
  const anchor = nodeAnchor(node)
  if (anchor?.blockId) jumpToBlock(anchor.blockId)
  if (window.innerWidth <= 1199) rightDrawerOpen.value = true
  saveExploreViewSoon()
}
function toggleExploreNode(nodeId: string) {
  const next = new Set(expandedExploreNodes.value)
  if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId)
  expandedExploreNodes.value = next
  saveExploreViewSoon()
}
async function createManualNote(parentNodeId?: string, anchorOverride?: { blockId: string; startOffset?: number; endOffset?: number; text?: string }, term?: Term) {
  const documentId = activeDocumentId.value
  if (!documentId || !exploreChatId.value) { notify('请先导入并打开一份文档，再创建本地笔记。'); return }
  const parent = exploreNodes.value.find(node => (node.nodeId || node.id) === parentNodeId)
  const anchorSource = nodeAnchor(parent)
  const anchor = anchorOverride ?? (selectedAnchor.value ? { ...selectedAnchor.value } : anchorSource ? { blockId: anchorSource.blockId, startOffset: anchorSource.startOffset, endOffset: anchorSource.endOffset, text: anchorSource.quote } : undefined)
  const title = term?.canonicalText || term?.text || anchor?.text?.slice(0, 80) || '学习笔记'
  const payload: Record<string, unknown> = { documentId, chatId: exploreChatId.value, parentNodeId, kind: 'note', title, context: { origin: 'local', noteKind: 'manual', termId: term?.id, termText: term?.text } }
  if (anchor?.blockId) Object.assign(payload, { sourceBlockId: anchor.blockId, selectedText: anchor.text, startOffset: anchor.startOffset, endOffset: anchor.endOffset })
  exploreBusy.value = true
  exploreError.value = ''
  try {
    const node = await api.createNode(payload)
    await api.updateNode(node.nodeId || node.id, { answer: '' })
    await refreshExplore(node.nodeId || node.id)
    notify('已创建本地笔记，可以直接编辑内容')
  } catch (error) { exploreError.value = errorMessage(error) }
  finally { exploreBusy.value = false }
}
async function openTerm(term: Term, blockId: string, startOffset: number, endOffset: number, element?: HTMLElement, parentNodeId?: string) {
  const selected = { termId: term.id, blockId, startOffset, endOffset, text: term.text }
  selectedAnchor.value = selected
  activeBlockId.value = blockId
  if (element) element.classList.add('selected')
  if (window.innerWidth <= 1199) rightDrawerOpen.value = true
  const existing = exploreNodes.value.find(node => node.context?.termId === term.id && (node.parentNodeId ?? '') === (parentNodeId ?? '') && node.sources?.some(source => source.role === 'anchor' && source.blockId === blockId && source.startOffset === startOffset))
  if (existing) { activateExploreNode(existing.nodeId || existing.id); return }
  if (!aiAvailable.value) {
    await createManualNote(parentNodeId, selected, term)
    return
  }
  exploreBusy.value = true
  exploreError.value = ''
  try {
    let node: ExploreNode
    if (term.definition) {
      node = await api.createNode({ documentId: activeDocumentId.value, chatId: exploreChatId.value, parentNodeId, kind: 'explanation', title: term.text, termId: term.id, sourceBlockId: blockId, startOffset, endOffset, selectedText: term.text, context: { termId: term.id, termText: term.text, origin: term.kind === 'source' ? 'source' : 'ai' } })
    } else {
      const result = await api.ask({ documentId: activeDocumentId.value, chatId: exploreChatId.value, parentNodeId, question: `请解释术语「${term.text}」，优先引用文档中的定义和证据。`, selectedText: term.text, anchor: { blockId, startOffset, endOffset }, branchKind: parentNodeId ? 'deepens' : undefined })
      if (!result.node) throw new Error('模型没有创建探索节点。')
      node = result.node
    }
    await refreshExplore(node.nodeId || node.id)
  } catch (error) { exploreError.value = errorMessage(error); notify(errorMessage(error)) }
  finally { exploreBusy.value = false }
}
function openTermFromCard(term: Term, parentNodeId: string) {
  const parent = exploreNodes.value.find(node => (node.nodeId || node.id) === parentNodeId)
  const anchor = nodeAnchor(parent)
  const occurrence = term.occurrences?.find(item => item.blockId === anchor?.blockId) ?? term.occurrences?.[0]
  if (occurrence) void openTerm(term, occurrence.blockId, occurrence.start, occurrence.end, undefined, parentNodeId)
  else if (anchor) void openTerm(term, anchor.blockId, anchor.startOffset ?? 0, anchor.endOffset ?? (anchor.startOffset ?? 0) + term.text.length, undefined, parentNodeId)
}
async function exploreFromCard(nodeId: string, question: string, kind: 'deepens' | 'related' | 'branch' | 'qa') {
  if (!aiAvailable.value) { notify('请先配置并启用模型，再使用 AI 深挖、关联或分叉。'); providerSettingsOpen.value = true; return }
  const node = exploreNodes.value.find(item => (item.nodeId || item.id) === nodeId)
  if (!node) return
  const source = nodeAnchor(node) ?? node.sources?.find(item => item.role === 'evidence')
  exploreBusy.value = true
  exploreError.value = ''
  try {
    const result = await api.ask({ documentId: activeDocumentId.value, chatId: exploreChatId.value, parentNodeId: nodeId, question, branchKind: kind === 'qa' ? 'deepens' : kind, selectedText: source?.quote, anchor: source ? { blockId: source.blockId, startOffset: source.startOffset, endOffset: source.endOffset } : undefined })
    if (!result.node) throw new Error('模型没有创建探索节点。')
    await refreshExplore(result.node.nodeId || result.node.id)
  } catch (error) { exploreError.value = errorMessage(error); notify(errorMessage(error)) }
  finally { exploreBusy.value = false }
}
async function askDocument() {
  if (exploreBusy.value || readerLoading.value || exploreLoading.value || !activeDocument.value || !exploreChatId.value) return
  if (!aiAvailable.value) { providerSettingsOpen.value = true; return }
  const question = documentQuestion.value.trim()
  if (!question) return
  const documentId = activeDocumentId.value
  const chatId = exploreChatId.value
  const requestId = viewRequest
  const draft = documentQuestion.value
  exploreBusy.value = true
  documentQuestionError.value = ''
  try {
    const result = await api.ask({ documentId, chatId, question })
    if (disposed || requestId !== viewRequest) return
    if (!result.node) throw new Error('模型没有创建探索节点，请重试。')
    await refreshExplore(result.node.nodeId || result.node.id)
    if (requestId === viewRequest && documentQuestion.value === draft) documentQuestion.value = ''
  } catch (error) {
    if (requestId === viewRequest) documentQuestionError.value = errorMessage(error)
  } finally {
    if (requestId === viewRequest) exploreBusy.value = false
  }
}
async function saveManualNote(nodeId: string, title: string, answer: string) {
  try { await api.updateNode(nodeId, { title, answer }); await refreshExplore(nodeId) }
  catch (error) { exploreError.value = errorMessage(error); notify(errorMessage(error)) }
}
async function deleteExploreBranch(nodeId: string) {
  const node = exploreNodes.value.find(item => (item.nodeId || item.id) === nodeId)
  if (!node || !window.confirm(`删除「${node.title}」及其全部子分支？`)) return
  const parent = exploreEdges.value.find(edge => edge.toNodeId === nodeId && edge.kind !== 'related')?.fromNodeId
  try {
    await api.deleteNode(nodeId)
    await refreshExplore(parent)
  } catch (error) { exploreError.value = errorMessage(error) }
}
function onAnnotationSelection(selection: NonNullable<typeof annotationSelection.value>) {
  annotationSelection.value = selection
  selectionQuestion.value = ''
  selectionQuestionOpen.value = false
  selectionError.value = ''
}
function closeAnnotationMenu() {
  annotationSelection.value = null
  selectionQuestion.value = ''
  selectionQuestionOpen.value = false
  selectionError.value = ''
}
function clearDocumentAnnotations() {
  if (!activeDocumentId.value) return
  if (window.confirm('清除当前文档的全部标注？此操作无法撤销。')) void annotationLayer.value?.clear()
}
async function submitAnnotationQuestion(action: 'explain' | 'ask' | 'card') {
  const selection = annotationSelection.value
  if (!selection || !activeDocumentId.value || !exploreChatId.value) return
  if (!aiAvailable.value) {
    selectionError.value = '请先配置并启用模型，再使用 AI 圈选操作。'
    return
  }
  if (selection.imageRefs.length && !visionAvailable.value) {
    selectionError.value = '当前启用的模型没有视觉能力，无法提问圈选图片。请在模型设置中启用视觉能力并确认模型支持图片输入。'
    return
  }
  const question = action === 'explain'
    ? '解释这段圈选内容，优先依据文档证据；证据不足时请明确说明。'
    : action === 'card'
      ? '根据这段圈选内容生成一张探索卡片，概括核心概念、解释关系并指出前置知识；严格依据文档，证据不足时请明确说明。'
      : selectionQuestion.value.trim()
  if (!question) { selectionQuestionOpen.value = true; selectionError.value = '写下你想针对这段内容了解的问题。'; return }
  const sourceBlockId = selection.blockIds[0]
  if (!sourceBlockId) { selectionError.value = '圈选区域没有覆盖可定位的文档内容。'; return }
  const parentNodeId = activeExploreNodeId.value || undefined
  const selectionContext = selection.blockIds.map(id => {
    const block = blocks.value.find(item => item.id === id)
    const text = block ? blockText(block).trim() : ''
    return text ? `[${sourceLabel(block?.locator ?? block?.sourceLocator)}] ${text}` : ''
  }).filter(Boolean).join('\n\n')
  exploreBusy.value = true
  selectionError.value = ''
  exploreError.value = ''
  try {
    const result = await api.ask({
      documentId: activeDocumentId.value,
      chatId: exploreChatId.value,
      parentNodeId,
      branchKind: parentNodeId ? 'deepens' : undefined,
      question,
      selectedText: selection.selectedText,
      anchor: { blockId: sourceBlockId },
      images: selection.imageRefs,
      context: {
        annotationId: selection.annotationId,
        selectionBlockIds: selection.blockIds,
        selectionContext,
        imageRegions: selection.imageRegions,
        selectionTargets: selection.imageRegions,
        interaction: 'lasso',
      },
    })
    if (!result.node) throw new Error('模型没有创建探索节点。')
    const nodeId = result.node.nodeId || result.node.id
    await refreshExplore(nodeId)
    highlightedAnnotationId.value = selection.annotationId
    closeAnnotationMenu()
    notify('已将圈选内容加入探索树，并保存了原文位置。')
  } catch (error) {
    const message = errorMessage(error)
    selectionError.value = message
    exploreError.value = message
  } finally { exploreBusy.value = false }
}
function onReaderScroll() {
  if (!readerScroller.value) return
  const candidates = readerScroller.value.querySelectorAll<HTMLElement>('[data-block-id]')
  const top = readerScroller.value.getBoundingClientRect().top + 120
  let nearest: HTMLElement | null = null
  for (const element of candidates) {
    if (element.getBoundingClientRect().bottom >= top) { nearest = element; break }
  }
  if (nearest?.dataset.blockId) activeBlockId.value = nearest.dataset.blockId
  saveViewSoon()
}
function observeBlocks() {
  blockObserver?.disconnect()
  const root = readerScroller.value
  if (!root || typeof IntersectionObserver === 'undefined') return
  blockObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
    const id = (visible[0]?.target as HTMLElement | undefined)?.dataset.blockId
    if (id) { activeBlockId.value = id; saveViewSoon() }
  }, { root, rootMargin: '-10% 0px -76% 0px', threshold: 0 })
  root.querySelectorAll<HTMLElement>('[data-block-id]').forEach(element => blockObserver?.observe(element))
}

async function loadLibrary() {
  libraryLoading.value = true
  libraryError.value = ''
  try {
    documents.value = await api.listDocuments()
    const savedId = api.getReaderView().documentId
    const selected = documents.value.find(item => item.id === activeDocumentId.value)?.id
      ?? documents.value.find(item => item.id === savedId)?.id
      ?? ''
    if (selected) await openDocument(selected)
    else if (!documents.value.length) { activeDocumentId.value = ''; sections.value = []; blocks.value = [] }
  } catch (error) { libraryError.value = errorMessage(error) }
  finally { libraryLoading.value = false }
}

async function openDocument(documentId: string) {
  if (!documentId || (readerLoading.value && documentId === activeDocumentId.value)) return
  const previousId = activeDocumentId.value
  if (previousId && previousId !== documentId) {
    window.clearTimeout(saveTimer)
    saveViewNow(previousId)
    void saveExploreViewNow()
  }
  const requestId = ++viewRequest
  documentQuestion.value = ''
  documentQuestionError.value = ''
  exploreBusy.value = false
  activeDocumentId.value = documentId
  exploreChatId.value = ''
  readerLoading.value = true
  readerError.value = ''
  blockObserver?.disconnect()
  try {
    const [tree, nextBlocks, nextTerms] = await Promise.all([api.getTree(documentId), api.getBlocks(documentId), api.getTerms(documentId)])
    if (disposed || requestId !== viewRequest || activeDocumentId.value !== documentId) return
    sections.value = tree.sections ?? tree.tree ?? []
    parseMetadata.value = tree.metadata ?? {}
    blocks.value = nextBlocks
    terms.value = nextTerms
    const saved = api.getReaderView(documentId)
    leftCollapsed.value = Boolean(saved.leftCollapsed)
    rightCollapsed.value = Boolean(saved.rightCollapsed)
    const allIds = new Set<string>()
    const gather = (items: Section[]) => items.forEach(item => { allIds.add(item.id); gather(item.children ?? []) })
    gather(sections.value)
    expandedSections.value = new Set((saved.expandedSections ?? [...allIds]).filter(id => allIds.has(id)))
    activeBlockId.value = saved.activeBlockId ?? ''
    await loadExploration(documentId, requestId, saved.chatId)
    await nextTick()
    if (requestId !== viewRequest) return
    if (readerScroller.value) readerScroller.value.scrollTop = saved.scrollTop ?? 0
    await nextTick()
    observeBlocks()
    if (activeBlockId.value && !saved.scrollTop) jumpToBlock(activeBlockId.value)
  } catch (error) {
    if (requestId === viewRequest) readerError.value = errorMessage(error)
  } finally { if (requestId === viewRequest) readerLoading.value = false }
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : '本地服务暂时无法完成请求。' }
function notify(message: string) {
  notice.value = message
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { notice.value = '' }, 3000)
}
function jobFailure(job: ImportJob) {
  const error = job.error
  if (typeof error === 'string') return error
  if (error?.message) return error.message
  return job.message || '任务失败。'
}
async function waitForJob(jobId: string, generation: number, onProgress?: (job: ImportJob) => void) {
  const started = Date.now()
  let job = await api.getImport(jobId)
  while (!['completed', 'failed', 'cancelled'].includes(job.status)) {
    if (disposed || generation !== importGeneration) return job
    onProgress?.(job)
    if (Date.now() - started > 30 * 60 * 1000) throw new Error('任务仍在后台运行。稍后刷新文档列表查看结果。')
    await new Promise(resolve => window.setTimeout(resolve, 650))
    job = await api.getImport(jobId)
  }
  onProgress?.(job)
  return job
}
async function importFiles(input: FileList | File[]) {
  const files = [...input]
  if (!files.length || importing.value || reparsing.value) return
  importing.value = true
  importProgress.value = 0
  importMessage.value = `正在上传 ${files.length} 个文件`
  importFailures.value = []
  const generation = ++importGeneration
  const selectedBefore = activeDocumentId.value
  try {
    const started = await api.startImport(files)
    const ids = started.jobIds?.length ? started.jobIds : started.jobId ? [started.jobId] : []
    if (!ids.length) throw new Error('本地服务未返回导入任务编号。')
    const jobs = await Promise.all(ids.map(jobId => waitForJob(jobId, generation, job => {
      importProgress.value = Math.max(importProgress.value, Math.min(99, job.progress ?? 0))
      importMessage.value = job.message ?? '正在解析文档'
    })))
    const failures = jobs.flatMap(job => job.errors ?? [])
    for (const job of jobs) if (job.status !== 'completed' && !job.errors?.length) failures.push({ name: '导入任务', message: jobFailure(job) })
    importFailures.value = failures
    const added = jobs.flatMap(job => job.documents ?? []).map(item => String(item.id ?? item.documentId ?? '')).filter(Boolean)
    await loadLibrary()
    importProgress.value = 100
    importMessage.value = failures.length ? '导入结束，部分文件未能处理' : '导入完成'
    if (!failures.length) notify(jobs.some(job => job.documents?.some(item => item.duplicate)) ? '文档已存在，未重复建库' : `已导入 ${added.length || files.length} 个文件`)
    else notify(`导入完成，${failures.length} 个文件需要检查`)
    if (added[0] && activeDocumentId.value === selectedBefore) await openDocument(added[0])
  } catch (error) {
    importFailures.value = [{ name: '导入任务', message: errorMessage(error) }]
    importMessage.value = '导入失败'
  } finally { importing.value = false }
}
async function reparseDocument() {
  const documentId = activeDocumentId.value
  if (!documentId || reparsing.value || importing.value) return
  reparsing.value = true
  importProgress.value = 0
  importMessage.value = '等待重新解析文档'
  readerError.value = ''
  try {
    const { jobId } = await api.reparseDocument(documentId)
    const generation = ++importGeneration
    const job = await waitForJob(jobId, generation, value => { importMessage.value = value.message ?? '正在重新解析'; importProgress.value = value.progress ?? 0 })
    if (job.status !== 'completed') throw new Error(jobFailure(job))
    await loadLibrary()
    if (activeDocumentId.value === documentId) await openDocument(documentId)
    notify('重新解析完成')
  } catch (error) { readerError.value = errorMessage(error) }
  finally { reparsing.value = false }
}
function onFileInput(event: Event) {
  const target = event.currentTarget
  if (target instanceof HTMLInputElement) { void importFiles(target.files ?? []); target.value = '' }
}
function onDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault(); dragDepth += 1; draggingFiles.value = true
}
function onDragLeave(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) draggingFiles.value = false
}
function onDrop(event: DragEvent) {
  if (!event.dataTransfer?.files.length) return
  event.preventDefault(); dragDepth = 0; draggingFiles.value = false; void importFiles(event.dataTransfer.files)
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeAnnotationMenu()
    leftDrawerOpen.value = false
    rightDrawerOpen.value = false
    draggingFiles.value = false
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector<HTMLInputElement>('#document-search')?.focus() }
}
function onViewportResize() { viewportWidth.value = window.innerWidth }
function restorePanels() {
  leftCollapsed.value = !leftCollapsed.value
  saveViewSoon()
}
function restoreRightPanel() {
  rightCollapsed.value = !rightCollapsed.value
  saveViewSoon()
}

watch([activeBlockId, expandedSections, leftCollapsed, rightCollapsed], saveViewSoon, { deep: true })
watch([activeExploreNodeId, expandedExploreNodes, selectedAnchor], saveExploreViewSoon, { deep: true })
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('resize', onViewportResize, { passive: true })
  onViewportResize()
  await loadLibrary()
  const saved = activeDocumentId.value ? api.getReaderView(activeDocumentId.value) : {}
  leftCollapsed.value = Boolean(saved.leftCollapsed)
  rightCollapsed.value = Boolean(saved.rightCollapsed)
})
onUnmounted(() => {
  disposed = true
  viewRequest += 1
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pagehide', onPageHide)
  window.removeEventListener('resize', onViewportResize)
  void saveExploreViewNow()
  window.clearTimeout(saveTimer); window.clearTimeout(exploreSaveTimer); window.clearTimeout(noticeTimer)
  blockObserver?.disconnect()
})
</script>

<template>
  <div class="app-shell" :class="{ 'left-collapsed': leftCollapsed, 'right-collapsed': rightCollapsed }" @dragenter="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop="onDrop">
    <header class="topbar">
      <div class="brand-lockup">
        <button class="icon-button mobile-menu" aria-label="打开文档目录" @click="leftDrawerOpen = true"><Menu :size="18" /></button>
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <strong>DeckLens</strong>
      </div>
      <label class="global-search">
        <Search :size="16" aria-hidden="true" />
        <input id="document-search" v-model="searchText" aria-label="搜索文档名称" placeholder="搜索文档" />
        <kbd>Ctrl K</kbd>
      </label>
      <div class="top-actions">
        <span class="local-status"><i></i>仅本机</span>
        <button class="icon-button desktop-toggle" :aria-label="leftCollapsed ? '展开目录' : '收起目录'" :title="leftCollapsed ? '展开目录' : '收起目录'" @click="restorePanels"><PanelLeftOpen v-if="leftCollapsed" :size="18" /><PanelLeftClose v-else :size="18" /></button>
        <button class="icon-button desktop-toggle" :aria-label="rightCollapsed ? '展开探索面板' : '收起探索面板'" :title="rightCollapsed ? '展开探索面板' : '收起探索面板'" @click="restoreRightPanel"><PanelRightOpen v-if="rightCollapsed" :size="18" /><PanelRightClose v-else :size="18" /></button>
        <button class="icon-button mobile-explore" aria-label="打开探索面板" @click="rightDrawerOpen = true"><PanelRightOpen :size="18" /></button>
        <button class="icon-button" aria-label="模型供应商设置" title="模型供应商设置" @click="providerSettingsOpen = true"><Settings2 :size="18" /></button>
      </div>
    </header>

    <div v-if="importing || reparsing" class="job-banner" role="status" aria-live="polite">
      <span class="progress-track"><i :style="{ width: `${importProgress}%` }"></i></span>
      <span>{{ importMessage }}<template v-if="importProgress"> · {{ importProgress }}%</template></span>
    </div>

    <div class="workspace">
      <aside class="left-rail" :class="{ 'drawer-open': leftDrawerOpen }" aria-label="文档和目录">
        <div class="rail-heading">
          <div><p class="eyebrow">LIBRARY</p><h1>文档</h1></div>
          <button class="icon-button mobile-close" aria-label="关闭目录" @click="leftDrawerOpen = false"><X :size="17" /></button>
        </div>
        <button class="import-button" :disabled="importing || reparsing" @click="fileInput?.click()"><FilePlus2 :size="17" /><span>导入文档</span></button>
        <input ref="fileInput" class="visually-hidden" type="file" multiple accept=".pptx,.docx,.pdf,.md,.markdown,.txt" @change="onFileInput" />

        <div class="document-list" aria-label="已导入文档">
          <button v-for="item in filteredDocuments" :key="item.id" class="document-row" :class="{ active: item.id === activeDocumentId }" :aria-current="item.id === activeDocumentId ? 'page' : undefined" @click="openDocument(item.id)">
            <FileText :size="17" class="doc-icon" />
            <span class="document-row-copy"><strong>{{ item.title || item.name }}</strong><small>{{ item.format.toUpperCase() }}<template v-if="item.sizeBytes"> · {{ formatBytes(item.sizeBytes) }}</template></small></span>
          </button>
          <p v-if="libraryLoading" class="muted-note">正在读取本机文档…</p>
          <div v-else-if="libraryError" class="inline-error" role="alert"><strong>无法读取文档库</strong><span>{{ libraryError }}</span><button class="secondary-button" @click="loadLibrary">重试</button></div>
          <div v-else-if="!filteredDocuments.length" class="empty-library"><BookOpen :size="20" /><strong>{{ documents.length ? '没有匹配的文档' : '从一份文档开始' }}</strong><span>{{ documents.length ? '调整搜索词，或清空搜索。' : '拖入 PDF、DOCX、PPTX、Markdown 或 TXT，原文会保存在本机。' }}</span></div>
        </div>

        <div class="rail-divider"></div>
        <div class="outline-heading"><h2>目录</h2><span>{{ allSections.length }}</span></div>
        <nav class="outline-tree" aria-label="文档章节目录">
          <button v-for="section in visibleSections" :key="section.id" class="outline-row" :class="{ current: orderedBlocks.some(block => block.id === activeBlockId && block.sectionId === section.id) }" :style="{ '--depth': section.depth }" :title="section.title" @click="jumpToSection(section.id)">
            <span class="outline-caret" @click.stop="section.children?.length && toggleSection(section)">
              <ChevronDown v-if="section.children?.length && expandedSections.has(section.id)" :size="14" />
              <ChevronRight v-else-if="section.children?.length" :size="14" />
              <i v-else></i>
            </span>
            <span>{{ section.title }}</span>
          </button>
          <p v-if="activeDocument && !allSections.length && !readerLoading" class="muted-note">文档没有可识别的章节。</p>
          <p v-else-if="!activeDocument && !libraryLoading" class="muted-note">导入文档后显示章节目录。</p>
        </nav>
        <div class="rail-footer"><span class="status-mark"></span><span>数据保存在本机</span></div>
      </aside>

      <main class="reader-column">
        <div class="reader-toolbar">
          <button class="icon-button mobile-menu" aria-label="打开目录" @click="leftDrawerOpen = true"><Menu :size="17" /></button>
          <div class="document-crumb"><span>文档库</span><ChevronRight :size="14" /><strong>{{ activeDocument?.title || activeDocument?.name || '阅读区' }}</strong></div>
          <button v-if="activeDocument" class="reparse-button" :disabled="reparsing || readerLoading || importing" @click="reparseDocument">{{ reparsing ? '重新解析中…' : '重新解析' }}</button>
        </div>

        <div v-if="activeDocument" class="annotation-toolbar" role="toolbar" aria-label="正文标注工具">
          <button class="annotation-tool-button" :class="{ active: annotationTool === 'pointer' }" :aria-pressed="annotationTool === 'pointer'" title="指针：滚动、选择文字并点击术语" @click="annotationTool = 'pointer'"><MousePointer2 :size="16" /><span>指针</span></button>
          <button class="annotation-tool-button" :class="{ active: annotationTool === 'pen' }" :aria-pressed="annotationTool === 'pen'" title="画笔：在正文上绘制笔迹" @click="annotationTool = 'pen'"><Pencil :size="16" /><span>画笔</span></button>
          <button class="annotation-tool-button" :class="{ active: annotationTool === 'highlighter' }" :aria-pressed="annotationTool === 'highlighter'" title="荧光笔：标记重点段落" @click="annotationTool = 'highlighter'"><Highlighter :size="16" /><span>荧光笔</span></button>
          <button class="annotation-tool-button" :class="{ active: annotationTool === 'eraser' }" :aria-pressed="annotationTool === 'eraser'" title="橡皮：擦除已保存的笔迹或圈选" @click="annotationTool = 'eraser'"><Eraser :size="16" /><span>橡皮</span></button>
          <button class="annotation-tool-button" :class="{ active: annotationTool === 'lasso' }" :aria-pressed="annotationTool === 'lasso'" title="套索：圈选正文或图片并发起探索" @click="annotationTool = 'lasso'"><Lasso :size="16" /><span>套索</span></button>
          <span class="annotation-toolbar-spacer"></span>
          <button class="annotation-clear-button" title="清除当前文档的全部标注" @click="clearDocumentAnnotations"><Trash2 :size="15" /><span>清除标注</span></button>
        </div>
        <div v-else class="annotation-toolbar annotation-toolbar-empty" aria-hidden="true"></div>

        <div v-if="importFailures.length" class="import-failures" role="alert">
          <div class="failure-heading"><strong>部分文件未能导入</strong><button class="icon-button tiny" aria-label="关闭导入错误" @click="importFailures = []"><X :size="15" /></button></div>
          <p v-for="(failure, index) in importFailures" :key="`${failure.name}-${index}`"><b>{{ failure.name }}</b>：{{ failure.message }}</p>
        </div>

        <div v-if="readerLoading" class="reader-scroll"><div class="reading-card loading-state" aria-live="polite"><span class="loading-rule"></span><p>正在读取文档结构…</p></div></div>
        <div v-else-if="readerError" class="reader-scroll"><div class="reading-card error-state" role="alert"><FileText :size="22" /><h2>文档暂时无法读取</h2><p>{{ readerError }}</p><button class="secondary-button" @click="activeDocumentId && openDocument(activeDocumentId)">重试</button></div></div>
        <div v-else-if="!activeDocument" class="reader-scroll"><section class="welcome-state"><span class="welcome-index">LOCAL READER</span><h2>从原文开始，<br /><em>把知识读清楚。</em></h2><p>导入 PDF、DOCX、PPTX、Markdown 或 TXT，DeckLens 会按原生结构生成可定位的阅读视图。</p><button class="primary-button" @click="fileInput?.click()"><FilePlus2 :size="17" />选择文档</button></section></div>
        <div v-else ref="readerScroller" class="reader-scroll" @scroll.passive="onReaderScroll">
          <article class="reading-card">
            <header class="document-intro">
              <div class="format-line"><span>{{ activeFormat }}</span><i></i><span>{{ activeDocument.language || '原文' }}</span></div>
              <h1 :id="documentTitleBlockId ? `block-${documentTitleBlockId}` : undefined" :data-block-id="documentTitleBlockId || undefined">{{ activeDocument.title || activeDocument.name }}</h1>
              <p>{{ allSections.length }} 个章节 · {{ orderedBlocks.length }} 个内容块</p>
              <p v-if="parseWarningText" class="status-note">解析提示：{{ parseWarningText }}</p>
              <p v-if="activeDocument.status && activeDocument.status !== 'ready'" class="status-note">文档状态：{{ activeDocument.status }}</p>
            </header>

            <div v-if="!orderedBlocks.length" class="empty-reading"><FileText :size="22" /><p>文件已导入，但没有可展示的内容块。</p><small>请检查文件是否为空、损坏或格式不受支持。</small></div>
            <template v-else>
              <template v-for="entry in readerEntries" :key="entry.kind === 'block' ? `block:${entry.block.id}` : `section:${entry.section.id}`">
                <component v-if="entry.kind === 'section'" :is="entry.section.depth && entry.section.depth > 0 ? 'h3' : 'h2'" :id="entry.blockId ? `block-${entry.blockId}` : `section-${entry.section.id}`" class="section-heading" :class="`level-${Math.min((entry.section.depth ?? entry.section.level ?? 0) + 1, 4)}`" :data-block-id="entry.blockId" :data-section-id="entry.section.id">{{ entry.section.title }}</component>
                <div v-else :id="`block-${entry.block.id}`" class="content-block" :class="`block-${entry.block.type}`" :data-block-id="entry.block.id" tabindex="-1">
                  <h3 v-if="isHeading(entry.block)" class="block-heading"><template v-for="(segment, index) in textSegments(entry.block.id, blockText(entry.block))" :key="index"><button v-if="segment.term" class="term-anchor" :class="{ selected: segment.selected, 'inline-bold': segment.bold, 'inline-italic': segment.italic, 'inline-code': segment.code }" @click.stop="openTerm(segment.term, entry.block.id, segment.start ?? 0, segment.end ?? 0, $event.currentTarget as HTMLElement)">{{ segment.text }}</button><span v-else :class="{ 'inline-bold': segment.bold, 'inline-italic': segment.italic, 'inline-code': segment.code }">{{ segment.text }}</span></template></h3>
                  <p v-else-if="['paragraph','text'].includes(entry.block.type)" class="reader-paragraph"><template v-for="(segment, index) in textSegments(entry.block.id, blockText(entry.block))" :key="index"><button v-if="segment.term" class="term-anchor" :class="{ selected: segment.selected, 'inline-bold': segment.bold, 'inline-italic': segment.italic, 'inline-code': segment.code }" @click.stop="openTerm(segment.term, entry.block.id, segment.start ?? 0, segment.end ?? 0, $event.currentTarget as HTMLElement)">{{ segment.text }}</button><span v-else :class="{ 'inline-bold': segment.bold, 'inline-italic': segment.italic, 'inline-code': segment.code }">{{ segment.text }}</span></template></p>
                  <component v-else-if="entry.block.type === 'list'" :is="payload(entry.block).ordered ? 'ol' : 'ul'" :start="payload(entry.block).ordered ? Number(payload(entry.block).start || 1) : undefined" class="reader-list"><li v-for="(item, index) in listItems(entry.block)" :key="`${entry.block.id}-${index}`"><template v-for="(segment, segmentIndex) in listTextSegments(entry.block, index)" :key="segmentIndex"><button v-if="segment.term" class="term-anchor" :class="{ selected: segment.selected, 'inline-bold': segment.bold, 'inline-italic': segment.italic, 'inline-code': segment.code }" @click.stop="openTerm(segment.term, entry.block.id, segment.start ?? 0, segment.end ?? 0, $event.currentTarget as HTMLElement)">{{ segment.text }}</button><span v-else :class="{ 'inline-bold': segment.bold, 'inline-italic': segment.italic, 'inline-code': segment.code }">{{ segment.text }}</span></template></li></component>
                  <div v-else-if="entry.block.type === 'table'" class="table-scroll"><table v-if="tableRows(entry.block).length"><tbody><tr v-for="(row, rowIndex) in tableRows(entry.block)" :key="rowIndex"><td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td></tr></tbody></table><p v-else class="reader-paragraph">{{ blockText(entry.block) }}</p></div>
                  <figure v-else-if="entry.block.type === 'image'" class="reader-image">
                    <img v-if="assetId(entry.block)" v-bind="imageDimensions(entry.block)" :src="api.getAssetUrl(assetId(entry.block))" :alt="String(payload(entry.block).alt ?? payload(entry.block).caption ?? '文档图片')" loading="lazy" decoding="async" @error="onAssetError" />
                    <figcaption>{{ String(payload(entry.block).caption ?? payload(entry.block).alt ?? (assetId(entry.block) ? '文档图片' : '图片未能从本地文档中提取。')) }}</figcaption>
                  </figure>
                  <pre v-else-if="entry.block.type === 'code'" class="code-block"><code>{{ blockText(entry.block) }}</code></pre>
                  <blockquote v-else-if="entry.block.type === 'note' || entry.block.type === 'formula'" class="note-block"><span>{{ entry.block.type === 'note' ? '备注' : '公式' }}</span><p>{{ blockText(entry.block) }}</p></blockquote>
                  <p v-else-if="blockText(entry.block)" class="reader-paragraph">{{ blockText(entry.block) }}</p>
                  <small class="source-marker">{{ sourceLabel(entry.block.locator ?? entry.block.sourceLocator) }}</small>
                </div>
              </template>
            </template>
            <div class="reading-endnote">阅读内容来自本地解析结果。原文位置以来源标注为准。</div>
            <AnnotationLayer
              ref="annotationLayer"
              :document-id="activeDocument.id"
              :version-id="activeDocument.activeVersionId || ''"
              :blocks="orderedBlocks"
              :tool="annotationTool"
              :highlight-annotation-id="highlightedAnnotationId"
              @selected="onAnnotationSelection"
              @notice="notify"
              @error="notify"
            />
          </article>
        </div>
      </main>

      <aside class="explore-column" :class="{ 'drawer-open': rightDrawerOpen }" aria-label="探索路径">
        <ExplorePanel :nodes="exploreNodes" :edges="exploreEdges" :terms="terms" :active-node-id="activeExploreNodeId" :expanded-node-ids="[...expandedExploreNodes]" :busy="exploreBusy" :ai-available="aiAvailable" :loading="exploreLoading" :error="exploreError" @activate="activateExploreNode" @toggle="toggleExploreNode" @delete-branch="deleteExploreBranch" @create-note="createManualNote" @ask="exploreFromCard" @save-note="saveManualNote" @cite="jumpToSource" @configure="providerSettingsOpen = true" @close="rightDrawerOpen = false" @term="openTermFromCard">
          <template #composer>
            <form class="explore-composer" aria-label="文档问答" :aria-busy="exploreBusy" @submit.prevent="askDocument">
              <label for="document-question">向文档提问</label>
              <div class="explore-composer-input">
                <input id="document-question" v-model="documentQuestion" :disabled="!activeDocument || !exploreChatId || readerLoading || exploreLoading || exploreBusy" :aria-describedby="documentQuestionError ? 'document-question-help document-question-error' : 'document-question-help'" :aria-invalid="Boolean(documentQuestionError)" :placeholder="activeDocument ? '输入文档问题…' : '请先打开一份文档'" @input="documentQuestionError = ''" @keydown.enter="($event.isComposing || $event.keyCode === 229) && $event.preventDefault()" />
                <button type="submit" :disabled="!activeDocument || !exploreChatId || readerLoading || exploreLoading || exploreBusy || (aiAvailable && !documentQuestion.trim())">{{ exploreBusy ? '生成中' : aiAvailable ? '提问' : '配置模型' }}</button>
              </div>
              <p id="document-question-help" role="status">{{ exploreBusy ? '正在生成回答…' : !activeDocument ? '打开文档后，可在这里提问。' : !aiAvailable ? '配置模型后即可提问。' : '基于当前文档回答，引用可跳回原文。' }}</p>
              <p v-if="documentQuestionError" id="document-question-error" class="explore-composer-error" role="alert">{{ documentQuestionError }}</p>
            </form>
          </template>
        </ExplorePanel>
      </aside>
    </div>

    <section v-if="annotationSelection" class="annotation-selection-menu" :style="annotationMenuStyle" aria-label="圈选内容操作">
      <header class="annotation-menu-heading"><div><strong>已圈选 {{ annotationSelection.blockIds.length }} 个内容块</strong><small>{{ annotationSelection.imageRefs.length ? '包含图片区域' : '原文上下文已完整提取' }}</small></div><button class="icon-button tiny" aria-label="关闭圈选菜单" @click="closeAnnotationMenu"><X :size="15" /></button></header>
      <p class="annotation-selection-excerpt">{{ annotationSelection.selectedText || '图片区域已绑定到本地原文，可由支持视觉的模型分析。' }}</p>
      <div class="annotation-menu-actions">
        <button class="annotation-action-primary" :disabled="exploreBusy" @click="submitAnnotationQuestion('explain')">解释这段</button>
        <button :disabled="exploreBusy" @click="selectionQuestionOpen = !selectionQuestionOpen; selectionError = ''">就这段提问</button>
        <button :disabled="exploreBusy" @click="submitAnnotationQuestion('card')">生成探索卡片</button>
      </div>
      <form v-if="selectionQuestionOpen" class="annotation-question-form" @submit.prevent="submitAnnotationQuestion('ask')">
        <label for="annotation-question">针对圈选内容提问</label>
        <div><input id="annotation-question" v-model="selectionQuestion" autocomplete="off" placeholder="写下你想了解的问题" /><button :disabled="exploreBusy || !selectionQuestion.trim()">提问</button></div>
      </form>
      <p v-if="annotationSelection.imageRefs.length && !visionAvailable" class="annotation-menu-message" role="alert">当前模型未启用视觉能力，图片相关操作不可用。</p>
      <p v-else-if="!aiAvailable" class="annotation-menu-message" role="status">配置模型后可使用 AI 圈选操作；标注和圈选记录仍会保存在本机。</p>
      <p v-if="selectionError" class="annotation-menu-error" role="alert">{{ selectionError }}<button v-if="!aiAvailable" class="text-button" @click="providerSettingsOpen = true">配置模型</button></p>
    </section>

    <div v-if="leftDrawerOpen || rightDrawerOpen" class="drawer-backdrop" @click="leftDrawerOpen = false; rightDrawerOpen = false"></div>
    <div v-if="draggingFiles" class="drop-overlay" aria-live="polite"><div><FilePlus2 :size="24" /><strong>松开以导入文档</strong><span>PDF · DOCX · PPTX · Markdown · TXT</span></div></div>
    <div v-if="notice" class="toast" role="status">{{ notice }}</div>
    <ProviderSettings v-if="providerSettingsOpen" @close="providerSettingsOpen = false; refreshModelAvailability()" />
  </div>
</template>
