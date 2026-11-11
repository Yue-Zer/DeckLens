import { SqliteDatabase } from "./sqlite.js";
import { createHash as nodeCreateHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const migrations = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    document_id TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    extension TEXT NOT NULL,
    format TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    source_relpath TEXT NOT NULL,
    title TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'und',
    status TEXT NOT NULL DEFAULT 'ready',
    active_version_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_updated_idx ON documents(updated_at DESC);
  CREATE TABLE IF NOT EXISTS document_versions (
    version_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    parse_status TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(document_id, version_no),
    UNIQUE(document_id, version_id)
  );
  CREATE INDEX IF NOT EXISTS versions_doc_idx ON document_versions(document_id, version_no DESC);
  CREATE TABLE IF NOT EXISTS sections (
    section_id TEXT NOT NULL,
    version_id TEXT NOT NULL REFERENCES document_versions(version_id) ON DELETE CASCADE,
    source_section_key TEXT NOT NULL,
    parent_section_id TEXT,
    title TEXT NOT NULL,
    depth INTEGER NOT NULL,
    source_order INTEGER NOT NULL,
    display_order INTEGER NOT NULL,
    origin TEXT NOT NULL DEFAULT 'parser',
    source_locator_json TEXT,
    PRIMARY KEY(version_id, section_id),
    FOREIGN KEY(version_id, parent_section_id) REFERENCES sections(version_id, section_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS sections_tree_idx ON sections(version_id, parent_section_id, display_order);
  CREATE TABLE IF NOT EXISTS section_edits (
    edit_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    source_keys_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'applied',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS section_edits_doc_idx ON section_edits(document_id, state);
  CREATE TABLE IF NOT EXISTS blocks (
    block_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    source_block_key TEXT NOT NULL,
    parent_block_id TEXT,
    order_index INTEGER NOT NULL,
    block_type TEXT NOT NULL,
    plain_text TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    source_locator_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    FOREIGN KEY(version_id, section_id) REFERENCES sections(version_id, section_id) ON DELETE CASCADE,
    FOREIGN KEY(version_id, parent_block_id) REFERENCES blocks(version_id, block_id) ON DELETE CASCADE,
    UNIQUE(version_id, block_id)
  );
  CREATE INDEX IF NOT EXISTS blocks_section_idx ON blocks(version_id, section_id, order_index);
  CREATE INDEX IF NOT EXISTS blocks_source_key_idx ON blocks(version_id, source_block_key);
  CREATE TABLE IF NOT EXISTS assets (
    asset_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    FOREIGN KEY(version_id, block_id) REFERENCES blocks(version_id, block_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS assets_block_idx ON assets(version_id, block_id);
  CREATE TABLE IF NOT EXISTS terms (
    term_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    canonical_text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'und',
    confidence REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'candidate',
    created_at TEXT NOT NULL,
    UNIQUE(document_id, normalized_text, language)
  );
  CREATE INDEX IF NOT EXISTS terms_doc_idx ON terms(document_id, canonical_text);
  CREATE TABLE IF NOT EXISTS term_definitions (
    definition_id TEXT PRIMARY KEY,
    term_id TEXT NOT NULL REFERENCES terms(term_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('source','ai')),
    definition_text TEXT NOT NULL,
    source_block_id TEXT REFERENCES blocks(block_id) ON DELETE SET NULL,
    source_locator_json TEXT,
    ai_disclaimer TEXT,
    provider_id TEXT,
    model TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS term_def_term_idx ON term_definitions(term_id, kind);
  CREATE TABLE IF NOT EXISTS term_mentions (
    mention_id TEXT PRIMARY KEY,
    term_id TEXT NOT NULL REFERENCES terms(term_id) ON DELETE CASCADE,
    version_id TEXT NOT NULL,
    block_id TEXT NOT NULL REFERENCES blocks(block_id) ON DELETE CASCADE,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    matched_text TEXT NOT NULL,
    display_mode TEXT NOT NULL DEFAULT 'anchor',
    FOREIGN KEY(version_id, block_id) REFERENCES blocks(version_id, block_id) ON DELETE CASCADE,
    UNIQUE(block_id, start_offset, end_offset)
  );
  CREATE INDEX IF NOT EXISTS term_mentions_block_idx ON term_mentions(version_id, block_id, start_offset);
  CREATE INDEX IF NOT EXISTS term_mentions_term_idx ON term_mentions(term_id);
  CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES document_versions(version_id) ON DELETE CASCADE,
    section_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text_start INTEGER NOT NULL,
    text_end INTEGER NOT NULL,
    text TEXT NOT NULL,
    token_estimate INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(version_id, section_id) REFERENCES sections(version_id, section_id) ON DELETE CASCADE,
    FOREIGN KEY(version_id, block_id) REFERENCES blocks(version_id, block_id) ON DELETE CASCADE,
    UNIQUE(version_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS chunks_section_idx ON chunks(version_id, section_id, ordinal);
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(chunk_id,text) VALUES(new.chunk_id,new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE chunk_id=old.chunk_id;
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE OF text ON chunks BEGIN
    DELETE FROM chunks_fts WHERE chunk_id=old.chunk_id;
    INSERT INTO chunks_fts(chunk_id,text) VALUES(new.chunk_id,new.text);
  END;
  CREATE TABLE IF NOT EXISTS chats (
    chat_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chats_doc_idx ON chats(document_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS context_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
    parent_snapshot_id TEXT REFERENCES context_snapshots(snapshot_id),
    ancestor_path_json TEXT NOT NULL,
    messages_json TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    retrieval_query TEXT NOT NULL,
    truncation_json TEXT NOT NULL DEFAULT '{}',
    token_budget INTEGER,
    token_estimate INTEGER,
    policy_version TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS explore_nodes (
    node_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
    node_kind TEXT NOT NULL CHECK(node_kind IN ('qa','explanation','note')),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'complete',
    context_snapshot_id TEXT REFERENCES context_snapshots(snapshot_id),
    provider_id TEXT,
    model TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE(chat_id, node_id)
  );
  CREATE INDEX IF NOT EXISTS explore_nodes_chat_idx ON explore_nodes(chat_id, created_at);
  CREATE TABLE IF NOT EXISTS explore_edges (
    edge_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    edge_kind TEXT NOT NULL CHECK(edge_kind IN ('deepens','branch','related')),
    branch_group_id TEXT,
    label TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    CHECK(from_node_id <> to_node_id),
    FOREIGN KEY(chat_id, from_node_id) REFERENCES explore_nodes(chat_id, node_id) ON DELETE CASCADE,
    FOREIGN KEY(chat_id, to_node_id) REFERENCES explore_nodes(chat_id, node_id) ON DELETE CASCADE,
    UNIQUE(from_node_id, to_node_id, edge_kind)
  );
  CREATE INDEX IF NOT EXISTS explore_edges_from_idx ON explore_edges(chat_id, from_node_id, edge_kind, order_index);
  CREATE INDEX IF NOT EXISTS explore_edges_to_idx ON explore_edges(chat_id, to_node_id, edge_kind);
  CREATE UNIQUE INDEX IF NOT EXISTS explore_structural_parent_idx ON explore_edges(to_node_id) WHERE edge_kind IN ('deepens','branch');
  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES explore_nodes(node_id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(node_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS messages_node_idx ON messages(node_id, ordinal);
  CREATE TABLE IF NOT EXISTS source_refs (
    source_ref_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES explore_nodes(node_id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(message_id) ON DELETE CASCADE,
    source_role TEXT NOT NULL CHECK(source_role IN ('anchor','evidence','context')),
    version_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    chunk_id TEXT REFERENCES chunks(chunk_id) ON DELETE SET NULL,
    start_offset INTEGER,
    end_offset INTEGER,
    quote TEXT NOT NULL,
    locator_json TEXT NOT NULL,
    retrieval_rank INTEGER,
    FOREIGN KEY(version_id, block_id) REFERENCES blocks(version_id, block_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS source_refs_node_idx ON source_refs(node_id, source_role);
  CREATE INDEX IF NOT EXISTS source_refs_block_idx ON source_refs(version_id, block_id);
  CREATE TABLE IF NOT EXISTS explore_state (
    chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
    view_id TEXT NOT NULL DEFAULT 'default',
    active_node_id TEXT REFERENCES explore_nodes(node_id) ON DELETE SET NULL,
    active_version_id TEXT,
    active_block_id TEXT,
    text_offset INTEGER,
    scroll_anchor TEXT,
    expanded_nodes_json TEXT NOT NULL DEFAULT '[]',
    branch_choices_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY(chat_id, view_id)
  );
  CREATE TABLE IF NOT EXISTS user_notes (
    note_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    version_id TEXT,
    block_id TEXT REFERENCES blocks(block_id) ON DELETE SET NULL,
    node_id TEXT REFERENCES explore_nodes(node_id) ON DELETE SET NULL,
    start_offset INTEGER,
    end_offset INTEGER,
    title TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS user_notes_doc_idx ON user_notes(document_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS note_attachments (
    attachment_id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES user_notes(note_id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    setting_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS import_jobs (
    job_id TEXT PRIMARY KEY,
    source_hash TEXT,
    original_name TEXT NOT NULL,
    format TEXT,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS import_jobs_state_idx ON import_jobs(status, created_at DESC);`,
  `ALTER TABLE blocks ADD COLUMN source_order INTEGER NOT NULL DEFAULT 0 CHECK(source_order >= 0);
  WITH ordered AS (
    SELECT b.block_id, ROW_NUMBER() OVER (
      PARTITION BY b.version_id
      ORDER BY
        COALESCE(json_extract(CASE WHEN json_valid(b.source_locator_json) THEN b.source_locator_json ELSE '{}' END, '$.slideNumber'),
                 json_extract(CASE WHEN json_valid(b.source_locator_json) THEN b.source_locator_json ELSE '{}' END, '$.lineStart'), s.source_order),
        COALESCE(json_extract(CASE WHEN json_valid(b.source_locator_json) THEN b.source_locator_json ELSE '{}' END, '$.paragraphIndex'), 2147483647),
        b.order_index, b.rowid
    ) - 1 AS source_position
    FROM blocks b JOIN sections s ON s.version_id=b.version_id AND s.section_id=b.section_id
  )
  UPDATE blocks SET source_order=(SELECT source_position FROM ordered WHERE ordered.block_id=blocks.block_id);
  CREATE INDEX blocks_source_order_idx ON blocks(version_id, source_order);
  ALTER TABLE explore_state ADD COLUMN floating_state_json TEXT NOT NULL DEFAULT '{}';`,
  `CREATE TABLE IF NOT EXISTS provider_profiles (
    profile_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider_kind TEXT NOT NULL CHECK(provider_kind IN ('openai-compatible','deepseek','ollama','anthropic','custom')),
    protocol TEXT NOT NULL CHECK(protocol IN ('openai-chat','ollama-chat','anthropic-messages')),
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1000 AND 600000),
    supports_streaming INTEGER NOT NULL DEFAULT 1 CHECK(supports_streaming IN (0,1)),
    supports_vision INTEGER NOT NULL DEFAULT 0 CHECK(supports_vision IN (0,1)),
    is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS provider_profiles_one_active_idx ON provider_profiles(is_active) WHERE is_active=1;
  CREATE INDEX IF NOT EXISTS provider_profiles_updated_idx ON provider_profiles(updated_at DESC);`,
  `CREATE TABLE IF NOT EXISTS annotations (
    annotation_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES document_versions(version_id) ON DELETE CASCADE,
    tool TEXT NOT NULL CHECK(tool IN ('pen','highlighter','lasso')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS annotations_doc_version_idx ON annotations(document_id,version_id,created_at);
  CREATE TABLE IF NOT EXISTS annotation_targets (
    target_id TEXT PRIMARY KEY,
    annotation_id TEXT NOT NULL REFERENCES annotations(annotation_id) ON DELETE CASCADE,
    version_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    target_order INTEGER NOT NULL,
    shape TEXT NOT NULL CHECK(shape IN ('path','polygon')),
    points_json TEXT NOT NULL,
    stroke_ratio REAL NOT NULL CHECK(stroke_ratio > 0 AND stroke_ratio <= 0.05),
    FOREIGN KEY(version_id,block_id) REFERENCES blocks(version_id,block_id) ON DELETE CASCADE,
    UNIQUE(annotation_id,target_order)
  );
  CREATE INDEX IF NOT EXISTS annotation_targets_block_idx ON annotation_targets(version_id,block_id,annotation_id);`
];

export function openDatabase(dataDir: string): SqliteDatabase {
  const dbDir = join(dataDir, "db");
  mkdirSync(dbDir, { recursive: true });
  const db = new SqliteDatabase(join(dbDir, "decklens.sqlite"));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    runMigrations(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

function runMigrations(db: SqliteDatabase): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = db.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all();
  for (let index = 0; index < applied.length; index++) {
    const row = applied[index];
    if (row.version !== index + 1 || index >= migrations.length) throw new Error("SCHEMA_VERSION_UNSUPPORTED: 数据库版本不受当前应用支持，请使用对应版本打开或恢复备份。");
    if (row.checksum !== createHash(migrations[index])) throw new Error(`MIGRATION_CHECKSUM_MISMATCH: 第 ${index + 1} 个数据库迁移校验失败，原有数据未被修改。`);
  }
  let version = applied.length;
  while (version < migrations.length) {
    const next = version + 1;
    const sql = migrations[version];
    const checksum = createHash(sql);
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?,?,?)").run(next, checksum, new Date().toISOString());
    })();
    version = next;
  }
}

function createHash(value: string): string { return nodeCreateHash("sha256").update(value).digest("hex"); }
