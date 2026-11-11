/** DESIGN ONLY: no runtime values, live exports, transport handlers, or migrations. */
export type Id<K extends string> = string & { readonly __kind: K };
export type DocumentId = Id<"document">;
export type VersionId = Id<"version">;
export type SectionId = Id<"section">;
export type BlockId = Id<"block">;
export type AssetId = Id<"asset">;
export type NodeId = Id<"node">;
export type ChatId = Id<"chat">;
export type AnnotationId = Id<"annotation">;
export type ProviderId = Id<"provider">;
export type ModelId = Id<"model">;
export type ISODate = string;
export type DocumentFormat = "pptx" | "docx" | "pdf" | "markdown" | "txt";
export type Capability = "supported" | "unsupported" | "unknown";
export interface DesignError { code: string; message: string; retryable: boolean }
export interface PageRequest { cursor?: string; limit?: number }
export interface Page<T> { items: T[]; nextCursor?: string }

export interface Document {
  id: DocumentId; title: string; originalName: string; format: DocumentFormat;
  mimeType: string; sizeBytes: number; sourceHash: string;
  language: string; status: "importing" | "ready" | "failed" | "archived";
  activeVersionId?: VersionId; createdAt: ISODate; updatedAt: ISODate;
}
export interface DocumentVersion {
  id: VersionId; documentId: DocumentId; versionNumber: number; sourceHash: string;
  parserId: string; parserVersion: string; modelSchemaVersion: number;
  parserOptions: Record<string, unknown>; pageCount?: number;
  status: "pending" | "parsing" | "ready" | "failed" | "cancelled";
  extraction: "native" | "mixed" | "ocr"; warnings: DesignError[];
  blockCount: number; sectionCount: number; createdAt: ISODate; completedAt?: ISODate;
}
export interface SourceLocator {
  documentId: DocumentId; documentVersionId: VersionId; format: DocumentFormat;
  sourceHash: string; sectionId?: SectionId; blockId?: BlockId;
  sourceKey?: string; sourceSectionKey?: string; sectionPath?: string[];
  pageNumber?: number; pageLabel?: string; slideNumber?: number;
  lineStart?: number; lineEnd?: number; charStart?: number; charEnd?: number; paragraphIndex?: number;
  nativePath?: string; excerpt?: string; boundingBoxes?: Geometry[];
  extractionMethod: "native" | "text-layer" | "ocr"; isApproximate: boolean; confidence?: number;
}
export interface Section {
  id: SectionId; documentId: DocumentId; documentVersionId: VersionId; parentSectionId?: SectionId;
  sourceKey: string; title: string; depth: number; sourceOrder: number;
  displayOrder: number; origin: "parser" | "manual"; sourceLocator: SourceLocator;
  createdAt: ISODate; updatedAt: ISODate;
}
export interface TextRun {
  text: string; emphasis?: boolean; strong?: boolean; strike?: boolean;
  href?: string; inlineMath?: string;
}
export interface ListItem { id: string; level: number; runs: TextRun[]; children: ListItem[]; checked?: boolean }
export interface TableCell {
  row: number; column: number; rowSpan: number; columnSpan: number; header: boolean; runs: TextRun[];
}
export interface BlockPayloads {
  heading: { level: number; runs: TextRun[] };
  paragraph: { runs: TextRun[]; alignment?: "start" | "center" | "end"; indent?: number };
  list: { ordered: boolean; start?: number; items: ListItem[] };
  table: { rows: TableCell[][]; headerRows: number; caption?: string };
  image: { assetId: AssetId; alt: string; caption?: string; intrinsicWidth?: number; intrinsicHeight?: number;
    crop?: { left: number; top: number; right: number; bottom: number }; rotation?: number };
  formula: { representation: "latex" | "mathml" | "omml" | "text"; raw: string; display: boolean; fallbackAssetId?: AssetId };
  code: { code: string; language?: string; fenceInfo?: string };
  note: { noteKind: "speaker-note" | "footnote" | "endnote" | "comment" | "general";
    runs: TextRun[]; author?: string; referenceBlockId?: BlockId };
  quote: { runs: TextRun[]; attribution?: string };
  divider: { nativeMarker?: string };
  unsupported: { nativeType: string; reason: string; fallbackAssetId?: AssetId; rawText?: string };
}
export type BlockKind = keyof BlockPayloads;
export interface BlockBase {
  id: BlockId; documentId: DocumentId; documentVersionId: VersionId; sectionId: SectionId;
  sourceKey: string; sourceKeyAliases: string[]; sourceOrder: number;
  displayOrder: number; parentBlockId?: BlockId; plainText: string; contentHash: string;
  language: string; sourceLocator: SourceLocator;
  extraction: { method: "native" | "text-layer" | "ocr"; confidence?: number; warnings: DesignError[]; isApproximate: boolean };
}
export type Block = { [K in BlockKind]: BlockBase & { type: K; payload: BlockPayloads[K] } }[BlockKind];
export interface Asset {
  id: AssetId; documentId: DocumentId;
  kind: "image" | "attachment" | "preview";
  mimeType: string; sizeBytes: number; sha256: string; width?: number; height?: number;
  createdAt: ISODate;
}
export interface BlockAsset {
  documentId: DocumentId; documentVersionId: VersionId; blockId: BlockId; assetId: AssetId;
  role: "embedded" | "preview" | "attachment"; ordinal: number;
  placement: Record<string, unknown>; originalPartPath?: string; altText: string;
}
export interface AssetContent { assetId: AssetId; mimeType: string; bytes: Uint8Array }
export interface TextSelector {
  startOffset: number; endOffset: number; offsetUnit: "utf16"; normalization: "decklens-text-v1";
  exactQuote: string; prefix: string; suffix: string; blockTextHash: string;
}
export interface Point { x: number; y: number; pressure?: number; elapsedMs?: number }
export type CoordinateSpace = "normalized-page" | "normalized-block" | "normalized-image";
export interface GeometryReference {
  space: CoordinateSpace; width: number; height: number; rotation: number;
  contentHash: string; pageNumber?: number; assetId?: AssetId;
  layoutFingerprint?: string; snapshotAssetId?: AssetId;
}
export type Geometry = { reference: GeometryReference } & (
  | { kind: "polyline" | "polygon"; points: Point[] }
  | { kind: "rect" | "ellipse"; x: number; y: number; width: number; height: number }
  | { kind: "point"; x: number; y: number }
);
export interface AnnotationTargetBase {
  id: Id<"annotation_target">; sourceLocator: SourceLocator; order: number;
}
export type AnnotationTarget = AnnotationTargetBase & (
  | { kind: "text"; blockId: BlockId; selector: TextSelector }
  | { kind: "block"; blockId: BlockId }
  | { kind: "region"; blockId?: BlockId; assetId?: AssetId; geometry: Geometry }
  | { kind: "document" }
);
export interface Annotation {
  id: AnnotationId; documentId: DocumentId; kind: "note" | "highlight" | "underline" | "strike" | "shape" | "freehand";
  tool: "pointer" | "pen" | "highlighter" | "eraser" | "lasso"; origin: "user";
  targets: AnnotationTarget[]; title: string; bodyMarkdown: string; style: { colorToken: string; width: number; opacity: number };
  revision: number; createdAt: ISODate; updatedAt: ISODate; deletedAt?: ISODate;
}
export interface AnnotationBinding {
  targetId: Id<"annotation_target">; targetVersionId: VersionId; segmentIndex: number;
  status: "exact" | "fuzzy" | "manual" | "orphaned" | "ambiguous" | "layout_stale";
  resolvedTarget?: AnnotationTarget; confidence?: number; method: string;
  candidateTargets?: AnnotationTarget[]; reason?: string; confirmedByUser: boolean;
}
export interface SourceRef {
  id: Id<"source_ref">; sourceDocumentId: DocumentId;
  sourceType: "document" | "user_annotation"; locator: SourceLocator;
  blockId: BlockId; chunkId?: Id<"chunk">;
  annotationId?: AnnotationId; annotationTargetId?: Id<"annotation_target">;
  annotationBindingId?: Id<"annotation_binding">; assetId?: AssetId;
  textSelector?: TextSelector; geometry?: Geometry; quote: string;
}
/** Chat-scoped authorization belongs to the evidence link, not the immutable source. */
export interface ChatSourceRef extends SourceRef {
  ownerDocumentId: DocumentId; chatId: ChatId; grantId: Id<"source_grant">;
  role: "anchor" | "evidence" | "context" | "related"; retrievalRank?: number;
}
export type ExploreNodeKind = "root" | "source" | "qa" | "deepen" | "relate" | "branch";
export interface NodeMessage {
  id: Id<"message">; role: "user" | "assistant"; content: string;
  status: "pending" | "streaming" | "complete" | "failed" | "cancelled";
  ordinal: number; sources: ChatSourceRef[]; createdAt: ISODate; completedAt?: ISODate;
}
export interface ExploreNode {
  id: NodeId; documentId: DocumentId; chatId: ChatId; kind: ExploreNodeKind; title: string;
  status: "pending" | "streaming" | "complete" | "failed" | "cancelled";
  origin: "document" | "ai" | "user" | "system" | "mixed";
  contextSnapshotId?: Id<"context_snapshot">; providerId?: ProviderId; modelId?: ModelId;
  modelSnapshot?: ModelExecutionSnapshot;
  messages: NodeMessage[]; sources: ChatSourceRef[]; disclaimer?: string;
  createdAt: ISODate; updatedAt: ISODate; deletedAt?: ISODate;
}
export interface ExploreEdgeBase {
  id: Id<"edge">; chatId: ChatId; fromNodeId: NodeId; toNodeId: NodeId;
  order: number; label?: string; createdAt: ISODate;
}
export type ExploreEdge = ExploreEdgeBase & (
  | { role: "tree"; relation: "source" | "qa" | "deepen" | "relate" | "branch" }
  | { role: "reference"; relation: "related" | "supports" | "contradicts" }
);
/** Derived transport convenience only; never a second persisted parent relation. */
export interface ExploreNodeDto extends ExploreNode { derivedParentNodeId?: NodeId }
export interface ExploreGraph { nodes: ExploreNodeDto[]; edges: ExploreEdge[] }
export interface ModelCapabilities {
  textInput: Capability; imageInput: Capability; streaming: Capability; tools: Capability; structuredOutput: Capability;
}
export interface ModelExecutionSnapshot {
  providerId: ProviderId; modelId: ModelId; providerName: string;
  providerKind: ProviderProfile["providerKind"]; protocol: ProviderProfile["protocol"];
  baseUrl: string; configVersion: number; modelName: string; capabilities: ModelCapabilities;
  actualParameters: { temperature?: number; topP?: number; maxOutputTokens?: number; seed?: number };
  capturedAt: ISODate;
}
export interface ContextSnapshot {
  id: Id<"context_snapshot">; documentId: DocumentId; chatId: ChatId; parentSnapshotId?: Id<"context_snapshot">;
  ancestorNodeIds: NodeId[]; documentVersionIds: VersionId[]; messages: AIMessage[];
  sources: ChatSourceRef[]; annotationIds: AnnotationId[]; retrievalQuery: string;
  modelSnapshot?: ModelExecutionSnapshot;
  policyVersion: string; tokenBudget: number; estimatedTokens: number;
  truncation: { truncated: boolean; omittedNodeIds: NodeId[]; reason?: string };
  snapshotHash: string; createdAt: ISODate;
}
export interface ExploreViewState {
  chatId: ChatId; viewId: string; activeNodeId?: NodeId; activeBlockId?: BlockId;
  activeVersionId?: VersionId; textOffset?: number; expandedNodeIds: NodeId[];
  branchChoices: Record<string, NodeId>; breadcrumbPath: NodeId[];
  collapsedCardIds: NodeId[]; cardScrollOffsets: Record<string, number>;
  activeTab: "reading" | "exploration";
  panelState: { leftCollapsed: boolean; rightCollapsed: boolean };
  selectedAnnotationIds: AnnotationId[]; revision: number; updatedAt?: ISODate;
}
export interface Chat { id: ChatId; documentId: DocumentId; title: string; status: "active" | "archived"; createdAt: ISODate; updatedAt: ISODate }

/** BACKEND ONLY. secretRef is an opaque credential handle, never a filesystem path. */
export interface ProviderProfile {
  id: ProviderId; name: string; providerKind: "openai" | "deepseek" | "ollama" | "anthropic" | "custom";
  protocol: "openai-chat" | "openai-responses" | "ollama-chat" | "anthropic-messages"; baseUrl: string;
  authMode: "bearer" | "x-api-key" | "none"; secretRef?: Id<"secret">; enabled: boolean;
  configVersion: number; options: { timeoutMs: number }; createdAt: ISODate; updatedAt: ISODate;
}
export type ProviderPublicDto = Omit<ProviderProfile, "secretRef"> & { keyConfigured: boolean };
export interface ModelProfile {
  id: ModelId; providerId: ProviderId; modelName: string; displayName: string;
  capabilities: ModelCapabilities; limits: { contextWindow?: number; maxOutputTokens?: number };
  defaultParameters: { temperature?: number; maxOutputTokens?: number }; enabled: boolean;
  capabilitySource: "declared" | "discovered" | "probed" | "user"; capabilityCheckedAt?: ISODate;
  createdAt: ISODate; updatedAt: ISODate;
}
export type AIContent = { kind: "text"; text: string } | { kind: "image"; assetId: AssetId; mimeType: string };
export interface AIMessage { role: "system" | "user" | "assistant"; content: AIContent[] }
export interface AIRequest {
  requestId: Id<"ai_request">; messages: AIMessage[]; allowedSourceRefIds: Id<"source_ref">[];
  temperature?: number; maxOutputTokens?: number;
}
export interface TokenUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface AIResponse { requestId: Id<"ai_request">; text: string; usage?: TokenUsage; finishReason: string }
export type NormalizedAIEvent =
  | { type: "start"; requestId: Id<"ai_request">; modelId: ModelId }
  | { type: "text_delta"; text: string }
  | { type: "citation_candidate"; sourceRefId: Id<"source_ref"> }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; response: AIResponse }
  | { type: "error"; error: DesignError };
export type AnswerEvent = Exclude<NormalizedAIEvent, { type: "citation_candidate" }> | { type: "citation"; source: ChatSourceRef };
export interface ProviderTestResult { reachable: boolean; modelAvailable: Capability; capabilities: ModelCapabilities; error?: DesignError }
/** BACKEND ONLY. Absent from PlatformAdapter, public DTOs, and renderer imports. */
export interface AIBackendContext {
  provider: ProviderProfile; model: ModelProfile; signal?: AbortSignal;
  resolveSecret: (secretRef: Id<"secret">) => Promise<{ apiKey: string }>;
  readAsset: (assetId: AssetId) => Promise<AssetContent>;
}
export interface AIAdapter {
  generate(request: AIRequest, context: AIBackendContext): Promise<AIResponse>;
  stream(request: AIRequest, context: AIBackendContext): AsyncIterable<NormalizedAIEvent>;
  test(context: AIBackendContext): Promise<ProviderTestResult>;
}

export interface DocumentTree { document: Document; version: DocumentVersion; sections: Section[]; outlineRevision: number }
export interface BlockPage extends Page<Block> { documentVersionId: VersionId }
export type SectionEdit =
  | { operation: "rename"; sectionId: SectionId; title: string }
  | { operation: "move"; sectionId: SectionId; parentSectionId?: SectionId; beforeSectionId?: SectionId }
  | { operation: "split"; sectionId: SectionId; atBlockId: BlockId; title: string }
  | { operation: "merge"; sectionId: SectionId; targetSectionId: SectionId }
  | { operation: "reorder"; sectionId: SectionId; blockIds: BlockId[] };
export interface ImportFileInfo { name: string; sizeBytes: number; mimeType?: string }
export interface ImportTicket { uploadId: Id<"upload">; maxChunkBytes: number }
export type ImportOptions = { scope: "library" } | { scope: "question"; draftId: Id<"draft">; revision: number };
export interface ImportJob {
  id: Id<"import_job">; status: "queued" | "processing" | "complete" | "failed" | "cancelled";
  progress: number; documents: Array<{ documentId: DocumentId; duplicate: boolean }>;
  attachmentIds: Id<"question_attachment">[]; errors: DesignError[];
}
export interface Term {
  id: Id<"term">; documentId: DocumentId; text: string; language: string;
  definitions: Array<{ kind: "source" | "ai"; text: string; sources: SourceRef[]; disclaimer?: string; modelId?: ModelId }>;
  mentions: Array<{ blockId: BlockId; selector: TextSelector; displayMode: "anchor" | "hover" | "hidden" }>;
}
export interface SourceSelection { blockId?: BlockId; selector?: TextSelector; annotationId?: AnnotationId; targetIds?: Id<"annotation_target">[] }
export interface CreateExploreInput {
  documentId: DocumentId; chatId: ChatId; kind: Exclude<ExploreNodeKind, "root">;
  parentNodeId?: NodeId; title?: string; question?: string; termId?: Id<"term">;
  selections: SourceSelection[]; draftId?: Id<"draft">; draftRevision?: number; modelId?: ModelId;
}
export interface AskResult { node: ExploreNodeDto; citations: ChatSourceRef[]; foundEvidence: boolean }
export interface DocumentMethods {
  list(page?: PageRequest): Promise<Page<Document>>;
  get(id: DocumentId): Promise<Document>;
  tree(id: DocumentId, versionId?: VersionId): Promise<DocumentTree>;
  versions(id: DocumentId): Promise<DocumentVersion[]>;
  reparse(id: DocumentId): Promise<ImportJob>;
  remove(id: DocumentId): Promise<void>;
}
export interface SectionMethods {
  list(documentId: DocumentId, versionId?: VersionId): Promise<Section[]>;
  edit(documentId: DocumentId, versionId: VersionId, revision: number, edits: SectionEdit[]): Promise<DocumentTree>;
}
export interface BlockMethods {
  list(documentId: DocumentId, query?: PageRequest & { versionId?: VersionId; sectionId?: SectionId }): Promise<BlockPage>;
  get(id: BlockId): Promise<Block>;
}
export interface AssetMethods { metadata(id: AssetId): Promise<Asset>; content(id: AssetId): Promise<AssetContent> }
export interface ImportMethods {
  begin(files: ImportFileInfo[], options: ImportOptions): Promise<ImportTicket[]>;
  append(uploadId: Id<"upload">, offset: number, bytes: Uint8Array): Promise<{ acceptedBytes: number }>;
  commit(uploadIds: Id<"upload">[]): Promise<ImportJob>;
  get(jobId: Id<"import_job">): Promise<ImportJob>;
  cancel(jobId: Id<"import_job">): Promise<void>;
  observe(jobId: Id<"import_job">): AsyncIterable<ImportJob>;
}
export interface TermMethods {
  list(documentId: DocumentId): Promise<Term[]>;
  get(id: Id<"term">): Promise<Term>;
  explain(id: Id<"term">, modelId?: ModelId): Promise<Term>;
}
export interface AnnotationMethods {
  list(documentId: DocumentId, versionId?: VersionId): Promise<Annotation[]>;
  create(input: Omit<Annotation, "id" | "revision" | "createdAt" | "updatedAt" | "deletedAt">): Promise<Annotation>;
  update(id: AnnotationId, revision: number, patch: Pick<Annotation, "targets" | "title" | "bodyMarkdown" | "style">): Promise<Annotation>;
  remove(id: AnnotationId, revision: number): Promise<void>;
  bindings(documentId: DocumentId, versionId: VersionId): Promise<AnnotationBinding[]>;
  confirmBinding(targetId: Id<"annotation_target">, versionId: VersionId, targets: AnnotationTarget[]): Promise<AnnotationBinding[]>;
}
export interface ExploreMethods {
  graph(documentId: DocumentId, chatId: ChatId): Promise<ExploreGraph>;
  node(id: NodeId): Promise<ExploreNodeDto>;
  create(input: CreateExploreInput): Promise<ExploreNodeDto>;
  ask(input: CreateExploreInput & { question: string }): Promise<AskResult>;
  observeAnswer(nodeId: NodeId): AsyncIterable<AnswerEvent>;
  cancelAnswer(nodeId: NodeId): Promise<void>;
  rename(id: NodeId, title: string): Promise<ExploreNodeDto>;
  addReference(from: NodeId, to: NodeId, label?: string): Promise<ExploreEdge>;
  removeBranch(id: NodeId): Promise<void>;
}
export interface ChatMethods {
  list(documentId: DocumentId): Promise<Chat[]>;
  create(documentId: DocumentId, title: string): Promise<Chat>;
  rename(chatId: ChatId, title: string): Promise<Chat>;
  remove(chatId: ChatId): Promise<void>;
}
export interface SnapshotMethods { get(id: Id<"context_snapshot">): Promise<ContextSnapshot> }
export interface ProviderMethods {
  list(): Promise<ProviderPublicDto[]>;
  get(id: ProviderId): Promise<ProviderPublicDto>;
  save(input: Omit<ProviderPublicDto, "id" | "keyConfigured" | "createdAt" | "updatedAt"> & { id?: ProviderId }): Promise<ProviderPublicDto>;
  remove(id: ProviderId): Promise<void>;
  test(providerId: ProviderId): Promise<ProviderTestResult>;
  secretStatus(providerId: ProviderId): Promise<{ configured: boolean }>;
  openSecretEditor(providerId: ProviderId): Promise<{ opened: boolean; instructions: string }>;
  clearSecret(providerId: ProviderId): Promise<void>;
}
export interface ModelMethods {
  list(providerId?: ProviderId): Promise<ModelProfile[]>;
  save(input: { id?: ModelId; providerId: ProviderId; modelName: string; displayName: string;
    enabled: boolean; declaredCapabilities?: Partial<ModelCapabilities>; limits: ModelProfile["limits"];
    defaultParameters: ModelProfile["defaultParameters"] }): Promise<ModelProfile>;
  remove(id: ModelId): Promise<void>;
  test(id: ModelId): Promise<ProviderTestResult>;
}
export interface ExplorationDraft {
  id: Id<"draft">; ownerDocumentId: DocumentId; chatId: ChatId; parentNodeId?: NodeId;
  action: "qa" | "deepen" | "relate" | "branch"; entryPoint: "global" | "selection" | "node" | "term";
  questionText: string; selections: SourceSelection[]; attachmentIds: Id<"question_attachment">[];
  contextSnapshotId?: Id<"context_snapshot">; modelId?: ModelId; revision: number;
  status: "active" | "submitted" | "discarded"; submittedNodeId?: NodeId; createdAt: ISODate; updatedAt: ISODate;
}
export interface QuestionAttachment {
  id: Id<"question_attachment">; draftId: Id<"draft">; chatId: ChatId; ownerDocumentId: DocumentId;
  sourceDocumentId?: DocumentId; sourceVersionId?: VersionId; grantId?: Id<"source_grant">;
  importJobId?: Id<"import_job">; originalName: string; status: "pending" | "parsing" | "ready" | "failed" | "removed";
  ordinal: number; error?: DesignError; createdAt: ISODate; updatedAt: ISODate;
}
export interface ChatSourceGrant {
  id: Id<"source_grant">; chatId: ChatId; ownerDocumentId: DocumentId; sourceDocumentId: DocumentId;
  role: "primary" | "attachment"; createdAt: ISODate;
}
export interface DraftMethods {
  list(chatId: ChatId): Promise<ExplorationDraft[]>;
  save(draft: Omit<ExplorationDraft, "id" | "createdAt" | "updatedAt" | "contextSnapshotId" | "status" | "submittedNodeId"> & { id?: Id<"draft"> }): Promise<ExplorationDraft>;
  attachments(draftId: Id<"draft">): Promise<QuestionAttachment[]>;
  removeAttachment(draftId: Id<"draft">, attachmentId: Id<"question_attachment">, revision: number): Promise<void>;
  remove(id: Id<"draft">, revision: number): Promise<void>;
}
export interface ViewStateMethods {
  get(chatId: ChatId, viewId: string): Promise<ExploreViewState | undefined>;
  save(state: ExploreViewState): Promise<void>;
}
export interface ReaderPreferences {
  fontScale: number; anchorsPerViewport: number; showSourceLabels: boolean;
}
export interface UserSettings {
  "ui.language": "zh-CN" | "en";
  "reader.preferences": ReaderPreferences;
  "ai.defaults.modelId": ModelId | null;
}
export interface SettingsMethods {
  get(): Promise<UserSettings>;
  save(patch: Partial<UserSettings>): Promise<UserSettings>;
}
export interface ExportRequest {
  kind: "backup" | "readable"; documentIds?: DocumentId[]; includeOriginals: boolean;
  includeAnnotations: boolean; includeExplorations: boolean; settings: "none" | "public_only";
}
export interface ExportJob {
  id: Id<"export_job">; status: "queued" | "processing" | "complete" | "failed";
  downloadReady: boolean; errors: DesignError[];
}
export interface CleanupPlan {
  id: Id<"cleanup_plan">; categories: Array<"temporary_imports" | "unreferenced_assets" | "expired_exports">;
  itemCount: number; estimatedBytes: number; expiresAt: ISODate;
}
export interface DataMaintenanceMethods {
  status(): Promise<{ schemaVersion: number; documentCount: number; sizeBytes: number; pendingMigrations: boolean }>;
  createExport(input: ExportRequest): Promise<ExportJob>;
  exportStatus(id: Id<"export_job">): Promise<ExportJob>;
  exportContent(id: Id<"export_job">): Promise<{ mimeType: string; bytes: Uint8Array }>;
  removeExport(id: Id<"export_job">): Promise<void>;
  planCleanup(categories: CleanupPlan["categories"]): Promise<CleanupPlan>;
  cleanup(planId: Id<"cleanup_plan">): Promise<{ removedItems: number; freedBytes: number }>;
  clearDocuments(input: { confirm: "DELETE_LOCAL_DOCUMENTS" }): Promise<void>;
}
/** UI boundary: identical method semantics over local HTTP or future allowlisted IPC. */
export interface PlatformAdapter {
  documents: DocumentMethods; imports: ImportMethods; sections: SectionMethods;
  blocks: BlockMethods; assets: AssetMethods; terms: TermMethods;
  annotations: AnnotationMethods; explorations: ExploreMethods; chats: ChatMethods;
  snapshots: SnapshotMethods; providers: ProviderMethods; models: ModelMethods;
  drafts: DraftMethods; viewState: ViewStateMethods; settings: SettingsMethods; data: DataMaintenanceMethods;
}
