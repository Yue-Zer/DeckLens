import type {
  AnnotationRecord, ContentBlock, CreateAnnotationInput, DocumentSummary, ExploreEdge, ExploreNode, ExploreViewState,
  ModelChatRequest, PlatformAdapter, ProviderProfile, ProviderProfileInput, ProviderSettings, ReaderViewState, Section, SourceLocator, Term,
} from './platform'
export type * from './platform'
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? `请求失败 (${response.status})`
    throw new Error(message)
  }
  return body?.data ?? body
}

async function readModelError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: { message?: string }; message?: string }
  return new Error(body?.error?.message ?? body?.message ?? `模型请求失败 (${response.status})`)
}

function normalizeProviderProfile(value: Record<string, unknown>): ProviderProfile {
  return {
    id: String(value.id ?? ''),
    name: String(value.name ?? ''),
    providerKind: String(value.providerKind ?? 'openai-compatible') as ProviderProfile['providerKind'],
    protocol: String(value.protocol ?? 'openai-chat') as ProviderProfile['protocol'],
    baseUrl: String(value.baseUrl ?? ''),
    model: String(value.model ?? ''),
    timeoutMs: Number(value.timeoutMs ?? 60000),
    supportsStreaming: Boolean(value.supportsStreaming),
    supportsVision: Boolean(value.supportsVision),
    hasApiKey: Boolean(value.hasApiKey),
    active: Boolean(value.active),
    createdAt: String(value.createdAt ?? ''),
    updatedAt: String(value.updatedAt ?? ''),
  }
}

async function modelRequest(payload: ModelChatRequest, stream: boolean): Promise<Response> {
  const response = await fetch('/api/model/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, stream }),
  })
  if (!response.ok) throw await readModelError(response)
  return response
}

function dispatchSseEvent(lines: string[], onToken: (token: string) => void): void {
  let event = 'message'
  const data: string[] = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return
  const value = data.join('\n')
  if (event === 'token') {
    const parsed = JSON.parse(value) as { text?: unknown }
    if (typeof parsed.text === 'string') onToken(parsed.text)
  } else if (event === 'error') {
    const parsed = JSON.parse(value) as { message?: unknown }
    throw new Error(typeof parsed.message === 'string' ? parsed.message : '模型流式请求失败。')
  }
}

async function consumeModelStream(response: Response, onToken: (token: string) => void): Promise<void> {
  if (!response.body) throw new Error('模型服务未返回可读取的流式响应。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) dispatchSseEvent(event.split(/\r?\n/), onToken)
      if (done) break
    }
    if (buffer.trim()) dispatchSseEvent(buffer.split(/\r?\n/), onToken)
  } finally {
    reader.releaseLock()
  }
}

function normalizeDocument(value: Record<string, unknown>): DocumentSummary {
  const originalName = String(value.originalName ?? value.name ?? '')
  return {
    id: String(value.id ?? value.documentId ?? ''),
    title: String(value.title ?? originalName),
    name: originalName,
    originalName,
    sourceHash: typeof value.sourceHash === 'string' ? value.sourceHash : undefined,
    format: String(value.format ?? value.extension ?? originalName.split('.').pop() ?? 'document'),
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : undefined,
    sizeBytes: typeof value.sizeBytes === 'number' ? value.sizeBytes : undefined,
    sourceRelativePath: typeof value.sourceRelativePath === 'string' ? value.sourceRelativePath : undefined,
    activeVersionId: typeof value.activeVersionId === 'string' ? value.activeVersionId : undefined,
    language: typeof value.language === 'string' ? value.language : undefined,
    status: typeof value.status === 'string' ? value.status : undefined,
    sectionCount: typeof value.sectionCount === 'number' ? value.sectionCount : undefined,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
  }
}

function normalizeTerm(value: Record<string, unknown>): Term {
  const definitions = Array.isArray(value.definitions) ? value.definitions as Array<Record<string, unknown>> : []
  const mentions = Array.isArray(value.mentions) ? value.mentions as Array<Record<string, unknown>> : []
  const sourceDefinition = definitions.find(item => item.kind === 'source') ?? definitions[0]
  return {
    id: String(value.id ?? value.termId ?? ''),
    text: String(value.canonicalText ?? value.text ?? ''),
    canonicalText: String(value.canonicalText ?? value.text ?? ''),
    definition: typeof sourceDefinition?.text === 'string' ? sourceDefinition.text : undefined,
    kind: sourceDefinition?.kind === 'ai' ? 'ai' : 'source',
    sourceBlockId: typeof sourceDefinition?.sourceBlockId === 'string' ? sourceDefinition.sourceBlockId : undefined,
    locator: sourceDefinition?.sourceLocator as SourceLocator | undefined,
    occurrences: mentions.map(item => ({
      blockId: String(item.blockId ?? ''),
      start: Number(item.startOffset ?? item.start ?? 0),
      end: Number(item.endOffset ?? item.end ?? 0),
      displayMode: item.displayMode === 'hover' ? 'hover' : 'anchor',
    })),
  }
}

function normalizeExploreNode(value: Record<string, unknown>): ExploreNode {
  const messages = Array.isArray(value.messages) ? value.messages as NonNullable<ExploreNode['messages']> : []
  const sources = Array.isArray(value.sources) ? value.sources as NonNullable<ExploreNode['sources']> : []
  const incoming = Array.isArray(value.edges) ? (value.edges as ExploreEdge[]).find(edge => edge.toNodeId === String(value.id) && edge.kind !== 'related') : undefined
  const snapshot = value.contextSnapshot as Record<string, unknown> | undefined
  const context = (value.context ?? snapshot?.context ?? snapshot?.payload ?? {}) as Record<string, unknown>
  return {
    id: String(value.id ?? value.nodeId ?? ''),
    nodeId: String(value.id ?? value.nodeId ?? ''),
    documentId: typeof value.documentId === 'string' ? value.documentId : undefined,
    chatId: typeof value.chatId === 'string' ? value.chatId : undefined,
    parentNodeId: typeof value.parentNodeId === 'string' ? value.parentNodeId : incoming?.fromNodeId,
    kind: String(value.kind ?? value.nodeKind ?? 'qa'),
    relationKind: (Array.isArray(value.edges)
      ? (value.edges as ExploreEdge[]).find(edge => edge.toNodeId === String(value.id) && edge.kind === 'related')?.kind ?? incoming?.kind
      : undefined) as ExploreNode['relationKind'],
    title: String(value.title ?? ''),
    question: messages.find(message => message.role === 'user')?.content ?? (typeof value.question === 'string' ? value.question : undefined),
    answer: [...messages].reverse().find(message => message.role === 'assistant')?.content ?? (typeof value.answer === 'string' ? value.answer : undefined),
    status: typeof value.status === 'string' ? value.status : undefined,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
    provider: typeof value.provider === 'string' ? value.provider : undefined,
    model: typeof value.model === 'string' ? value.model : undefined,
    sourceBlockId: sources.find(source => source.role === 'anchor')?.blockId,
    citations: sources.filter(source => source.role === 'evidence').map(source => ({ blockId: source.blockId, quote: source.quote, locator: source.locator })),
    messages,
    sources,
    context,
    origin: typeof value.origin === 'string' ? value.origin : typeof context.origin === 'string' ? context.origin : undefined,
  }
}

export const api: PlatformAdapter = {
  listDocuments: async () => (await request<Array<Record<string, unknown>>>('/api/documents')).map(normalizeDocument),
  startImport: async (files: File[]) => {
    const form = new FormData()
    for (const file of files) form.append('files', file)
    return request<{ jobId?: string; jobIds?: string[] }>('/api/imports', {
      method: 'POST',
      body: form,
    })
  },
  getImport: (jobId: string) => request<{ status: string; progress?: number; documents?: Array<Record<string, unknown>>; errors?: Array<{ name: string; message: string }>; error?: string | { message?: string } }>(`/api/imports/${encodeURIComponent(jobId)}`),
  cancelImport: (jobId: string) => request<void>(`/api/imports/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  getDocument: async (id: string) => normalizeDocument(await request<Record<string, unknown>>(`/api/documents/${encodeURIComponent(id)}`)),
  deleteDocument: (id: string) => request<void>(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reparseDocument: (id: string) => request<{ jobId: string }>(`/api/documents/${encodeURIComponent(id)}/reparse`, { method: 'POST' }),
  getTree: async (id: string) => {
    const data = await request<{ document?: Record<string, unknown>; versionId?: string; sections?: Section[]; tree?: Section[]; sectionEditsNeedReview?: number }>(`/api/documents/${encodeURIComponent(id)}/tree`)
    return { ...data, document: data.document ? normalizeDocument(data.document) : undefined }
  },
  getBlocks: async (id: string): Promise<ContentBlock[]> => {
    const result: ContentBlock[] = []
    const seenIds = new Set<string>()
    const seenSourceKeys = new Set<string>()
    let previousPage = ''
    for (let offset = 0; ; offset += 500) {
      const data = await request<Array<Record<string, unknown>> | { blocks?: Array<Record<string, unknown>> }>(`/api/documents/${encodeURIComponent(id)}/blocks?limit=500&offset=${offset}`)
      const raw = Array.isArray(data) ? data : data.blocks ?? []
      const pageKey = raw.map(item => String(item.id ?? item.blockId ?? item.sourceBlockKey ?? '')).join('|')
      if (pageKey && pageKey === previousPage) return result
      previousPage = pageKey
      for (const item of raw) {
        const block = normalizeBlock(item)
        if (!block.id || seenIds.has(block.id)) continue
        seenIds.add(block.id)
        const sourceKey = block.sourceBlockKey ? `${block.documentVersionId ?? ''}:${block.sourceBlockKey}` : ''
        if (sourceKey && seenSourceKeys.has(sourceKey)) continue
        if (sourceKey) seenSourceKeys.add(sourceKey)
        result.push(block)
      }
      if (raw.length < 500) return result
    }
  },
  getBlock: async (id: string) => normalizeBlock(await request<Record<string, unknown>>(`/api/blocks/${encodeURIComponent(id)}`)),
  getAssetUrl: (assetId: string) => `/api/assets/${encodeURIComponent(assetId)}`,
  updateSections: (id: string, edits: Array<Record<string, unknown>>) => request<unknown>(`/api/documents/${encodeURIComponent(id)}/sections`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ edits }),
  }),
  getTerms: async (id: string): Promise<Term[]> => {
    const data = await request<Array<Record<string, unknown>> | { terms?: Array<Record<string, unknown>> }>(`/api/documents/${encodeURIComponent(id)}/terms`)
    return (Array.isArray(data) ? data : data.terms ?? []).map(normalizeTerm)
  },
  listAnnotations: (id: string) => request<AnnotationRecord[]>(`/api/documents/${encodeURIComponent(id)}/annotations`),
  createAnnotation: (input: CreateAnnotationInput) => request<AnnotationRecord>('/api/annotations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }),
  deleteAnnotation: (id: string) => request<void>(`/api/annotations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearAnnotations: (documentId: string) => request<void>(`/api/documents/${encodeURIComponent(documentId)}/annotations`, { method: 'DELETE' }),
  getTerm: (id: string) => request<Term>(`/api/terms/${encodeURIComponent(id)}`),
  explainTerm: async (id: string) => normalizeTerm(await request<Record<string, unknown>>(`/api/terms/${encodeURIComponent(id)}/explain`, { method: 'POST' })),
  getGraph: async (id: string, chatId?: string) => {
    const query = new URLSearchParams({ documentId: id })
    if (chatId) query.set('chatId', chatId)
    const data = await request<{ nodes?: Array<Record<string, unknown>>; edges?: ExploreEdge[] } | Array<Record<string, unknown>>>(`/api/explore/nodes?${query}`)
    const rawNodes = Array.isArray(data) ? data : data.nodes ?? []
    const edges = Array.isArray(data) ? [] : data.edges ?? []
    const nodes = rawNodes.map(raw => {
      const node = normalizeExploreNode(raw)
      const parent = edges.find(edge => edge.toNodeId === node.id && edge.kind !== 'related')
      const related = edges.some(edge => edge.toNodeId === node.id && edge.kind === 'related')
      return { ...node, parentNodeId: node.parentNodeId ?? parent?.fromNodeId, relationKind: related ? 'related' : parent?.kind }
    })
    return { nodes, edges }
  },
  getChildren: (id: string) => request<ExploreNode[]>(`/api/explore/nodes/${encodeURIComponent(id)}/children`),
  createNode: async (payload: Record<string, unknown>) => normalizeExploreNode(await request<Record<string, unknown>>('/api/explore/nodes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })),
  createBranch: async (id: string, payload: Record<string, unknown>) => {
    const node = await request<ExploreNode>('/api/explore/nodes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, parentNodeId: payload.parentNodeId ?? id, kind: 'branch' }),
    })
    await request('/api/explore/edges', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromNodeId: id, toNodeId: nodeIdValue(node), kind: 'branch' }),
    })
    return node
  },
  createEdge: (payload: Record<string, unknown>) => request<ExploreEdge>('/api/explore/edges', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }),
  updateNode: (id: string, payload: Record<string, unknown>) => request<ExploreNode>(`/api/explore/nodes/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }),
  deleteNode: (id: string) => request<void>(`/api/explore/branches/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  ask: async (payload: Record<string, unknown>) => {
    const data = await request<{ node?: Record<string, unknown>; answer?: string; citations?: ExploreNode['citations']; foundEvidence?: boolean }>('/api/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    return { ...data, node: data.node ? normalizeExploreNode(data.node) : undefined }
  },
  listChats: async (documentId: string) => (await request<Array<{ id?: string; chatId?: string; title: string }>>(`/api/chats?documentId=${encodeURIComponent(documentId)}`)).map(value => ({ chatId: String(value.chatId ?? value.id ?? ''), title: value.title })),
  createChat: async (payload: Record<string, unknown>) => {
    const value = await request<{ id?: string; chatId?: string; title?: string }>('/api/chats', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    return { chatId: String(value.chatId ?? value.id ?? ''), title: value.title ?? String(payload.title ?? '新的探索') }
  },
  getExploreState: (chatId: string) => request<ExploreViewState | null>(`/api/explore/state/${encodeURIComponent(chatId)}`),
  saveExploreState: (chatId: string, state: ExploreViewState) => request<void>(`/api/explore/state/${encodeURIComponent(chatId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state), keepalive: true }),
  getReaderView: (documentId?: string): ReaderViewState => {
    try { return JSON.parse(localStorage.getItem(documentId ? `decklens:view:${documentId}` : 'decklens:last-view') ?? '{}') as ReaderViewState }
    catch { return {} }
  },
  saveReaderView: (state: ReaderViewState) => {
    try {
      localStorage.setItem('decklens:last-view', JSON.stringify({ documentId: state.documentId }))
      if (state.documentId) localStorage.setItem(`decklens:view:${state.documentId}`, JSON.stringify(state))
    } catch { /* Reading still works when browser storage is disabled. */ }
  },
  listMessages: (chatId: string) => request<unknown[]>(`/api/chats/${encodeURIComponent(chatId)}/messages`),
  createMessage: (chatId: string, payload: Record<string, unknown>) => request<unknown>(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }),
  getSettings: async () => {
    const value = await request<Record<string, unknown>>('/api/settings')
    return { provider: String(value.provider ?? 'openai-compatible') as ProviderSettings['provider'], baseUrl: String(value.baseUrl ?? ''), model: String(value.model ?? ''), keyConfigured: Boolean(value.keyConfigured ?? value.hasApiKey) }
  },
  saveSettings: async (settings: Omit<ProviderSettings, 'keyConfigured'>) => {
    const value = await request<Record<string, unknown>>('/api/settings/provider', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings),
    })
    return { provider: String(value.provider ?? settings.provider) as ProviderSettings['provider'], baseUrl: String(value.baseUrl ?? settings.baseUrl), model: String(value.model ?? settings.model), keyConfigured: Boolean(value.keyConfigured ?? value.hasApiKey) }
  },
  listProviderProfiles: async () => {
    const value = await request<{ profiles?: Array<Record<string, unknown>>; activeId?: string | null }>('/api/providers')
    return { profiles: (value.profiles ?? []).map(normalizeProviderProfile), activeId: value.activeId ?? null }
  },
  saveProviderProfile: async (profile: ProviderProfileInput) => {
    const { id, ...payload } = profile
    return normalizeProviderProfile(await request<Record<string, unknown>>(id ? `/api/providers/${encodeURIComponent(id)}` : '/api/providers', {
      method: id ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
  },
  activateProviderProfile: async (profileId: string) => normalizeProviderProfile(await request<Record<string, unknown>>(`/api/providers/${encodeURIComponent(profileId)}/activate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })),
  deleteProviderProfile: (profileId: string) => request<void>(`/api/providers/${encodeURIComponent(profileId)}`, { method: 'DELETE' }),
  clearProviderApiKey: (profileId: string) => request<void>(`/api/providers/${encodeURIComponent(profileId)}/key`, { method: 'DELETE' }),
  testProviderProfile: (profileId: string) => request<{ ok: boolean; message: string; model: string }>(`/api/providers/${encodeURIComponent(profileId)}/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }),
  completeModelChat: async (payload: ModelChatRequest) => {
    const response = await modelRequest(payload, false)
    const value = await response.json() as { text?: unknown }
    if (typeof value.text !== 'string') throw new Error('模型服务没有返回文本。')
    return value.text
  },
  streamModelChat: async (payload: ModelChatRequest, onToken: (token: string) => void) => consumeModelStream(await modelRequest(payload, true), onToken),
  openSecretConfig: () => request<void>('/api/settings/secret/open', { method: 'POST' }),
  clearSecret: () => request<void>('/api/settings/secret', { method: 'DELETE' }),
  clearData: () => request<void>('/api/settings/clear-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE_LOCAL_DATA' }) }),
}

function nodeIdValue(node: ExploreNode) { return node.nodeId || node.id }

function normalizeBlock(value: Record<string, unknown>): ContentBlock {
  return {
    id: String(value.id ?? value.blockId ?? ''),
    sourceBlockKey: typeof value.sourceBlockKey === 'string' ? value.sourceBlockKey : undefined,
    parentBlockId: typeof value.parentBlockId === 'string' ? value.parentBlockId : undefined,
    sourceOrder: typeof value.sourceOrder === 'number' ? value.sourceOrder : undefined,
    sectionId: typeof value.sectionId === 'string' ? value.sectionId : undefined,
    type: String(value.type ?? value.blockType ?? 'paragraph'),
    plainText: String(value.text ?? value.plainText ?? ''),
    text: String(value.text ?? value.plainText ?? ''),
    locator: (value.sourceLocator ?? value.locator) as SourceLocator | undefined,
    sourceLocator: (value.sourceLocator ?? value.locator) as SourceLocator | undefined,
    documentVersionId: typeof value.documentVersionId === 'string' ? value.documentVersionId : undefined,
    payload: value.payload && typeof value.payload === 'object' ? value.payload as Record<string, unknown> : {},
    order: typeof value.order === 'number' ? value.order : 0,
  }
}
