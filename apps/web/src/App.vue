<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowUp, BookOpen, ChevronDown, ChevronRight, Eraser, FilePlus2, FileText, Folder, FolderPlus, Highlighter, Lasso, Menu, MousePointer2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pencil, Plus, Search, Settings2, Trash2, X } from '@lucide/vue'
import { api, type AnnotationTool, type ChatSummary, type ContentBlock, type DocumentSummary, type ExploreEdge, type ExploreNode, type FileFolder, type FileLibrary, type ImportJob, type ReaderViewState, type Section, type SourceLocator, type Term } from './api'
import AnnotationLayer from './components/AnnotationLayer.vue'
import ConversationPanel from './components/ConversationPanel.vue'
import ProviderSettings from './components/ProviderSettings.vue'
import LearningArticleSection from './components/LearningArticleSection.vue'
import CreateFolderDialog from './components/CreateFolderDialog.vue'
import type { LearningArticle } from '@decklens/contracts'
import { resolveSourceBlock } from './source-navigation'
import { conversationPath, latestConversationId, type ConversationMode, type ReplyKind } from './conversation'

type FlatSection = Section & { depth: number; ancestors: string[] }
type ReaderEntry = { kind: 'section'; section: Section; blockId?: string } | { kind: 'block'; block: ContentBlock }
type TextSegment = { text: string; term?: Term; start?: number; end?: number; selected?: boolean; bold?: boolean; italic?: boolean; code?: boolean }

const documents = ref<DocumentSummary[]>([])
const fileLibrary = ref<FileLibrary>({ folders: [], memberships: [] })
const collapsedFolders = ref(new Set<string>())
const folderDialog = ref<{ parentId: string | null; documentId?: string; documentName?: string } | null>(null)
const movingFiles = ref(new Set<string>())
const savedFontSize = Number(localStorage.getItem('decklens.readerFontSize'))
const readerFontSize = ref(Number.isFinite(savedFontSize) && savedFontSize >= 14 && savedFontSize <= 24 ? savedFontSize : 16)
function changeFontSize(delta: number) {
  readerFontSize.value = Math.max(14, Math.min(24, readerFontSize.value + delta))
  localStorage.setItem('decklens.readerFontSize', String(readerFontSize.value))
}
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
const chats = ref<ChatSummary[]>([])
const conversationMode = ref<ConversationMode>('chat')
const pendingReply = ref<{ nodeId: string; kind: ReplyKind } | null>(null)
const pendingQuestion = ref('')
const composerInput = ref<HTMLTextAreaElement | null>(null)
const composerMenu = ref<HTMLDetailsElement | null>(null)
const modelLabel = ref('设置模型')
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
const readerMode = ref<'source' | 'article'>('source')
const article = ref<LearningArticle | null>(null)
const articleError = ref('')
const articleStarting = ref(false)
let articleTimer = 0
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
const annotationTools = [
  { value: 'pointer' as const, label: '指针', description: '滚动、选择文字和点击术语', icon: MousePointer2 },
  { value: 'pen' as const, label: '画笔', description: '在正文上绘制标注', icon: Pencil },
  { value: 'highlighter' as const, label: '荧光笔', description: '标记重点内容', icon: Highlighter },
  { value: 'eraser' as const, label: '橡皮', description: '擦除笔迹或圈选', icon: Eraser },
  { value: 'lasso' as const, label: '套索圈选提问', description: '圈选正文或图片后提问', icon: Lasso },
]
const activeToolLabel = computed(() => annotationTools.find(tool => tool.value === annotationTool.value)?.label)
const replyLabel = computed(() => pendingReply.value ? ({ deepens: '继续深入', related: '关联提问', branch: '新分支' })[pendingReply.value.kind] : '')
const replyTitle = computed(() => exploreNodes.value.find(node => (node.nodeId || node.id) === pendingReply.value?.nodeId)?.title ?? '')

let viewRequest = 0
let saveTimer = 0
let exploreSaveTimer = 0
let noticeTimer = 0
let dragDepth = 0
let disposed = false
let blockObserver: IntersectionObserver | null = null
let importGeneration = 0
let chatRequest = 0

const activeDocument = computed(() => documents.value.find(item => item.id === activeDocumentId.value) ?? null)
const blocksById = computed(() => new Map(blocks.value.map(block => [block.id, block])))
const filteredDocuments = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase()
  return query ? documents.value.filter(item => `${item.title} ${item.name} ${item.format}`.toLocaleLowerCase().includes(query)) : documents.value
})

const folderPaths = computed(() => {
  const paths = new Map<string, string>()
  const add = (parent: string | null, prefix: string) => {
    for (const folder of fileLibrary.value.folders.filter(item => item.parentId === parent)) {
      const path = prefix ? `${prefix} / ${folder.name}` : folder.name
      paths.set(folder.id, path)
      add(folder.id, path)
    }
  }
  add(null, '')
  return paths
})
const libraryRows = computed(() => {
  const rows: Array<{ kind: 'folder'; id: string; name: string; depth: number } | { kind: 'file'; item: DocumentSummary; folderId: string | null; depth: number }> = []
  const memberships = new Map(fileLibrary.value.memberships.map(item => [item.documentId, item.folderId]))
  const add = (parent: string | null, depth: number) => {
    for (const folder of fileLibrary.value.folders.filter(item => item.parentId === parent)) {
      rows.push({ kind: 'folder', id: folder.id, name: folder.name, depth })
      if (!collapsedFolders.value.has(folder.id) || searchText.value.trim()) add(folder.id, depth + 1)
    }
    for (const item of filteredDocuments.value.filter(doc => (memberships.get(doc.id) ?? null) === parent)) rows.push({ kind: 'file', item, folderId: parent, depth })
  }
  add(null, 0)
  return rows
})
function createFolder(parentId: string | null = null) {
  folderDialog.value = { parentId }
}
function expandFolderPath(folderId: string) {
  let folder = fileLibrary.value.folders.find(item => item.id === folderId)
  while (folder) {
    collapsedFolders.value.delete(folder.id)
    folder = fileLibrary.value.folders.find(item => item.id === folder?.parentId)
  }
}
function onFolderCreated(folder: FileFolder) {
  fileLibrary.value.folders.push(folder)
  expandFolderPath(folder.id)
  libraryError.value = ''
}
function onFileMoved(documentId: string, folderId: string | null) {
  fileLibrary.value.memberships = fileLibrary.value.memberships.filter(item => item.documentId !== documentId)
  if (folderId) {
    fileLibrary.value.memberships.push({ documentId, folderId })
    expandFolderPath(folderId)
  }
  libraryError.value = ''
}
async function moveFile(documentId: string, event: Event) {
  const target = event.target as HTMLSelectElement
  const folderId = target.value
  const previousFolderId = fileLibrary.value.memberships.find(item => item.documentId === documentId)?.folderId ?? ''
  target.value = previousFolderId
  if (folderId === '__new_folder__') {
    folderDialog.value = { parentId: previousFolderId || null, documentId, documentName: documents.value.find(item => item.id === documentId)?.name }
    return
  }
  if (movingFiles.value.has(documentId)) return
  movingFiles.value.add(documentId)
  try {
    await api.moveDocument(documentId, folderId || null)
    onFileMoved(documentId, folderId || null)
  } catch (error) { libraryError.value = errorMessage(error) }
  finally { movingFiles.value.delete(documentId) }
}
function toggleFolder(id: string) {
  const next = new Set(collapsedFolders.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  collapsedFolders.value = next
}

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
function jumpToArticleSection(sectionId: string) {
  document.getElementById(`article-section-${sectionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  leftDrawerOpen.value = false
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
  if (readerMode.value !== 'source') {
    readerMode.value = 'source'
    await nextTick()
    observeBlocks()
  }
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
      conversationMode: conversationMode.value,
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
  return conversationPath(exploreNodes.value, exploreEdges.value, nodeId).map(node => node.nodeId || node.id)
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
    modelLabel.value = selected?.model || '设置模型'
  } catch { aiAvailable.value = false; visionAvailable.value = false; modelLabel.value = '设置模型' }
}
async function loadExploration(documentId: string, requestId: number, preferredChatId?: string) {
  const generation = ++chatRequest
  exploreLoading.value = true
  exploreError.value = ''
  exploreChatId.value = ''
  exploreNodes.value = []; exploreEdges.value = []; activeExploreNodeId.value = ''; expandedExploreNodes.value = new Set(); selectedAnchor.value = null
  try {
    const availableChats = await api.listChats(documentId)
    let chat = availableChats.find(item => item.chatId === preferredChatId) ?? availableChats[0]
    if (!chat) chat = await api.createChat({ documentId })
    if (disposed || requestId !== viewRequest || generation !== chatRequest) return
    chats.value = availableChats.some(item => item.chatId === chat.chatId) ? availableChats : [chat, ...availableChats]
    exploreChatId.value = chat.chatId
    const [graph, saved] = await Promise.all([api.getGraph(documentId, chat.chatId), api.getExploreState(chat.chatId)])
    if (disposed || requestId !== viewRequest || generation !== chatRequest) return
    exploreNodes.value = graph.nodes
    exploreEdges.value = graph.edges
    const ids = new Set(graph.nodes.map(node => node.nodeId || node.id))
    const savedNode = graph.nodes.find(node => (node.nodeId || node.id) === saved?.activeNodeId)
    activeExploreNodeId.value = savedNode && savedNode.kind !== 'note' ? (savedNode.nodeId || savedNode.id) : latestConversationId(graph.nodes)
    expandedExploreNodes.value = new Set((saved?.expandedNodes ?? []).filter(id => ids.has(id)))
    for (const id of explorePath(activeExploreNodeId.value)) expandedExploreNodes.value.add(id)
    const active = graph.nodes.find(node => (node.nodeId || node.id) === activeExploreNodeId.value)
    restoreAnchorForNode(active, saved?.activeBlockId, saved?.textOffset)
    await refreshModelAvailability()
  } catch (error) { if (requestId === viewRequest && generation === chatRequest) exploreError.value = errorMessage(error) }
  finally { if (requestId === viewRequest && generation === chatRequest) exploreLoading.value = false }
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
  activeExploreNodeId.value = preferredNodeId && ids.has(preferredNodeId) ? preferredNodeId : ids.has(activeExploreNodeId.value) ? activeExploreNodeId.value : latestConversationId(graph.nodes)
  for (const id of explorePath(activeExploreNodeId.value)) expandedExploreNodes.value.add(id)
  restoreAnchorForNode(graph.nodes.find(node => (node.nodeId || node.id) === activeExploreNodeId.value))
  await saveExploreViewNow()
}
function activateExploreNode(nodeId: string) {
  pendingReply.value = null
  activeExploreNodeId.value = nodeId
  const node = exploreNodes.value.find(item => (item.nodeId || item.id) === nodeId)
  restoreAnchorForNode(node)
  highlightedAnnotationId.value = typeof node?.context?.annotationId === 'string' ? node.context.annotationId : ''
  for (const id of explorePath(nodeId)) expandedExploreNodes.value.add(id)
  if (window.innerWidth <= 1199) rightDrawerOpen.value = true
  saveExploreViewSoon()
}
function toggleExploreNode(nodeId: string) {
  const next = new Set(expandedExploreNodes.value)
  if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId)
  expandedExploreNodes.value = next
  saveExploreViewSoon()
}
function resetComposer() {
  pendingReply.value = null
  pendingQuestion.value = ''
  documentQuestion.value = ''
  documentQuestionError.value = ''
  if (composerMenu.value) composerMenu.value.open = false
}
async function switchConversation(chatId: string) {
  if (exploreBusy.value || exploreLoading.value || !activeDocumentId.value || chatId === exploreChatId.value) return
  await saveExploreViewNow()
  resetComposer()
  await loadExploration(activeDocumentId.value, viewRequest, chatId)
  saveViewNow(activeDocumentId.value)
}
async function newConversation() {
  if (exploreBusy.value || exploreLoading.value || !activeDocumentId.value) return
  const documentId = activeDocumentId.value
  const requestId = viewRequest
  exploreBusy.value = true
  try {
    await saveExploreViewNow()
    const chat = await api.createChat({ documentId, title: `对话 ${chats.value.length + 1}` })
    if (disposed || requestId !== viewRequest) return
    resetComposer()
    await loadExploration(documentId, requestId, chat.chatId)
    saveViewNow(documentId)
    await nextTick()
    composerInput.value?.focus()
  } catch (error) { if (requestId === viewRequest) exploreError.value = errorMessage(error) }
  finally { if (requestId === viewRequest) exploreBusy.value = false }
}
function setConversationMode(mode: ConversationMode) {
  conversationMode.value = mode
  pendingReply.value = null
  saveViewSoon()
}
function prepareReply(nodeId: string, kind: ReplyKind) {
  pendingReply.value = { nodeId, kind }
  if (window.innerWidth <= 1199) rightDrawerOpen.value = true
  void nextTick(() => composerInput.value?.focus())
}
function selectAnnotationTool(tool: AnnotationTool) {
  annotationTool.value = tool
  if (composerMenu.value) composerMenu.value.open = false
  if (tool !== 'pointer') {
    rightDrawerOpen.value = false
    notify(`${annotationTools.find(item => item.value === tool)?.label}已启用，在正文操作；按 Esc 返回指针。`)
  }
}
function addFileFromComposer() {
  if (composerMenu.value) composerMenu.value.open = false
  fileInput.value?.click()
  notify('文件会导入本地文档库；导入完成后切换到该文档提问。')
}
function onComposerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    void askDocument()
  }
}
async function openTerm(term: Term, blockId: string, startOffset: number, endOffset: number, element?: HTMLElement, parentNodeId?: string) {
  if (exploreBusy.value || exploreLoading.value || !exploreChatId.value) return
  const selected = { termId: term.id, blockId, startOffset, endOffset, text: term.text }
  selectedAnchor.value = selected
  activeBlockId.value = blockId
  if (element) element.classList.add('selected')
  if (window.innerWidth <= 1199) rightDrawerOpen.value = true
  const existing = exploreNodes.value.find(node => node.context?.termId === term.id && (node.parentNodeId ?? '') === (parentNodeId ?? '') && node.sources?.some(source => source.role === 'anchor' && source.blockId === blockId && source.startOffset === startOffset))
  if (existing) { activateExploreNode(existing.nodeId || existing.id); return }
  if (exploreBusy.value || exploreLoading.value) return
  if (!aiAvailable.value) {
    notify('设置并启用模型后，即可针对这段原文提问。')
    providerSettingsOpen.value = true
    return
  }
  const documentId = activeDocumentId.value
  const chatId = exploreChatId.value
  const requestId = viewRequest
  pendingQuestion.value = `请解释术语「${term.text}」`
  exploreBusy.value = true
  exploreError.value = ''
  try {
    let node: ExploreNode
    if (term.definition) {
      node = await api.createNode({ documentId: activeDocumentId.value, chatId: exploreChatId.value, parentNodeId, kind: 'explanation', title: term.text, termId: term.id, sourceBlockId: blockId, startOffset, endOffset, selectedText: term.text, context: { termId: term.id, termText: term.text, origin: term.kind === 'source' ? 'source' : 'ai' } })
    } else {
      const result = await api.ask({ documentId: activeDocumentId.value, chatId: exploreChatId.value, parentNodeId, question: `请解释术语「${term.text}」，优先引用文档中的定义和证据。`, selectedText: term.text, anchor: { blockId, startOffset, endOffset }, branchKind: parentNodeId ? 'deepens' : undefined })
      if (!result.node) throw new Error('没有生成回答，请重试。')
      node = result.node
    }
    if (disposed || requestId !== viewRequest || documentId !== activeDocumentId.value || chatId !== exploreChatId.value) return
    await refreshExplore(node.nodeId || node.id)
  } catch (error) { if (requestId === viewRequest && chatId === exploreChatId.value) { exploreError.value = errorMessage(error); notify(errorMessage(error)) } }
  finally { if (requestId === viewRequest && chatId === exploreChatId.value) { exploreBusy.value = false; pendingQuestion.value = '' } }
}
function openTermFromCard(term: Term, parentNodeId: string) {
  const parent = exploreNodes.value.find(node => (node.nodeId || node.id) === parentNodeId)
  const anchor = nodeAnchor(parent)
  const occurrence = term.occurrences?.find(item => item.blockId === anchor?.blockId) ?? term.occurrences?.[0]
  if (occurrence) void openTerm(term, occurrence.blockId, occurrence.start, occurrence.end, undefined, parentNodeId)
  else if (anchor) void openTerm(term, anchor.blockId, anchor.startOffset ?? 0, anchor.endOffset ?? (anchor.startOffset ?? 0) + term.text.length, undefined, parentNodeId)
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
  const reply = pendingReply.value
  const parentNodeId = reply?.nodeId || activeExploreNodeId.value || undefined
  exploreBusy.value = true
  pendingQuestion.value = question
  documentQuestionError.value = ''
  exploreError.value = ''
  try {
    const result = await api.ask({ documentId, chatId, question, parentNodeId, branchKind: parentNodeId ? reply?.kind ?? 'deepens' : undefined })
    if (disposed || requestId !== viewRequest || chatId !== exploreChatId.value) return
    if (!result.node) throw new Error('没有生成回答，请重试。')
    await refreshExplore(result.node.nodeId || result.node.id)
    if (requestId === viewRequest && chatId === exploreChatId.value) {
      if (documentQuestion.value === draft) documentQuestion.value = ''
      pendingReply.value = null
    }
  } catch (error) {
    if (requestId === viewRequest && chatId === exploreChatId.value) documentQuestionError.value = errorMessage(error)
  } finally {
    if (requestId === viewRequest && chatId === exploreChatId.value) { exploreBusy.value = false; pendingQuestion.value = '' }
  }
}
async function deleteExploreBranch(nodeId: string) {
  if (exploreBusy.value || exploreLoading.value) return
  const node = exploreNodes.value.find(item => (item.nodeId || item.id) === nodeId)
  if (!node || !window.confirm(`删除「${node.title}」及其全部子分支？`)) return
  const requestId = viewRequest
  const chatId = exploreChatId.value
  const parent = exploreEdges.value.find(edge => edge.toNodeId === nodeId && edge.kind !== 'related')?.fromNodeId
  exploreBusy.value = true
  try {
    await api.deleteNode(nodeId)
    if (disposed || requestId !== viewRequest || chatId !== exploreChatId.value) return
    pendingReply.value = null
    await refreshExplore(parent)
  } catch (error) { if (requestId === viewRequest && chatId === exploreChatId.value) exploreError.value = errorMessage(error) }
  finally { if (requestId === viewRequest && chatId === exploreChatId.value) exploreBusy.value = false }
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
  if (!selection || !activeDocumentId.value || !exploreChatId.value || exploreBusy.value || exploreLoading.value) return
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
      ? '根据这段圈选内容解释核心概念、关系和前置知识；严格依据文档，证据不足时请明确说明。'
      : selectionQuestion.value.trim()
  if (!question) { selectionQuestionOpen.value = true; selectionError.value = '写下你想针对这段内容了解的问题。'; return }
  const sourceBlockId = selection.blockIds[0]
  if (!sourceBlockId) { selectionError.value = '圈选区域没有覆盖可定位的文档内容。'; return }
  const parentNodeId = activeExploreNodeId.value || undefined
  const documentId = activeDocumentId.value
  const chatId = exploreChatId.value
  const requestId = viewRequest
  const selectionContext = selection.blockIds.map(id => {
    const block = blocks.value.find(item => item.id === id)
    const text = block ? blockText(block).trim() : ''
    return text ? `[${sourceLabel(block?.locator ?? block?.sourceLocator)}] ${text}` : ''
  }).filter(Boolean).join('\n\n')
  exploreBusy.value = true
  pendingQuestion.value = question
  selectionError.value = ''
  exploreError.value = ''
  try {
    const result = await api.ask({
      documentId,
      chatId,
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
    if (disposed || requestId !== viewRequest || chatId !== exploreChatId.value) return
    if (!result.node) throw new Error('没有生成回答，请重试。')
    const nodeId = result.node.nodeId || result.node.id
    await refreshExplore(nodeId)
    if (requestId !== viewRequest || chatId !== exploreChatId.value) return
    highlightedAnnotationId.value = selection.annotationId
    if (window.innerWidth <= 1199) rightDrawerOpen.value = true
    closeAnnotationMenu()
    notify('回答已加入对话，并保留圈选原文位置。')
  } catch (error) {
    if (requestId !== viewRequest || chatId !== exploreChatId.value) return
    const message = errorMessage(error)
    selectionError.value = message
    exploreError.value = message
  } finally { if (requestId === viewRequest && chatId === exploreChatId.value) { exploreBusy.value = false; pendingQuestion.value = '' } }
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
    ;[documents.value, fileLibrary.value] = await Promise.all([api.listDocuments(), api.listFolders()])
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
  window.clearTimeout(articleTimer)
  article.value = null
  articleError.value = ''
  const openedFormat = documents.value.find(item => item.id === documentId)?.format?.toLowerCase()
  readerMode.value = openedFormat === 'pdf' || openedFormat === 'pptx' ? 'article' : 'source'
  resetComposer()
  annotationTool.value = 'pointer'
  closeAnnotationMenu()
  chats.value = []
  chatRequest += 1
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
    void refreshArticle(documentId, requestId)
    const saved = api.getReaderView(documentId)
    leftCollapsed.value = Boolean(saved.leftCollapsed)
    rightCollapsed.value = Boolean(saved.rightCollapsed)
    conversationMode.value = saved.conversationMode === 'branch' ? 'branch' : 'chat'
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

async function refreshArticle(documentId: string, requestId: number) {
  try {
    const result = await api.getLearningArticle(documentId)
    if (disposed || requestId !== viewRequest || documentId !== activeDocumentId.value) return
    article.value = result
    articleError.value = ''
    if (result?.status === 'generating') articleTimer = window.setTimeout(() => void refreshArticle(documentId, requestId), 1500)
  } catch (error) {
    if (requestId === viewRequest) articleError.value = errorMessage(error)
  }
}

async function generateArticle() {
  if (!activeDocumentId.value || articleStarting.value || article.value?.status === 'generating') return
  if (!aiAvailable.value) { providerSettingsOpen.value = true; articleError.value = '请先配置模型，原文阅读不受影响。'; return }
  if (!window.confirm('生成学习文章需要把文档解析出的文本发送给当前选用的模型服务。远程服务会接收这些内容；本地模型则在本机处理。确认继续吗？')) return
  const documentId = activeDocumentId.value
  const requestId = viewRequest
  articleStarting.value = true
  articleError.value = ''
  try {
    const result = await api.generateLearningArticle(documentId, { force: true, language: 'zh-CN' })
    if (requestId !== viewRequest) return
    article.value = result
    await refreshArticle(documentId, requestId)
  } catch (error) { if (requestId === viewRequest) articleError.value = errorMessage(error) }
  finally { articleStarting.value = false }
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
    annotationTool.value = 'pointer'
    if (composerMenu.value) composerMenu.value.open = false
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

watch([activeBlockId, expandedSections, leftCollapsed, rightCollapsed, conversationMode], saveViewSoon, { deep: true })
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
  window.clearTimeout(articleTimer)
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
        <button class="icon-button desktop-toggle" :aria-label="rightCollapsed ? '展开对话面板' : '收起对话面板'" :title="rightCollapsed ? '展开对话面板' : '收起对话面板'" @click="restoreRightPanel"><PanelRightOpen v-if="rightCollapsed" :size="18" /><PanelRightClose v-else :size="18" /></button>
        <button class="icon-button mobile-explore" aria-label="打开对话面板" @click="rightDrawerOpen = true"><PanelRightOpen :size="18" /></button>
        <button class="icon-button" aria-label="模型供应商设置" title="模型供应商设置" @click="providerSettingsOpen = true"><Settings2 :size="18" /></button>
      </div>
    </header>

    <div v-if="importing || reparsing" class="job-banner" role="status" aria-live="polite">
      <span class="progress-track"><i :style="{ width: `${importProgress}%` }"></i></span>
      <span>{{ importMessage }}<template v-if="importProgress"> · {{ importProgress }}%</template></span>
    </div>

    <div class="workspace">
      <aside class="left-rail" :class="{ 'drawer-open': leftDrawerOpen }" aria-label="文件和目录">
        <div class="rail-heading">
          <div><p class="eyebrow">LIBRARY</p><h1>文件</h1></div>
          <button class="folder-create-button" aria-label="新建文件夹" title="新建文件夹" @click="createFolder()"><FolderPlus :size="17" aria-hidden="true" /><span>新建文件夹</span></button>
          <button class="icon-button mobile-close" aria-label="关闭目录" @click="leftDrawerOpen = false"><X :size="17" /></button>
        </div>
        <button class="import-button" :disabled="importing || reparsing" @click="fileInput?.click()"><FilePlus2 :size="17" /><span>导入文件</span></button>
        <input ref="fileInput" class="visually-hidden" type="file" multiple accept=".pptx,.docx,.pdf,.md,.markdown,.txt" @change="onFileInput" />

        <div class="document-list" aria-label="已导入文件">
          <template v-for="row in libraryRows" :key="row.kind === 'folder' ? row.id : row.item.id">
          <div v-if="row.kind === 'folder'" class="folder-row" :style="{ '--depth': row.depth }">
            <button class="folder-toggle" :aria-expanded="!collapsedFolders.has(row.id)" @click="toggleFolder(row.id)"><ChevronRight v-if="collapsedFolders.has(row.id)" :size="14" /><ChevronDown v-else :size="14" /><Folder :size="16" /><span>{{ row.name }}</span></button>
            <button class="icon-button tiny" :aria-label="`在${row.name}中新建文件夹`" title="新建子文件夹" @click="createFolder(row.id)"><Plus :size="14" /></button>
          </div>
          <div v-else class="file-row" :style="{ '--depth': row.depth }">
          <button class="document-row" :class="{ active: row.item.id === activeDocumentId }" :aria-current="row.item.id === activeDocumentId ? 'page' : undefined" @click="openDocument(row.item.id)">
            <FileText :size="17" class="doc-icon" />
            <span class="document-row-copy"><strong>{{ row.item.title || row.item.name }}</strong><small>{{ row.item.format.toUpperCase() }}<template v-if="row.item.sizeBytes"> · {{ formatBytes(row.item.sizeBytes) }}</template></small></span>
          </button>
          <select class="file-move" :value="row.folderId || ''" :disabled="movingFiles.has(row.item.id)" :aria-label="`移动${row.item.name}到文件夹`" title="移动文件或新建文件夹" @change="moveFile(row.item.id, $event)"><option value="">文件根目录</option><option value="__new_folder__">新建文件夹并移入…</option><option v-for="folder in fileLibrary.folders" :key="folder.id" :value="folder.id">{{ folderPaths.get(folder.id) }}</option></select>
          </div>
          </template>
          <p v-if="libraryLoading" class="muted-note">正在读取本机文件…</p>
          <div v-else-if="libraryError" class="inline-error" role="alert"><strong>文件管理出错</strong><span>{{ libraryError }}</span><button class="secondary-button" @click="loadLibrary">重试</button></div>
          <div v-else-if="!filteredDocuments.length && !fileLibrary.folders.length" class="empty-library"><BookOpen :size="20" /><strong>{{ documents.length ? '没有匹配的文件' : '从一份文件开始' }}</strong><span>{{ documents.length ? '调整搜索词，或清空搜索。' : '拖入 PDF、DOCX、PPTX、Markdown 或 TXT，原文件会保存在本机。' }}</span></div>
        </div>

        <div class="rail-divider"></div>
        <div class="outline-heading"><h2>{{ readerMode === 'article' ? '文章目录' : '原文目录' }}</h2><span>{{ readerMode === 'article' ? article?.sections.length || 0 : allSections.length }}</span></div>
        <nav class="outline-tree" aria-label="文档章节目录">
          <button v-for="section in readerMode === 'source' ? visibleSections : []" :key="section.id" class="outline-row" :class="{ current: orderedBlocks.some(block => block.id === activeBlockId && block.sectionId === section.id) }" :style="{ '--depth': section.depth }" :title="section.title" @click="jumpToSection(section.id)">
            <span class="outline-caret" @click.stop="section.children?.length && toggleSection(section)">
              <ChevronDown v-if="section.children?.length && expandedSections.has(section.id)" :size="14" />
              <ChevronRight v-else-if="section.children?.length" :size="14" />
              <i v-else></i>
            </span>
            <span>{{ section.title }}</span>
          </button>
          <button v-for="section in readerMode === 'article' && article?.status === 'ready' ? article.sections : []" :key="section.id" class="outline-row" :style="{ '--depth': section.depth }" @click="jumpToArticleSection(section.id)"><span class="outline-caret"><i></i></span><span>{{ section.title }}</span></button>
          <p v-if="readerMode === 'article' && activeDocument && !article?.sections.length && !readerLoading" class="muted-note">生成学习文章后显示文章目录。</p>
          <p v-if="readerMode === 'source' && activeDocument && !allSections.length && !readerLoading" class="muted-note">文档没有可识别的章节。</p>
          <p v-else-if="!activeDocument && !libraryLoading" class="muted-note">导入文档后显示章节目录。</p>
        </nav>
        <div class="rail-footer"><span class="status-mark"></span><span>数据保存在本机</span></div>
      </aside>

      <main class="reader-column">
        <div class="reader-toolbar">
          <button class="icon-button mobile-menu" aria-label="打开目录" @click="leftDrawerOpen = true"><Menu :size="17" /></button>
          <div class="document-crumb"><span>文件</span><ChevronRight :size="14" /><strong>{{ activeDocument?.title || activeDocument?.name || '阅读区' }}</strong></div>
          <div v-if="activeDocument" class="reader-modes" aria-label="阅读模式">
            <button :class="{ active: readerMode === 'source' }" @click="readerMode = 'source'">原文</button>
            <button :class="{ active: readerMode === 'article' }" @click="readerMode = 'article'">学习文章</button>
          </div>
          <div v-if="activeDocument" class="font-controls" aria-label="阅读字号"><button aria-label="缩小阅读字号" :disabled="readerFontSize <= 14" @click="changeFontSize(-1)">A−</button><span>{{ readerFontSize }}</span><button aria-label="增大阅读字号" :disabled="readerFontSize >= 24" @click="changeFontSize(1)">A+</button></div>
          <button v-if="activeDocument" class="reparse-button" :disabled="reparsing || readerLoading || importing" @click="reparseDocument">{{ reparsing ? '重新解析中…' : '重新解析' }}</button>
        </div>

        <div v-if="importFailures.length" class="import-failures" role="alert">
          <div class="failure-heading"><strong>部分文件未能导入</strong><button class="icon-button tiny" aria-label="关闭导入错误" @click="importFailures = []"><X :size="15" /></button></div>
          <p v-for="(failure, index) in importFailures" :key="`${failure.name}-${index}`"><b>{{ failure.name }}</b>：{{ failure.message }}</p>
        </div>

        <div v-if="readerLoading" class="reader-scroll"><div class="reading-card loading-state" aria-live="polite"><span class="loading-rule"></span><p>正在读取文档结构…</p></div></div>
        <div v-else-if="readerError" class="reader-scroll"><div class="reading-card error-state" role="alert"><FileText :size="22" /><h2>文档暂时无法读取</h2><p>{{ readerError }}</p><button class="secondary-button" @click="activeDocumentId && openDocument(activeDocumentId)">重试</button></div></div>
        <div v-else-if="!activeDocument" class="reader-scroll"><section class="welcome-state"><span class="welcome-index">LOCAL READER</span><h2>从原文开始，<br /><em>把知识读清楚。</em></h2><p>导入 PDF、DOCX、PPTX、Markdown 或 TXT，DeckLens 会按原生结构生成可定位的阅读视图。</p><button class="primary-button" @click="fileInput?.click()"><FilePlus2 :size="17" />选择文档</button></section></div>
        <div v-else ref="readerScroller" class="reader-scroll" :style="{ '--reader-font-size': `${readerFontSize}px` }" @scroll.passive="onReaderScroll">
          <article v-if="readerMode === 'article'" class="reading-card learning-article">
            <header class="document-intro"><div class="format-line">学习文章 · AI 整理，仅供参考</div><h1>{{ article?.status === 'ready' ? article.title : activeDocument.title || activeDocument.name }}</h1><p>中文学习文章 · 基于整份文档整理，点击来源可回到原文。</p></header>
            <p v-if="articleError" class="status-note" role="alert">{{ articleError }}</p>
            <div v-if="article?.status === 'generating'" class="article-status" role="status">{{ article.progressMessage || '正在整理文档' }} · {{ article.progress }}%</div>
            <div v-else-if="article?.status === 'failed'" class="article-status" role="alert">{{ article.errorMessage || '学习文章生成失败。' }}</div>
            <div v-else-if="article?.status === 'stale'" class="article-status">原文结构已调整，文章可能过时，请重新生成。</div>
            <div v-if="!article || article.status !== 'ready'" class="article-status">点击“生成学习文章”，将整份课件按知识主题整理为中文文章；英文内容会翻译讲解，并尽可能附上原图和出处。原文可随时切换查看。</div>
            <button class="secondary-button" :disabled="articleStarting || article?.status === 'generating'" @click="generateArticle">{{ articleStarting ? '正在开始…' : article?.sections.length ? '重新生成文章' : '生成学习文章' }}</button>
            <LearningArticleSection v-for="section in article?.status === 'ready' ? article.sections : []" :key="section.id" :section="section" @cite="jumpToSource" />
          </article>
          <article v-else class="reading-card">
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

      <aside class="explore-column" :class="{ 'drawer-open': rightDrawerOpen }" aria-label="文档对话">
        <ConversationPanel :nodes="exploreNodes" :edges="exploreEdges" :terms="terms" :chats="chats" :chat-id="exploreChatId" :active-node-id="activeExploreNodeId" :expanded-node-ids="[...expandedExploreNodes]" :mode="conversationMode" :document-title="activeDocument?.title || activeDocument?.name || ''" :pending-question="pendingQuestion" :busy="exploreBusy" :loading="exploreLoading" :error="exploreError" @activate="activateExploreNode" @toggle="toggleExploreNode" @delete-branch="deleteExploreBranch" @reply="prepareReply" @mode="setConversationMode" @new-chat="newConversation" @switch-chat="switchConversation" @cite="jumpToSource" @close="rightDrawerOpen = false" @term="openTermFromCard">
          <template #composer>
            <form class="chat-composer" aria-label="发送消息" :aria-busy="exploreBusy" @submit.prevent="askDocument">
              <div v-if="pendingReply" class="composer-reply-context"><span>{{ replyLabel }} · {{ replyTitle }}</span><button type="button" class="icon-button tiny" aria-label="取消指定回复" @click="pendingReply = null"><X :size="13" /></button></div>
              <div v-if="annotationTool !== 'pointer'" class="composer-tool-status" role="status"><Pencil :size="13" /><span>{{ activeToolLabel }}已启用 · 在正文标注</span><button type="button" class="icon-button tiny" aria-label="结束标注，返回指针" @click="selectAnnotationTool('pointer')"><X :size="13" /></button></div>
              <div class="composer-box" :class="{ 'has-error': documentQuestionError }">
                <label for="document-question" class="visually-hidden">向当前文档提问</label>
                <textarea id="document-question" ref="composerInput" v-model="documentQuestion" rows="3" :disabled="!activeDocument || !exploreChatId || readerLoading || exploreLoading || exploreBusy" :aria-describedby="documentQuestionError ? 'document-question-help document-question-error' : 'document-question-help'" :aria-invalid="Boolean(documentQuestionError)" :placeholder="activeDocument ? '问问这份文档…' : '先打开一份文档'" @input="documentQuestionError = ''" @keydown="onComposerKeydown"></textarea>
                <div class="composer-footer">
                  <details ref="composerMenu" class="composer-menu" @keydown.esc.stop="composerMenu && (composerMenu.open = false)">
                    <summary class="icon-button" aria-label="添加文件或标注工具" title="添加文件或标注工具"><Plus :size="20" /></summary>
                    <div class="composer-menu-popover" role="group" aria-label="文件与标注工具">
                      <button type="button" :disabled="importing || reparsing" @click="addFileFromComposer"><FilePlus2 :size="16" /><span>添加文件<small>导入本地文档库并切换阅读</small></span></button>
                      <div class="composer-menu-divider"></div>
                      <span class="composer-menu-label">正文标注</span>
                      <button v-for="tool in annotationTools" :key="tool.value" type="button" :class="{ selected: annotationTool === tool.value }" :aria-pressed="annotationTool === tool.value" :disabled="!activeDocument || readerLoading" @click="selectAnnotationTool(tool.value)"><component :is="tool.icon" :size="16" /><span>{{ tool.label }}<small>{{ tool.description }}</small></span></button>
                      <button type="button" :disabled="!activeDocument || readerLoading" @click="composerMenu && (composerMenu.open = false); clearDocumentAnnotations()"><Trash2 :size="16" /><span>清除标注</span></button>
                    </div>
                  </details>
                  <button type="button" class="composer-model" :title="modelLabel" @click="providerSettingsOpen = true"><span>{{ modelLabel }}</span><ChevronDown :size="12" /></button>
                  <button class="composer-send" type="submit" :aria-label="aiAvailable ? '发送消息' : '配置模型'" :title="aiAvailable ? '发送消息（Enter），换行（Shift+Enter）' : '配置模型'" :disabled="!activeDocument || !exploreChatId || readerLoading || exploreLoading || exploreBusy || (aiAvailable && !documentQuestion.trim())"><span v-if="exploreBusy" class="send-loading"></span><ArrowUp v-else-if="aiAvailable" :size="18" /><Settings2 v-else :size="17" /></button>
                </div>
              </div>
              <p id="document-question-help" class="composer-help">{{ !activeDocument ? '文档与对话均保存在本机' : !aiAvailable ? '配置模型即可提问，阅读和标注始终可用' : '基于当前文档回答 · 引用可定位原文' }}</p>
              <p v-if="documentQuestionError" id="document-question-error" class="composer-error" role="alert">{{ documentQuestionError }}</p>
            </form>
          </template>
        </ConversationPanel>
      </aside>
    </div>

    <section v-if="annotationSelection" class="annotation-selection-menu" :style="annotationMenuStyle" aria-label="圈选内容操作">
      <header class="annotation-menu-heading"><div><strong>已圈选 {{ annotationSelection.blockIds.length }} 个内容块</strong><small>{{ annotationSelection.imageRefs.length ? '包含图片区域' : '原文上下文已完整提取' }}</small></div><button class="icon-button tiny" aria-label="关闭圈选菜单" @click="closeAnnotationMenu"><X :size="15" /></button></header>
      <p class="annotation-selection-excerpt">{{ annotationSelection.selectedText || '图片区域已绑定到本地原文，可由支持视觉的模型分析。' }}</p>
      <div class="annotation-menu-actions">
        <button class="annotation-action-primary" :disabled="exploreBusy" @click="submitAnnotationQuestion('explain')">解释这段</button>
        <button :disabled="exploreBusy" @click="selectionQuestionOpen = !selectionQuestionOpen; selectionError = ''">就这段提问</button>
        <button :disabled="exploreBusy" @click="submitAnnotationQuestion('card')">发送到对话</button>
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
    <CreateFolderDialog v-if="folderDialog" :parent-id="folderDialog.parentId" :parent-path="folderDialog.parentId ? folderPaths.get(folderDialog.parentId) || '文件根目录' : '文件根目录'" :document-id="folderDialog.documentId" :document-name="folderDialog.documentName" @created="onFolderCreated" @moved="onFileMoved" @complete="notify" @close="folderDialog = null" />
    <ProviderSettings v-if="providerSettingsOpen" @close="providerSettingsOpen = false; refreshModelAvailability()" />
  </div>
</template>
