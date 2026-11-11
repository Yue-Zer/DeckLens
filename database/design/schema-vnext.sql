-- DeckLens schema-vnext: DESIGN DRAFT, not a runtime migration.
-- Run only against an EMPTY disposable database, preferably ':memory:'.
-- No runtime imports, migration registration, user_version changes or seed data.
-- Business IDs are opaque strings; timestamps are UTC ISO-8601 strings.
-- Text offsets are zero-based UTF-16 code units, end-exclusive (validated by core).
-- JSON CHECKs validate container shape; core validates each versioned JSON schema.

PRAGMA foreign_keys = ON;
BEGIN;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  applied_at TEXT NOT NULL,
  application_version TEXT NOT NULL
);

CREATE TABLE documents (
  document_id TEXT PRIMARY KEY NOT NULL,
  original_sha256 TEXT NOT NULL UNIQUE CHECK (length(original_sha256) = 64),
  original_name TEXT NOT NULL,
  detected_format TEXT NOT NULL CHECK (detected_format IN ('pptx','docx','pdf','markdown','txt')),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  original_relpath TEXT NOT NULL UNIQUE CHECK (
    length(original_relpath) > 0 AND substr(original_relpath,1,1) <> '/'
    AND instr(original_relpath, char(92)) = 0 AND instr(original_relpath, ':') = 0
    AND instr('/' || original_relpath || '/', '/../') = 0
    AND instr('/' || original_relpath || '/', '/./') = 0
  ),
  title TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  visibility TEXT NOT NULL DEFAULT 'library' CHECK (visibility IN ('library','attachment')),
  status TEXT NOT NULL DEFAULT 'importing' CHECK (status IN ('importing','ready','failed','archived')),
  active_version_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Deferred circular FK permits document + first version creation in one transaction.
  FOREIGN KEY (document_id, active_version_id)
    REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX documents_updated_idx ON documents(updated_at DESC, document_id);

CREATE TABLE document_versions (
  version_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  parser_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  model_schema_version INTEGER NOT NULL CHECK (model_schema_version >= 1),
  parse_status TEXT NOT NULL CHECK (parse_status IN ('pending','parsing','ready','failed','cancelled')),
  extraction_method TEXT NOT NULL DEFAULT 'native' CHECK (extraction_method IN ('native','ocr','mixed')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'array'),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (document_id, version_no),
  UNIQUE (document_id, version_id)
);
CREATE INDEX document_versions_document_idx ON document_versions(document_id, version_no DESC);

CREATE TABLE sections (
  section_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  parent_section_id TEXT,
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  source_order INTEGER NOT NULL CHECK (source_order >= 0),
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  origin TEXT NOT NULL DEFAULT 'parser' CHECK (origin IN ('parser','manual')),
  source_locator_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_locator_json) AND json_type(source_locator_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_section_id IS NULL OR parent_section_id <> section_id),
  FOREIGN KEY (document_id, version_id) REFERENCES document_versions(document_id, version_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, parent_section_id) REFERENCES sections(version_id, section_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (version_id, section_id),
  UNIQUE (version_id, source_key),
  UNIQUE (version_id, source_order)
);
CREATE INDEX sections_tree_idx ON sections(version_id, parent_section_id, display_order, section_id);

-- Document-scoped replay log survives replacement of the parser-generated version.
CREATE TABLE section_edits (
  edit_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  base_version_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('rename','move','split','merge','reorder')),
  source_keys_json TEXT NOT NULL CHECK (json_valid(source_keys_json) AND json_type(source_keys_json) = 'array'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  state TEXT NOT NULL DEFAULT 'applied' CHECK (state IN ('applied','pending_review','rejected','undone')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (document_id, base_version_id) REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (document_id, ordinal)
);
CREATE INDEX section_edits_replay_idx ON section_edits(document_id, state, ordinal);

CREATE TABLE blocks (
  block_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  parent_block_id TEXT,
  source_key TEXT NOT NULL,
  source_order INTEGER NOT NULL CHECK (source_order >= 0),
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  block_type TEXT NOT NULL CHECK (block_type IN (
    'heading','paragraph','list','table','image','formula','code','quote','note','divider','unsupported'
  )),
  plain_text TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  source_locator_json TEXT NOT NULL CHECK (json_valid(source_locator_json) AND json_type(source_locator_json) = 'object'),
  extraction_method TEXT NOT NULL DEFAULT 'native' CHECK (extraction_method IN ('native','text-layer','ocr')),
  recognition_warning TEXT,
  language TEXT NOT NULL DEFAULT 'und',
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  CHECK (parent_block_id IS NULL OR parent_block_id <> block_id),
  CHECK (extraction_method <> 'ocr' OR length(trim(coalesce(recognition_warning,''))) > 0),
  FOREIGN KEY (document_id, version_id) REFERENCES document_versions(document_id, version_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, section_id) REFERENCES sections(version_id, section_id),
  FOREIGN KEY (version_id, parent_block_id) REFERENCES blocks(version_id, block_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (version_id, block_id),
  UNIQUE (document_id, version_id, block_id),
  UNIQUE (version_id, source_key),
  UNIQUE (version_id, source_order)
);
CREATE INDEX blocks_section_display_idx ON blocks(version_id, section_id, display_order, block_id);
CREATE INDEX blocks_parent_idx ON blocks(version_id, parent_block_id);

-- Aliases preserve compatibility after an intentional parser source-key scheme change.
CREATE TABLE source_key_aliases (
  version_id TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  block_id TEXT NOT NULL,
  PRIMARY KEY (version_id, alias_key),
  FOREIGN KEY (version_id, block_id) REFERENCES blocks(version_id, block_id) ON DELETE CASCADE
);
CREATE INDEX source_key_aliases_block_idx ON source_key_aliases(version_id, block_id);

-- Media files are document-scoped and may be used by several blocks or parse versions.
CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('image','attachment','preview')),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  relative_path TEXT NOT NULL UNIQUE CHECK (
    length(relative_path) > 0 AND substr(relative_path,1,1) <> '/'
    AND instr(relative_path, char(92)) = 0 AND instr(relative_path, ':') = 0
    AND instr('/' || relative_path || '/', '/../') = 0
    AND instr('/' || relative_path || '/', '/./') = 0
  ),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  created_at TEXT NOT NULL,
  UNIQUE (document_id, asset_id),
  UNIQUE (document_id, sha256, asset_kind)
);
CREATE TABLE block_assets (
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_role TEXT NOT NULL DEFAULT 'embedded' CHECK (asset_role IN ('embedded','preview','attachment')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  original_part_path TEXT,
  placement_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(placement_json) AND json_type(placement_json) = 'object'),
  alt_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (version_id, block_id, asset_id, ordinal),
  FOREIGN KEY (document_id, version_id, block_id) REFERENCES blocks(document_id, version_id, block_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, asset_id) REFERENCES assets(document_id, asset_id),
  UNIQUE (version_id, block_id, ordinal)
);
CREATE INDEX block_assets_asset_idx ON block_assets(document_id, asset_id);

CREATE TABLE provider_profiles (
  provider_profile_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('openai','deepseek','ollama','anthropic','custom')),
  protocol TEXT NOT NULL CHECK (protocol IN ('openai-chat','openai-responses','ollama-chat','anthropic-messages')),
  base_url TEXT NOT NULL CHECK (
    (base_url LIKE 'https://%' OR base_url LIKE 'http://%')
    AND instr(base_url,'@') = 0 AND instr(base_url,'?') = 0 AND instr(base_url,'#') = 0
  ),
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('bearer','x-api-key','none')),
  -- Opaque lookup handle only. SecretStore and all raw credentials stay outside SQLite.
  secret_ref TEXT UNIQUE CHECK (secret_ref IS NULL OR (secret_ref LIKE 'secret:%' AND length(secret_ref) <= 200)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json) AND json_type(options_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (auth_mode <> 'none' OR secret_ref IS NULL)
);
CREATE INDEX provider_profiles_enabled_idx ON provider_profiles(enabled, name);

CREATE TABLE model_profiles (
  model_profile_id TEXT PRIMARY KEY NOT NULL,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(provider_profile_id) ON DELETE CASCADE,
  remote_model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  capabilities_json TEXT NOT NULL DEFAULT '{"textInput":"unknown","imageInput":"unknown","streaming":"unknown","tools":"unknown","structuredOutput":"unknown"}' CHECK (
    json_valid(capabilities_json) AND json_type(capabilities_json) = 'object'
    AND coalesce(json_extract(capabilities_json,'$.textInput'),'') IN ('unknown','supported','unsupported')
    AND coalesce(json_extract(capabilities_json,'$.imageInput'),'') IN ('unknown','supported','unsupported')
    AND coalesce(json_extract(capabilities_json,'$.streaming'),'') IN ('unknown','supported','unsupported')
    AND coalesce(json_extract(capabilities_json,'$.tools'),'') IN ('unknown','supported','unsupported')
    AND coalesce(json_extract(capabilities_json,'$.structuredOutput'),'') IN ('unknown','supported','unsupported')
  ),
  limits_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(limits_json) AND json_type(limits_json) = 'object'),
  default_parameters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(default_parameters_json) AND json_type(default_parameters_json) = 'object'),
  verification_source TEXT NOT NULL DEFAULT 'declared' CHECK (verification_source IN ('declared','discovered','probed','user')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_profile_id, remote_model_id),
  UNIQUE (provider_profile_id, model_profile_id)
);
CREATE INDEX model_profiles_provider_idx ON model_profiles(provider_profile_id, enabled);

CREATE TABLE terms (
  term_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  canonical_text TEXT NOT NULL CHECK (length(canonical_text) > 0),
  normalized_text TEXT NOT NULL CHECK (length(normalized_text) > 0),
  language TEXT NOT NULL DEFAULT 'und',
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','accepted','ignored')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (document_id, normalized_text, language),
  UNIQUE (document_id, term_id)
);
CREATE INDEX terms_document_idx ON terms(document_id, status, canonical_text);
CREATE TABLE term_aliases (
  term_id TEXT NOT NULL REFERENCES terms(term_id) ON DELETE CASCADE,
  normalized_alias TEXT NOT NULL,
  display_text TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  PRIMARY KEY (term_id, normalized_alias, language)
);
CREATE TABLE term_mentions (
  mention_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  term_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  matched_text TEXT NOT NULL,
  display_mode TEXT NOT NULL DEFAULT 'anchor' CHECK (display_mode IN ('anchor','hover','hidden')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  FOREIGN KEY (document_id, term_id) REFERENCES terms(document_id, term_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, version_id, block_id) REFERENCES blocks(document_id, version_id, block_id) ON DELETE CASCADE,
  UNIQUE (version_id, block_id, start_offset, end_offset, term_id)
);
CREATE INDEX term_mentions_block_idx ON term_mentions(version_id, block_id, start_offset);
CREATE INDEX term_mentions_term_idx ON term_mentions(term_id, version_id);

CREATE TABLE term_definitions (
  definition_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  term_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('source','ai')),
  definition_text TEXT NOT NULL,
  ai_disclaimer TEXT,
  provider_profile_id TEXT,
  model_profile_id TEXT,
  model_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(model_snapshot_json) AND json_type(model_snapshot_json) = 'object'),
  cache_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','failed')),
  created_at TEXT NOT NULL,
  CHECK (origin <> 'ai' OR length(trim(coalesce(ai_disclaimer,''))) > 0),
  CHECK ((provider_profile_id IS NULL) = (model_profile_id IS NULL)),
  FOREIGN KEY (document_id, term_id) REFERENCES terms(document_id, term_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, version_id) REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (provider_profile_id, model_profile_id) REFERENCES model_profiles(provider_profile_id, model_profile_id) ON DELETE SET NULL,
  UNIQUE (document_id, definition_id)
);
CREATE INDEX term_definitions_term_idx ON term_definitions(term_id, version_id, origin, status);
CREATE INDEX term_definitions_cache_idx ON term_definitions(cache_key) WHERE cache_key IS NOT NULL;

CREATE TABLE chunks (
  chunk_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  section_id TEXT,
  parent_chunk_id TEXT,
  chunk_level TEXT NOT NULL CHECK (chunk_level IN ('document','section','leaf')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  text TEXT NOT NULL,
  search_text TEXT NOT NULL,
  token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  index_version TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  CHECK (parent_chunk_id IS NULL OR parent_chunk_id <> chunk_id),
  CHECK (chunk_level = 'document' OR section_id IS NOT NULL),
  FOREIGN KEY (document_id, version_id) REFERENCES document_versions(document_id, version_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, section_id) REFERENCES sections(version_id, section_id),
  FOREIGN KEY (version_id, parent_chunk_id) REFERENCES chunks(version_id, chunk_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (version_id, chunk_id),
  UNIQUE (document_id, version_id, chunk_id),
  UNIQUE (version_id, ordinal)
);
CREATE INDEX chunks_section_idx ON chunks(version_id, section_id, chunk_level, ordinal);
CREATE INDEX chunks_parent_idx ON chunks(version_id, parent_chunk_id);
CREATE TABLE chunk_sources (
  chunk_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_start_offset INTEGER NOT NULL CHECK (source_start_offset >= 0),
  source_end_offset INTEGER NOT NULL CHECK (source_end_offset >= source_start_offset),
  chunk_start_offset INTEGER NOT NULL CHECK (chunk_start_offset >= 0),
  chunk_end_offset INTEGER NOT NULL CHECK (chunk_end_offset >= chunk_start_offset),
  PRIMARY KEY (chunk_id, ordinal),
  FOREIGN KEY (document_id, version_id, chunk_id) REFERENCES chunks(document_id, version_id, chunk_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, version_id, block_id) REFERENCES blocks(document_id, version_id, block_id)
);
CREATE INDEX chunk_sources_block_idx ON chunk_sources(version_id, block_id);

-- External-content FTS indexes normalized/segmented search_text, never authoritative evidence.
CREATE VIRTUAL TABLE chunks_fts USING fts5(search_text, content='chunks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;
CREATE TRIGGER chunks_fts_update AFTER UPDATE OF search_text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO chunks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TABLE chats (
  chat_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chat_id, document_id)
);
CREATE INDEX chats_document_idx ON chats(document_id, status, updated_at DESC);

-- Every source used by a chat is explicitly granted. The primary document also has a grant.
-- Revocation blocks NEW requests in core, but never deletes historical evidence.
CREATE TABLE chat_source_grants (
  grant_id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  owner_document_id TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  grant_kind TEXT NOT NULL CHECK (grant_kind IN ('primary','attachment')),
  authorized_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (grant_kind <> 'primary' OR owner_document_id = source_document_id),
  FOREIGN KEY (chat_id, owner_document_id) REFERENCES chats(chat_id, document_id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id) REFERENCES documents(document_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (chat_id, source_document_id, grant_id)
);
CREATE UNIQUE INDEX chat_source_grants_active_idx ON chat_source_grants(chat_id, source_document_id) WHERE revoked_at IS NULL;
CREATE INDEX chat_source_grants_source_idx ON chat_source_grants(source_document_id, revoked_at);

CREATE TABLE context_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  parent_snapshot_id TEXT,
  ancestor_path_json TEXT NOT NULL CHECK (json_valid(ancestor_path_json) AND json_type(ancestor_path_json) = 'array'),
  messages_json TEXT NOT NULL CHECK (json_valid(messages_json) AND json_type(messages_json) = 'array'),
  retrieval_query TEXT NOT NULL DEFAULT '',
  retrieval_config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(retrieval_config_json) AND json_type(retrieval_config_json) = 'object'),
  model_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(model_snapshot_json) AND json_type(model_snapshot_json) = 'object'),
  truncation_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(truncation_json) AND json_type(truncation_json) = 'object'),
  context_summary TEXT NOT NULL DEFAULT '',
  token_budget INTEGER CHECK (token_budget IS NULL OR token_budget >= 0),
  token_estimate INTEGER CHECK (token_estimate IS NULL OR token_estimate >= 0),
  policy_version TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  created_at TEXT NOT NULL,
  CHECK (parent_snapshot_id IS NULL OR parent_snapshot_id <> snapshot_id),
  FOREIGN KEY (chat_id, document_id) REFERENCES chats(chat_id, document_id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, parent_snapshot_id) REFERENCES context_snapshots(chat_id, snapshot_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (chat_id, snapshot_id),
  UNIQUE (document_id, snapshot_id),
  UNIQUE (chat_id, document_id, snapshot_id)
);
CREATE INDEX context_snapshots_chat_idx ON context_snapshots(chat_id, created_at);
CREATE INDEX context_snapshots_parent_idx ON context_snapshots(chat_id, parent_snapshot_id);

CREATE TABLE explore_nodes (
  node_id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  node_kind TEXT NOT NULL CHECK (node_kind IN ('root','source','qa','deepen','relate','branch')),
  title TEXT NOT NULL,
  content_origin TEXT NOT NULL CHECK (content_origin IN ('document','ai','user','system','mixed')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','streaming','complete','failed','cancelled')),
  ai_disclaimer TEXT,
  context_snapshot_id TEXT,
  provider_profile_id TEXT,
  model_profile_id TEXT,
  model_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(model_snapshot_json) AND json_type(model_snapshot_json) = 'object'),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (content_origin NOT IN ('ai','mixed') OR length(trim(coalesce(ai_disclaimer,''))) > 0),
  CHECK ((provider_profile_id IS NULL) = (model_profile_id IS NULL)),
  FOREIGN KEY (chat_id, document_id) REFERENCES chats(chat_id, document_id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, context_snapshot_id) REFERENCES context_snapshots(chat_id, snapshot_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (provider_profile_id, model_profile_id) REFERENCES model_profiles(provider_profile_id, model_profile_id) ON DELETE SET NULL,
  UNIQUE (chat_id, node_id),
  UNIQUE (document_id, node_id),
  UNIQUE (chat_id, document_id, node_id)
);
CREATE UNIQUE INDEX explore_nodes_one_root_idx ON explore_nodes(chat_id) WHERE node_kind = 'root';
CREATE INDEX explore_nodes_chat_idx ON explore_nodes(chat_id, deleted_at, created_at, node_id);
CREATE INDEX explore_nodes_snapshot_idx ON explore_nodes(chat_id, context_snapshot_id);
CREATE INDEX explore_nodes_model_idx ON explore_nodes(provider_profile_id, model_profile_id);

-- THE ONLY structural parent fact. There is deliberately no parent_id on explore_nodes.
CREATE TABLE explore_edges (
  edge_id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_role TEXT NOT NULL CHECK (edge_role IN ('tree','reference')),
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('source','qa','deepen','relate','branch','related','supports','contradicts')),
  label TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  CHECK (from_node_id <> to_node_id),
  CHECK (
    (edge_role = 'tree' AND relation_kind IN ('source','qa','deepen','relate','branch'))
    OR (edge_role = 'reference' AND relation_kind IN ('related','supports','contradicts'))
  ),
  FOREIGN KEY (chat_id, from_node_id) REFERENCES explore_nodes(chat_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, to_node_id) REFERENCES explore_nodes(chat_id, node_id) ON DELETE CASCADE,
  UNIQUE (chat_id, from_node_id, to_node_id, edge_role, relation_kind)
);
CREATE UNIQUE INDEX explore_edges_single_tree_parent_idx ON explore_edges(chat_id, to_node_id) WHERE edge_role = 'tree';
CREATE INDEX explore_edges_children_idx ON explore_edges(chat_id, from_node_id, edge_role, display_order, edge_id);
CREATE INDEX explore_edges_incoming_idx ON explore_edges(chat_id, to_node_id, edge_role);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','streaming','complete','failed','cancelled')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (chat_id, document_id, node_id) REFERENCES explore_nodes(chat_id, document_id, node_id) ON DELETE CASCADE,
  UNIQUE (node_id, ordinal),
  UNIQUE (document_id, message_id),
  UNIQUE (chat_id, document_id, message_id),
  UNIQUE (node_id, message_id)
);
CREATE INDEX messages_chat_idx ON messages(chat_id, created_at, message_id);

-- Annotation identity is document-scoped, never replaced by a parse-version swap.
CREATE TABLE annotations (
  annotation_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  annotation_kind TEXT NOT NULL CHECK (annotation_kind IN ('note','highlight','underline','strike','shape','freehand')),
  tool TEXT NOT NULL DEFAULT 'pointer' CHECK (tool IN ('pointer','pen','highlighter','eraser','lasso')),
  title TEXT NOT NULL DEFAULT '',
  body_markdown TEXT NOT NULL DEFAULT '',
  style_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(style_json) AND json_type(style_json) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (document_id, annotation_id)
);
CREATE INDEX annotations_document_idx ON annotations(document_id, deleted_at, updated_at DESC);

CREATE TABLE annotation_targets (
  target_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  original_version_id TEXT NOT NULL,
  original_block_id TEXT,
  source_key TEXT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('text','block','region','document')),
  start_offset INTEGER,
  end_offset INTEGER,
  exact_quote TEXT NOT NULL DEFAULT '',
  exact_quote_sha256 TEXT CHECK (exact_quote_sha256 IS NULL OR length(exact_quote_sha256) = 64),
  prefix_text TEXT NOT NULL DEFAULT '',
  suffix_text TEXT NOT NULL DEFAULT '',
  reference_content_sha256 TEXT CHECK (reference_content_sha256 IS NULL OR length(reference_content_sha256) = 64),
  original_layout_fingerprint TEXT,
  original_locator_json TEXT NOT NULL CHECK (json_valid(original_locator_json) AND json_type(original_locator_json) = 'object'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TEXT NOT NULL,
  CHECK (
    (start_offset IS NULL AND end_offset IS NULL)
    OR (start_offset IS NOT NULL AND end_offset IS NOT NULL AND start_offset >= 0 AND end_offset > start_offset)
  ),
  CHECK (target_kind <> 'text' OR (original_block_id IS NOT NULL AND start_offset IS NOT NULL AND exact_quote_sha256 IS NOT NULL AND length(exact_quote) > 0)),
  CHECK (target_kind <> 'block' OR original_block_id IS NOT NULL),
  FOREIGN KEY (document_id, annotation_id) REFERENCES annotations(document_id, annotation_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, original_version_id) REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (document_id, original_version_id, original_block_id) REFERENCES blocks(document_id, version_id, block_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (annotation_id, ordinal),
  UNIQUE (document_id, target_id)
);
CREATE INDEX annotation_targets_original_idx ON annotation_targets(original_version_id, original_block_id);

CREATE TABLE annotation_geometries (
  geometry_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  geometry_kind TEXT NOT NULL CHECK (geometry_kind IN ('rect','ellipse','polyline','polygon','point')),
  coordinate_space TEXT NOT NULL CHECK (coordinate_space IN ('normalized-page','normalized-block','normalized-image')),
  asset_id TEXT,
  snapshot_asset_id TEXT,
  -- Unnormalized reference canvas dimensions, not the selected rectangle's width/height.
  reference_width REAL NOT NULL CHECK (reference_width > 0),
  reference_height REAL NOT NULL CHECK (reference_height > 0),
  reference_rotation_degrees REAL NOT NULL DEFAULT 0,
  page_no INTEGER CHECK (page_no IS NULL OR page_no >= 1),
  x REAL NOT NULL CHECK (x >= 0 AND x <= 1),
  y REAL NOT NULL CHECK (y >= 0 AND y <= 1),
  width REAL NOT NULL DEFAULT 0 CHECK (width >= 0 AND width <= 1),
  height REAL NOT NULL DEFAULT 0 CHECK (height >= 0 AND height <= 1),
  rotation_degrees REAL NOT NULL DEFAULT 0,
  reference_content_sha256 TEXT NOT NULL CHECK (length(reference_content_sha256) = 64),
  layout_fingerprint TEXT NOT NULL CHECK (length(layout_fingerprint) > 0),
  points_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(points_json) AND json_type(points_json) = 'array'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  CHECK (x + width <= 1.000001 AND y + height <= 1.000001),
  CHECK (coordinate_space <> 'normalized-page' OR page_no IS NOT NULL),
  CHECK (coordinate_space <> 'normalized-image' OR asset_id IS NOT NULL),
  FOREIGN KEY (document_id, target_id) REFERENCES annotation_targets(document_id, target_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, asset_id) REFERENCES assets(document_id, asset_id),
  FOREIGN KEY (document_id, snapshot_asset_id) REFERENCES assets(document_id, asset_id),
  UNIQUE (target_id, ordinal)
);

-- New version => new binding; original target and historical bindings remain unchanged.
CREATE TABLE annotation_bindings (
  binding_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL DEFAULT 0 CHECK (segment_index >= 0),
  block_id TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  binding_status TEXT NOT NULL CHECK (binding_status IN ('exact','fuzzy','manual','orphaned','ambiguous','layout_stale')),
  matched_content_sha256 TEXT CHECK (matched_content_sha256 IS NULL OR length(matched_content_sha256) = 64),
  layout_fingerprint TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  locator_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(locator_json) AND json_type(locator_json) = 'object'),
  mapping_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mapping_json) AND json_type(mapping_json) = 'object'),
  created_at TEXT NOT NULL,
  CHECK (
    (start_offset IS NULL AND end_offset IS NULL)
    OR (start_offset IS NOT NULL AND end_offset IS NOT NULL AND start_offset >= 0 AND end_offset > start_offset)
  ),
  CHECK (binding_status IN ('orphaned','ambiguous') OR block_id IS NOT NULL),
  CHECK (binding_status NOT IN ('orphaned','ambiguous') OR (block_id IS NULL AND start_offset IS NULL AND end_offset IS NULL)),
  FOREIGN KEY (document_id, target_id) REFERENCES annotation_targets(document_id, target_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, version_id) REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (document_id, version_id, block_id) REFERENCES blocks(document_id, version_id, block_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (target_id, version_id, segment_index),
  UNIQUE (document_id, version_id, block_id, target_id, binding_id)
);
CREATE INDEX annotation_bindings_version_idx ON annotation_bindings(version_id, binding_status, block_id);

CREATE TABLE annotation_attachments (
  attachment_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE CHECK (
    length(relative_path) > 0 AND substr(relative_path,1,1) <> '/'
    AND instr(relative_path, char(92)) = 0 AND instr(relative_path, ':') = 0
    AND instr('/' || relative_path || '/', '/../') = 0
    AND instr('/' || relative_path || '/', '/./') = 0
  ),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id, annotation_id) REFERENCES annotations(document_id, annotation_id) ON DELETE CASCADE
);
CREATE INDEX annotation_attachments_annotation_idx ON annotation_attachments(annotation_id);

-- One immutable evidence item; owner join tables allow many sources per entity.
CREATE TABLE source_refs (
  source_ref_id TEXT PRIMARY KEY NOT NULL,
  source_document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  chunk_id TEXT,
  annotation_target_id TEXT,
  annotation_binding_id TEXT,
  content_origin TEXT NOT NULL DEFAULT 'document' CHECK (content_origin IN ('document','annotation')),
  extraction_method TEXT NOT NULL DEFAULT 'native' CHECK (extraction_method IN ('native','text-layer','ocr')),
  recognition_warning TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  quote TEXT NOT NULL,
  quote_sha256 TEXT NOT NULL CHECK (length(quote_sha256) = 64),
  annotation_excerpt TEXT,
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json) AND json_type(locator_json) = 'object'),
  created_at TEXT NOT NULL,
  CHECK (
    (start_offset IS NULL AND end_offset IS NULL)
    OR (start_offset IS NOT NULL AND end_offset IS NOT NULL AND start_offset >= 0 AND end_offset > start_offset)
  ),
  CHECK ((annotation_target_id IS NULL) = (annotation_binding_id IS NULL)),
  CHECK (content_origin <> 'annotation' OR annotation_target_id IS NOT NULL),
  CHECK (extraction_method <> 'ocr' OR length(trim(coalesce(recognition_warning,''))) > 0),
  FOREIGN KEY (source_document_id, version_id, block_id) REFERENCES blocks(document_id, version_id, block_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_document_id, version_id, chunk_id) REFERENCES chunks(document_id, version_id, chunk_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_document_id, version_id, block_id, annotation_target_id, annotation_binding_id)
    REFERENCES annotation_bindings(document_id, version_id, block_id, target_id, binding_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (source_document_id, source_ref_id)
);
CREATE INDEX source_refs_block_idx ON source_refs(version_id, block_id, start_offset);
CREATE INDEX source_refs_chunk_idx ON source_refs(version_id, chunk_id);
CREATE INDEX source_refs_annotation_idx ON source_refs(annotation_target_id, annotation_binding_id);

CREATE TABLE node_source_refs (
  node_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  owner_document_id TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('anchor','evidence','context','related')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  retrieval_score REAL,
  PRIMARY KEY (node_id, source_ref_id, source_role),
  FOREIGN KEY (chat_id, owner_document_id, node_id) REFERENCES explore_nodes(chat_id, document_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id, source_ref_id) REFERENCES source_refs(source_document_id, source_ref_id),
  FOREIGN KEY (chat_id, source_document_id, grant_id) REFERENCES chat_source_grants(chat_id, source_document_id, grant_id),
  UNIQUE (node_id, source_role, ordinal)
);
CREATE INDEX node_source_refs_source_idx ON node_source_refs(source_ref_id);
CREATE TABLE message_source_refs (
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  owner_document_id TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  answer_start_offset INTEGER CHECK (answer_start_offset IS NULL OR answer_start_offset >= 0),
  answer_end_offset INTEGER,
  PRIMARY KEY (message_id, source_ref_id),
  CHECK (
    (answer_start_offset IS NULL AND answer_end_offset IS NULL)
    OR (answer_start_offset IS NOT NULL AND answer_end_offset IS NOT NULL AND answer_end_offset > answer_start_offset)
  ),
  FOREIGN KEY (chat_id, owner_document_id, message_id) REFERENCES messages(chat_id, document_id, message_id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id, source_ref_id) REFERENCES source_refs(source_document_id, source_ref_id),
  FOREIGN KEY (chat_id, source_document_id, grant_id) REFERENCES chat_source_grants(chat_id, source_document_id, grant_id),
  UNIQUE (message_id, ordinal)
);
CREATE INDEX message_source_refs_source_idx ON message_source_refs(source_ref_id);
CREATE TABLE snapshot_source_refs (
  snapshot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  owner_document_id TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('anchor','evidence','context')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (snapshot_id, source_ref_id, source_role),
  FOREIGN KEY (chat_id, owner_document_id, snapshot_id) REFERENCES context_snapshots(chat_id, document_id, snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id, source_ref_id) REFERENCES source_refs(source_document_id, source_ref_id),
  FOREIGN KEY (chat_id, source_document_id, grant_id) REFERENCES chat_source_grants(chat_id, source_document_id, grant_id),
  UNIQUE (snapshot_id, source_role, ordinal)
);
CREATE INDEX snapshot_source_refs_source_idx ON snapshot_source_refs(source_ref_id);
CREATE TABLE definition_source_refs (
  definition_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (definition_id, source_ref_id),
  FOREIGN KEY (document_id, definition_id) REFERENCES term_definitions(document_id, definition_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, source_ref_id) REFERENCES source_refs(source_document_id, source_ref_id),
  UNIQUE (definition_id, ordinal)
);
CREATE INDEX definition_source_refs_source_idx ON definition_source_refs(source_ref_id);

-- Draft input persists separately from completed exploration nodes; attachment imports do not
-- switch the primary reader document. revision enables optimistic concurrency checks in core.
CREATE TABLE exploration_drafts (
  draft_id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  owner_document_id TEXT NOT NULL,
  parent_node_id TEXT,
  action TEXT NOT NULL DEFAULT 'qa' CHECK (action IN ('qa','deepen','relate','branch')),
  entry_point TEXT NOT NULL CHECK (entry_point IN ('global','selection','node','term')),
  question_text TEXT NOT NULL DEFAULT '',
  context_snapshot_id TEXT,
  context_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(context_refs_json) AND json_type(context_refs_json) = 'array'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','submitted','discarded')),
  submitted_node_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'submitted' OR submitted_node_id IS NOT NULL),
  FOREIGN KEY (chat_id, owner_document_id) REFERENCES chats(chat_id, document_id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, parent_node_id) REFERENCES explore_nodes(chat_id, node_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (chat_id, context_snapshot_id) REFERENCES context_snapshots(chat_id, snapshot_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (chat_id, submitted_node_id) REFERENCES explore_nodes(chat_id, node_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (chat_id, draft_id),
  UNIQUE (chat_id, owner_document_id, draft_id)
);
CREATE INDEX exploration_drafts_chat_idx ON exploration_drafts(chat_id, status, updated_at DESC);

CREATE TABLE draft_source_refs (
  draft_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  owner_document_id TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('selection','anchor','context','attachment')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (draft_id, source_ref_id, source_role),
  FOREIGN KEY (chat_id, owner_document_id, draft_id) REFERENCES exploration_drafts(chat_id, owner_document_id, draft_id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id, source_ref_id) REFERENCES source_refs(source_document_id, source_ref_id),
  FOREIGN KEY (chat_id, source_document_id, grant_id) REFERENCES chat_source_grants(chat_id, source_document_id, grant_id),
  UNIQUE (draft_id, source_role, ordinal)
);
CREATE INDEX draft_source_refs_source_idx ON draft_source_refs(source_ref_id);

CREATE TABLE question_attachments (
  attachment_id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  owner_document_id TEXT NOT NULL,
  source_document_id TEXT,
  source_version_id TEXT,
  grant_id TEXT,
  import_job_id TEXT REFERENCES import_jobs(job_id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','parsing','ready','failed','removed')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_version_id IS NULL OR source_document_id IS NOT NULL),
  CHECK (grant_id IS NULL OR source_document_id IS NOT NULL),
  CHECK (status <> 'ready' OR (source_document_id IS NOT NULL AND source_version_id IS NOT NULL AND grant_id IS NOT NULL)),
  FOREIGN KEY (chat_id, owner_document_id, draft_id) REFERENCES exploration_drafts(chat_id, owner_document_id, draft_id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id) REFERENCES documents(document_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_document_id, source_version_id) REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (chat_id, source_document_id, grant_id) REFERENCES chat_source_grants(chat_id, source_document_id, grant_id),
  UNIQUE (draft_id, ordinal)
);
CREATE INDEX question_attachments_source_idx ON question_attachments(source_document_id, source_version_id);
CREATE INDEX question_attachments_job_idx ON question_attachments(import_job_id);

CREATE TABLE explore_view_state (
  chat_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  view_id TEXT NOT NULL DEFAULT 'default',
  active_node_id TEXT,
  reader_version_id TEXT,
  reader_block_id TEXT,
  reader_text_offset INTEGER CHECK (reader_text_offset IS NULL OR reader_text_offset >= 0),
  expanded_nodes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(expanded_nodes_json) AND json_type(expanded_nodes_json) = 'array'),
  branch_choices_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(branch_choices_json) AND json_type(branch_choices_json) = 'object'),
  breadcrumb_path_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(breadcrumb_path_json) AND json_type(breadcrumb_path_json) = 'array'),
  scroll_anchor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scroll_anchor_json) AND json_type(scroll_anchor_json) = 'object'),
  panel_state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(panel_state_json) AND json_type(panel_state_json) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, view_id),
  CHECK (reader_block_id IS NULL OR reader_version_id IS NOT NULL),
  CHECK (reader_text_offset IS NULL OR reader_block_id IS NOT NULL),
  FOREIGN KEY (chat_id, document_id) REFERENCES chats(chat_id, document_id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, active_node_id) REFERENCES explore_nodes(chat_id, node_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (document_id, reader_version_id) REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (document_id, reader_version_id, reader_block_id) REFERENCES blocks(document_id, version_id, block_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE settings (
  setting_key TEXT PRIMARY KEY NOT NULL CHECK (setting_key IN ('ui.language','reader.preferences','ai.defaults.modelId')),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  value_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (value_schema_version >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE import_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT,
  version_id TEXT,
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR length(source_sha256) = 64),
  original_name TEXT NOT NULL,
  detected_format TEXT CHECK (detected_format IS NULL OR detected_format IN ('pptx','docx','pdf','markdown','txt','unsupported')),
  status TEXT NOT NULL CHECK (status IN ('queued','detecting','parsing','indexing','completed','duplicate','failed','cancelled')),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  error_code TEXT,
  error_message TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'array'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (version_id IS NULL OR document_id IS NOT NULL),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, version_id) REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX import_jobs_state_idx ON import_jobs(status, created_at DESC);
CREATE INDEX import_jobs_document_idx ON import_jobs(document_id, version_id);
CREATE INDEX import_jobs_hash_idx ON import_jobs(source_sha256) WHERE source_sha256 IS NOT NULL;

COMMIT;
