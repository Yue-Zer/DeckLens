import type { LearningArticle } from '@decklens/contracts'

export type SourceLocator = {
  format?: string
  sourceHash?: string
  pageNumber?: number
  slideNumber?: number
  headingPath?: string[]
  headingSource?: 'native-outline' | 'native-style' | 'automatic-inference'
  readingOrderWarning?: boolean
  paragraphIndex?: number
  excerpt?: string
  textStart?: number
  textEnd?: number
  lineStart?: number
  lineEnd?: number
}

export type AnnotationTool = 'pointer' | 'pen' | 'highlighter' | 'eraser' | 'lasso'
export type AnnotationTarget = {
  blockId: string
  shape: 'path' | 'polygon'
  points: Array<{ x: number; y: number }>
  strokeRatio: number
}
export type AnnotationRecord = {
  id: string
  documentId: string
  versionId: string
  tool: 'pen' | 'highlighter' | 'lasso'
  targets: AnnotationTarget[]
  createdAt: string
}
export type CreateAnnotationInput = {
  documentId: string
  tool: AnnotationRecord['tool']
  targets: AnnotationTarget[]
}

export type DocumentSummary = {
  id: string
  title: string
  name: string
  originalName?: string
  sourceHash?: string
  format: string
  mimeType?: string
  sizeBytes?: number
  sourceRelativePath?: string
  activeVersionId?: string
  language?: string
  status?: string
  sectionCount?: number
  createdAt?: string
}

export type FileFolder = { id: string; parentId: string | null; name: string }
export type FileLibrary = { folders: FileFolder[]; memberships: Array<{ documentId: string; folderId: string }> }

export type Section = {
  id: string
  sourceSectionKey?: string
  origin?: 'parser' | 'manual'
  parentId?: string | null
  title: string
  level?: number
  depth?: number
  sourceOrder?: number
  order?: number
  displayOrder?: number
  children?: Section[]
  locator?: SourceLocator
}

export type ContentBlock = {
  id: string
  sourceBlockKey?: string
  parentBlockId?: string | null
  sourceOrder?: number
  sectionId?: string
  type: string
  plainText?: string
  text?: string
  payload?: Record<string, unknown>
  locator?: SourceLocator
  order?: number
  sourceLocator?: SourceLocator
  documentVersionId?: string
}

export type Term = {
  id: string
  text: string
  canonicalText?: string
  definition?: string
  kind?: 'source' | 'ai'
  sourceBlockId?: string
  locator?: SourceLocator
  occurrences?: Array<{ blockId: string; start: number; end: number; displayMode?: 'anchor' | 'hover' }>
}

export type ExploreNode = {
  id: string
  nodeId?: string
  documentId?: string
  chatId?: string
  parentNodeId?: string | null
  kind?: 'qa' | 'explanation' | 'note' | string
  relationKind?: 'deepens' | 'branch' | 'related'
  title: string
  question?: string
  answer?: string
  status?: string
  createdAt?: string
  provider?: string
  model?: string
  sourceBlockId?: string
  sourceVersionId?: string
  citations?: Array<{ blockId: string; quote: string; locator?: SourceLocator }>
  messages?: Array<{ id?: string; role: 'user' | 'assistant'; content: string }>
  sources?: Array<{ blockId: string; quote: string; role?: string; locator?: SourceLocator; startOffset?: number; endOffset?: number; documentVersionId?: string }>
  context?: Record<string, unknown>
  origin?: string
  edges?: ExploreEdge[]
}

export type ExploreEdge = {
  id: string
  fromNodeId: string
  toNodeId: string
  kind: 'deepens' | 'branch' | 'related'
  branchGroupId?: string
  label?: string
}

export type ExploreGraph = { nodes: ExploreNode[]; edges: ExploreEdge[] }

export type ProviderSettings = {
  provider: 'openai-compatible' | 'ollama'
  baseUrl: string
  model: string
  keyConfigured: boolean
}

export type ProviderKind = 'openai-compatible' | 'deepseek' | 'ollama' | 'anthropic' | 'custom'
export type ProviderProtocol = 'openai-chat' | 'ollama-chat' | 'anthropic-messages'
export type ProviderProfile = {
  id: string
  name: string
  providerKind: ProviderKind
  protocol: ProviderProtocol
  baseUrl: string
  model: string
  timeoutMs: number
  supportsStreaming: boolean
  supportsVision: boolean
  hasApiKey: boolean
  active: boolean
  createdAt: string
  updatedAt: string
}
export type ProviderProfileInput = Omit<ProviderProfile, 'id' | 'hasApiKey' | 'active' | 'createdAt' | 'updatedAt'> & {
  id?: string
  apiKey?: string
  activate?: boolean
}
export type ModelMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }>
}
export type ModelChatRequest = {
  profileId?: string
  messages: ModelMessage[]
  temperature?: number
  maxTokens?: number
}

export type ReaderViewState = {
  conversationMode?: 'chat' | 'branch'
  documentId?: string
  chatId?: string
  activeNodeId?: string
  activeBlockId?: string
  expandedSections?: string[]
  collapsedNodes?: string[]
  floatingCards?: FloatingCardState
  scrollTop?: number
  leftCollapsed?: boolean
  rightCollapsed?: boolean
}

export type FloatingCardState = {
  openNodeIds: string[]
  activeCardId?: string
  cardScrollOffsets?: Record<string, number>
}

export type ExploreViewState = {
  activeNodeId?: string
  activeBlockId?: string
  textOffset?: number
  chatId?: string
  scrollAnchor?: string
  expandedNodes?: string[]
  floatingCards?: FloatingCardState
}

export type ImportJob = {
  status: string
  progress?: number
  message?: string
  documents?: Array<Record<string, unknown>>
  errors?: Array<{ name: string; message: string }>
  error?: string | { message?: string }
}
export type DocumentTree = {
  document?: DocumentSummary
  versionId?: string
  sections?: Section[]
  tree?: Section[]
  sectionEditsNeedReview?: number
  metadata?: Record<string, unknown>
}
export type ChatSummary = { chatId: string; title: string }
export type AskResult = {
  node?: ExploreNode
  answer?: string
  citations?: ExploreNode['citations']
  foundEvidence?: boolean
}

/** Renderer-facing capabilities. Implementations own transport and resource URLs. */
export interface PlatformAdapter {
  listFolders(): Promise<FileLibrary>
  createFolder(name: string, parentId: string | null): Promise<FileFolder>
  moveDocument(documentId: string, folderId: string | null): Promise<void>
  listDocuments(): Promise<DocumentSummary[]>
  startImport(files: File[]): Promise<{ jobId?: string; jobIds?: string[] }>
  getImport(jobId: string): Promise<ImportJob>
  cancelImport(jobId: string): Promise<void>
  getDocument(id: string): Promise<DocumentSummary>
  deleteDocument(id: string): Promise<void>
  reparseDocument(id: string): Promise<{ jobId: string }>
  getTree(id: string): Promise<DocumentTree>
  getLearningArticle(id: string): Promise<LearningArticle | null>
  generateLearningArticle(id: string, options?: { force?: boolean; language?: string }): Promise<LearningArticle | null>
  getBlocks(id: string): Promise<ContentBlock[]>
  getBlock(id: string): Promise<ContentBlock>
  getAssetUrl(assetId: string): string
  updateSections(id: string, edits: Array<Record<string, unknown>>): Promise<unknown>
  getTerms(id: string): Promise<Term[]>
  listAnnotations(id: string): Promise<AnnotationRecord[]>
  createAnnotation(input: CreateAnnotationInput): Promise<AnnotationRecord>
  deleteAnnotation(id: string): Promise<void>
  clearAnnotations(documentId: string): Promise<void>
  getTerm(id: string): Promise<Term>
  explainTerm(id: string): Promise<Term>
  getGraph(id: string, chatId?: string): Promise<ExploreGraph>
  getChildren(id: string): Promise<ExploreNode[]>
  createNode(payload: Record<string, unknown>): Promise<ExploreNode>
  createBranch(id: string, payload: Record<string, unknown>): Promise<ExploreNode>
  createEdge(payload: Record<string, unknown>): Promise<ExploreEdge>
  updateNode(id: string, payload: Record<string, unknown>): Promise<ExploreNode>
  deleteNode(id: string): Promise<void>
  ask(payload: Record<string, unknown>): Promise<AskResult>
  listChats(documentId: string): Promise<ChatSummary[]>
  createChat(payload: Record<string, unknown>): Promise<ChatSummary>
  getExploreState(chatId: string): Promise<ExploreViewState | null>
  saveExploreState(chatId: string, state: ExploreViewState): Promise<void>
  getReaderView(documentId?: string): ReaderViewState
  saveReaderView(state: ReaderViewState): void
  listMessages(chatId: string): Promise<unknown[]>
  createMessage(chatId: string, payload: Record<string, unknown>): Promise<unknown>
  getSettings(): Promise<ProviderSettings>
  saveSettings(settings: Omit<ProviderSettings, 'keyConfigured'>): Promise<ProviderSettings>
  listProviderProfiles(): Promise<{ profiles: ProviderProfile[]; activeId: string | null }>
  saveProviderProfile(profile: ProviderProfileInput): Promise<ProviderProfile>
  activateProviderProfile(profileId: string): Promise<ProviderProfile>
  deleteProviderProfile(profileId: string): Promise<void>
  clearProviderApiKey(profileId: string): Promise<void>
  testProviderProfile(profileId: string): Promise<{ ok: boolean; message: string; model: string }>
  completeModelChat(request: ModelChatRequest): Promise<string>
  streamModelChat(request: ModelChatRequest, onToken: (token: string) => void): Promise<void>
  openSecretConfig(): Promise<void>
  clearSecret(): Promise<void>
  clearData(): Promise<void>
}
