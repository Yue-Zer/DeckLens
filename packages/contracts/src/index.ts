export type DocumentFormat = "pptx" | "markdown" | "txt";
export type BlockType = "heading" | "paragraph" | "list" | "table" | "image" | "formula" | "code" | "note";
export type NodeKind = "qa" | "explanation" | "note";
export type EdgeKind = "deepens" | "branch" | "related";

export interface SourceLocator {
  format: DocumentFormat;
  sourceHash: string;
  documentVersionId: string;
  sectionId?: string;
  blockId?: string;
  pageNumber?: number;
  slideNumber?: number;
  lineStart?: number;
  lineEnd?: number;
  paragraphIndex?: number;
  elementPath?: string;
  headingPath?: string[];
  textStart?: number;
  textEnd?: number;
  excerpt?: string;
  confidence?: number;
}

export type AnnotationTool = "pen" | "highlighter" | "lasso";
export interface AnnotationPoint { x: number; y: number }
export interface AnnotationTarget {
  blockId: string;
  shape: "path" | "polygon";
  points: AnnotationPoint[];
  strokeRatio: number;
}
export interface AnnotationRecord {
  id: string;
  documentId: string;
  versionId: string;
  tool: AnnotationTool;
  targets: AnnotationTarget[];
  createdAt: string;
}
export interface CreateAnnotationInput {
  documentId: string;
  tool: AnnotationTool;
  targets: AnnotationTarget[];
}

export interface DocumentRecord {
  id: string;
  sourceHash: string;
  originalName: string;
  extension: string;
  format: DocumentFormat;
  mimeType: string;
  sizeBytes: number;
  sourceRelativePath: string;
  title: string;
  language: string;
  status: "ready" | "partial" | "error";
  activeVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BlockRecord {
  id: string;
  documentVersionId: string;
  sectionId: string;
  sourceBlockKey: string;
  parentBlockId?: string;
  /** Immutable, zero-based source reading order across the entire parse version. */
  sourceOrder: number;
  /** Display order within the current section; manual section edits may change it. */
  order: number;
  type: BlockType;
  text: string;
  payload: Record<string, unknown>;
  sourceLocator: SourceLocator;
}

export interface SectionRecord {
  id: string;
  documentVersionId: string;
  sourceSectionKey: string;
  parentId?: string;
  title: string;
  depth: number;
  sourceOrder: number;
  displayOrder: number;
  origin: "parser" | "manual";
  sourceLocator?: SourceLocator;
  blocks: BlockRecord[];
  children: SectionRecord[];
}

export interface TermMention {
  id: string;
  termId: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  matchedText: string;
  displayMode: "anchor" | "hover";
}

export interface TermDefinition {
  id: string;
  termId: string;
  kind: "source" | "ai";
  text: string;
  sourceBlockId?: string;
  sourceLocator?: SourceLocator;
  disclaimer?: string;
  provider?: string;
  model?: string;
}

export interface TermRecord {
  id: string;
  documentId: string;
  canonicalText: string;
  normalizedText: string;
  language: string;
  definitions: TermDefinition[];
  mentions: TermMention[];
}

export interface DocumentTree {
  document: DocumentRecord;
  versionId: string;
  sections: SectionRecord[];
  sectionEditsNeedReview?: number;
  sourceConflictsNeedReview?: number;
}

export interface ExploreNode {
  id: string;
  documentId: string;
  chatId: string;
  parentNodeId?: string;
  kind: NodeKind;
  title: string;
  status: "complete" | "pending" | "failed" | "cancelled";
  contextSnapshotId?: string;
  origin?: "source" | "ai" | "local";
  context?: Record<string, unknown>;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string }>;
  sources: Array<{
    id: string;
    role: "anchor" | "evidence" | "context";
    documentVersionId: string;
    blockId: string;
    chunkId?: string;
    startOffset?: number;
    endOffset?: number;
    quote: string;
    locator: SourceLocator;
  }>;
  edges: ExploreEdge[];
}

/** Geometry is derived from source anchors; only durable navigation is stored. */
export interface FloatingCardsState {
  openNodeIds: string[];
  activeCardId?: string;
  cardScrollOffsets?: Record<string, number>;
}

export interface ExploreViewState {
  viewId?: string;
  activeNodeId?: string;
  activeVersionId?: string;
  activeBlockId?: string;
  textOffset?: number;
  scrollAnchor?: string;
  expandedNodes?: string[];
  branchChoices?: Record<string, string>;
  floatingCards?: FloatingCardsState;
}

export interface ExploreEdge {
  id: string;
  chatId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
  branchGroupId?: string;
  label?: string;
  orderIndex: number;
  createdAt: string;
}

export type ProviderKind = "openai-compatible" | "deepseek" | "ollama" | "anthropic" | "custom";
export type ProviderProtocol = "openai-chat" | "ollama-chat" | "anthropic-messages";

export interface ProviderProfile {
  id: string;
  name: string;
  providerKind: ProviderKind;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
  hasApiKey: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfileInput {
  id?: string;
  name: string;
  providerKind: ProviderKind;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
  apiKey?: string;
  activate?: boolean;
}

export interface ProviderSettings {
  provider: "openai-compatible" | "deepseek" | "ollama";
  profileId?: string;
  name?: string;
  protocol?: ProviderProtocol;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  hasApiKey: boolean;
}

export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image"; dataUrl: string }>;
};

export interface ModelChatRequest {
  profileId?: string;
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  model: string;
}

export interface ImportResult {
  document: DocumentRecord;
  duplicate: boolean;
  tree: DocumentTree;
  terms: TermRecord[];
}

export interface AskRequest {
  documentId: string;
  chatId?: string;
  question: string;
  selectedText?: string;
  anchor?: { blockId: string; startOffset?: number; endOffset?: number };
  images?: Array<{ blockId: string; assetId: string }>;
  context?: Record<string, unknown>;
  parentNodeId?: string;
  branchKind?: "deepens" | "branch" | "related";
}

export interface AskResult {
  node: ExploreNode;
  answer: string;
  citations: Array<{ blockId: string; quote: string; locator: SourceLocator }>;
  foundEvidence: boolean;
}
