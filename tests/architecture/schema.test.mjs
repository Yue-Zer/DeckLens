// Design initialization only: every database below is disposable ':memory:'.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const schema = await readFile(new URL('../../database/design/schema-vnext.sql', import.meta.url), 'utf8');
const now = '2026-11-11T00:00:00.000Z';
const digest = (letter) => letter.repeat(64);

function open(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(schema);
  return db;
}

function seedDocument(db, id = 'doc-a', hash = digest('a')) {
  db.prepare(`INSERT INTO documents
    (document_id,original_sha256,original_name,detected_format,mime_type,size_bytes,
      original_relpath,title,created_at,updated_at)
    VALUES (?,?,?,'markdown','text/markdown',32,?,?,?,?)`)
    .run(id, hash, `${id}.md`, `originals/${hash.slice(0, 2)}/${hash}.md`, id, now, now);
  const version = `${id}-v1`;
  db.prepare(`INSERT INTO document_versions
    (version_id,document_id,version_no,source_sha256,parser_id,parser_version,
      model_schema_version,parse_status,created_at)
    VALUES (?,?,1,?,'markdown','design-test',1,'ready',?)`).run(version, id, hash, now);
  const section = `${id}-root`;
  db.prepare(`INSERT INTO sections
    (section_id,document_id,version_id,source_key,title,depth,source_order,display_order,created_at,updated_at)
    VALUES (?,?,?,'root','Reading source',0,0,0,?,?)`).run(section, id, version, now, now);
  insertBlock(db, { id: `${id}-b1`, document: id, version, section, key: 'line:1', order: 0 });
  return { document: id, version, section, block: `${id}-b1` };
}

function insertBlock(db, { id, document, version, section, key, order, text = 'Convolution uses a local kernel.' }) {
  return db.prepare(`INSERT INTO blocks
    (block_id,document_id,version_id,section_id,source_key,source_order,display_order,
      block_type,plain_text,payload_json,source_locator_json,content_sha256)
    VALUES (?,?,?,?,?,?,?,'paragraph',?,'{}','{}',?)`)
    .run(id, document, version, section, key, order, order, text, digest('b'));
}

function seedChat(db, doc, id) {
  db.prepare(`INSERT INTO chats(chat_id,document_id,title,created_at,updated_at) VALUES (?,?,?,?,?)`)
    .run(id, doc, id, now, now);
  return id;
}

function insertNode(db, doc, chat, id, kind, origin = 'document', disclaimer = null) {
  db.prepare(`INSERT INTO explore_nodes
    (node_id,chat_id,document_id,node_kind,title,content_origin,status,ai_disclaimer,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'complete',?,?,?)`).run(id, chat, doc, kind, id, origin, disclaimer, now, now);
}

function insertTreeEdge(db, chat, id, from, to, relation) {
  db.prepare(`INSERT INTO explore_edges
    (edge_id,chat_id,from_node_id,to_node_id,edge_role,relation_kind,created_at)
    VALUES (?,?,?,?,'tree',?,?)`).run(id, chat, from, to, relation, now);
}

test('DDL builds from empty memory with foreign keys and no applied runtime migration', (t) => {
  const db = open(t);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 0);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  const required = [
    'documents', 'document_versions', 'sections', 'blocks', 'assets', 'block_assets',
    'terms', 'term_definitions', 'chunks', 'chats', 'messages', 'explore_nodes', 'explore_edges',
    'context_snapshots', 'source_refs', 'annotations', 'annotation_targets', 'annotation_bindings',
    'provider_profiles', 'model_profiles', 'settings', 'exploration_drafts', 'question_attachments',
  ];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
  for (const name of required) assert.ok(tables.has(name), `Missing design table: ${name}`);
});

test('duplicate origin and order are rejected while repeated text at a different origin survives', (t) => {
  const db = open(t);
  const source = seedDocument(db);
  assert.throws(() => insertBlock(db, { ...source, id: 'same-origin', key: 'line:1', order: 1 }), /UNIQUE/);
  assert.throws(() => insertBlock(db, { ...source, id: 'same-order', key: 'line:2', order: 0 }), /UNIQUE/);
  insertBlock(db, { ...source, id: 'separate-origin', key: 'line:2', order: 1 });
  const rows = db.prepare('SELECT source_key,plain_text FROM blocks ORDER BY source_order').all();
  assert.deepEqual(rows.map(row => row.source_key), ['line:1', 'line:2']);
  assert.equal(rows[0].plain_text, rows[1].plain_text);
});

test('document hash deduplication and same-version ownership are enforced', (t) => {
  const db = open(t);
  const a = seedDocument(db);
  const b = seedDocument(db, 'doc-b', digest('c'));
  assert.throws(() => seedDocument(db, 'duplicate', digest('a')), /UNIQUE/);
  assert.throws(() => insertBlock(db, { ...a, id: 'cross-version', section: b.section, key: 'line:3', order: 3 }), /FOREIGN KEY/);
  assert.throws(() => db.prepare('UPDATE documents SET active_version_id=? WHERE document_id=?').run(b.version, a.document), /FOREIGN KEY/);
});

test('tree has one parent per child and rejects self-links and cross-chat endpoints', (t) => {
  const db = open(t);
  const { document } = seedDocument(db);
  const chat = seedChat(db, document, 'chat-a');
  const other = seedChat(db, document, 'chat-b');
  insertNode(db, document, chat, 'root-a', 'root');
  insertNode(db, document, chat, 'source-a', 'source');
  insertNode(db, document, chat, 'child-a', 'deepen');
  insertNode(db, document, other, 'root-b', 'root');
  insertTreeEdge(db, chat, 'edge-1', 'root-a', 'source-a', 'source');
  insertTreeEdge(db, chat, 'edge-2', 'source-a', 'child-a', 'deepen');
  assert.throws(() => insertTreeEdge(db, chat, 'double-parent', 'root-a', 'child-a', 'deepen'), /UNIQUE/);
  assert.throws(() => insertTreeEdge(db, chat, 'self', 'root-a', 'root-a', 'source'), /CHECK/);
  assert.throws(() => insertTreeEdge(db, chat, 'cross-chat', 'root-a', 'root-b', 'source'), /FOREIGN KEY/);
  assert.throws(() => insertNode(db, document, chat, 'second-root', 'root'), /UNIQUE/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // General cycles and exactly-one-parent creation remain core transaction invariants.
});

test('AI and OCR content cannot omit their visible origin warning', (t) => {
  const db = open(t);
  const { document, block } = seedDocument(db);
  const chat = seedChat(db, document, 'chat-a');
  assert.throws(() => insertNode(db, document, chat, 'ai-missing-label', 'deepen', 'ai'), /CHECK/);
  insertNode(db, document, chat, 'ai-labelled', 'deepen', 'ai', 'AI 生成，仅供参考');
  assert.throws(() => db.prepare("UPDATE blocks SET extraction_method='ocr' WHERE block_id=?").run(block), /CHECK/);
  db.prepare("UPDATE blocks SET extraction_method='ocr',recognition_warning=? WHERE block_id=?")
    .run('识别内容可能存在误差', block);
});

test('unsafe stored paths are rejected and secrets have no dedicated SQL column', (t) => {
  const db = open(t);
  const { document } = seedDocument(db);
  for (const path of ['../secret', '/etc/passwd', 'C:/private/file', 'media/../file', 'media\\file']) {
    assert.throws(() => db.prepare('UPDATE documents SET original_relpath=? WHERE document_id=?').run(path, document), /CHECK/);
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(name);
    assert.ok(!columns.some(c => /^(api_?key|authorization|access_token|password)$/i.test(c.name)), `Secret column in ${name}`);
  }
  // JSON whitelisting, secret file permissions and DTO serialization need later runtime checks.
});

test('FTS insert/update/delete stay synchronized with the disposable chunk index', (t) => {
  const db = open(t);
  const { document, version, section } = seedDocument(db);
  db.prepare(`INSERT INTO chunks
    (chunk_id,document_id,version_id,section_id,chunk_level,ordinal,text,search_text,token_estimate,content_sha256,index_version)
    VALUES ('chunk-a',?,?,?,'leaf',0,'Original evidence text','convolution kernel',4,?,'design-v1')`)
    .run(document, version, section, digest('d'));
  const hits = query => db.prepare('SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?').all(query).length;
  assert.equal(hits('convolution'), 1);
  db.prepare("UPDATE chunks SET search_text='fourier transform' WHERE chunk_id='chunk-a'").run();
  assert.equal(hits('convolution'), 0);
  assert.equal(hits('fourier'), 1);
  db.prepare("DELETE FROM chunks WHERE chunk_id='chunk-a'").run();
  assert.equal(hits('fourier'), 0);
  db.exec("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)");
});

test('public provider presets contain no credential and do not enable unconfigured models', async () => {
  const config = JSON.parse(await readFile(new URL('../../config/providers.example.json', import.meta.url), 'utf8'));
  assert.equal(config.designOnly, true);
  assert.equal(config.activeModelId, null);
  assert.deepEqual(config.presets.map(p => p.id), ['openai-compatible', 'deepseek-official', 'ollama-local']);
  function checkPublic(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!/^(apiKey|api_key|secretRef|authorization|password|accessToken)$/i.test(key), `Forbidden public key: ${key}`);
      checkPublic(child);
    }
  }
  checkPublic(config);
  for (const profile of config.presets) {
    const endpoint = new URL(profile.baseUrl);
    assert.ok(['http:', 'https:'].includes(endpoint.protocol));
    assert.equal(endpoint.username + endpoint.password + endpoint.search + endpoint.hash, '');
    assert.equal(profile.enabled, false);
    assert.equal(profile.modelDefaults.modelName, '');
    assert.ok(profile.options.timeoutMs > 0);
    assert.deepEqual(Object.keys(profile.modelDefaults.capabilities).sort(),
      ['textInput', 'imageInput', 'streaming', 'tools', 'structuredOutput'].sort());
    for (const capability of Object.values(profile.modelDefaults.capabilities)) assert.equal(capability, 'unknown');
  }
});

test('attachment evidence needs a source grant from the same chat and keeps historical authorization', (t) => {
  const db = open(t);
  const owner = seedDocument(db);
  const attachment = seedDocument(db, 'doc-attachment', digest('c'));
  const chat = seedChat(db, owner.document, 'chat-a');
  const otherChat = seedChat(db, owner.document, 'chat-other');
  insertNode(db, owner.document, chat, 'question-a', 'qa');
  db.prepare(`INSERT INTO source_refs
    (source_ref_id,source_document_id,version_id,block_id,quote,quote_sha256,locator_json,created_at)
    VALUES ('attachment-source',?,?,?,'Convolution uses a local kernel.',?,'{}',?)`)
    .run(attachment.document, attachment.version, attachment.block, digest('b'), now);
  const grant = db.prepare(`INSERT INTO chat_source_grants
    (grant_id,chat_id,owner_document_id,source_document_id,grant_kind,authorized_at)
    VALUES (?,?,?,?,'attachment',?)`);
  grant.run('other-grant', otherChat, owner.document, attachment.document, now);
  const link = db.prepare(`INSERT INTO node_source_refs
    (node_id,chat_id,owner_document_id,source_document_id,grant_id,source_ref_id,source_role,ordinal)
    VALUES ('question-a',?,?,?,?,'attachment-source','evidence',0)`);
  assert.throws(() => link.run(chat, owner.document, attachment.document, 'missing-grant'), /FOREIGN KEY/);
  assert.throws(() => link.run(chat, owner.document, attachment.document, 'other-grant'), /FOREIGN KEY/);
  grant.run('attachment-grant', chat, owner.document, attachment.document, now);
  link.run(chat, owner.document, attachment.document, 'attachment-grant');
  db.prepare(`INSERT INTO exploration_drafts
    (draft_id,chat_id,owner_document_id,entry_point,created_at,updated_at)
    VALUES ('draft-a',?,?,'global',?,?)`).run(chat, owner.document, now, now);
  const addAttachment = db.prepare(`INSERT INTO question_attachments
    (attachment_id,draft_id,chat_id,owner_document_id,source_document_id,source_version_id,
      grant_id,original_name,status,ordinal,created_at,updated_at)
    VALUES (?,'draft-a',?,?,?,?,?,'reading.md','ready',0,?,?)`);
  assert.throws(() => addAttachment.run('missing-access', chat, owner.document,
    attachment.document, attachment.version, null, now, now), /CHECK/);
  assert.throws(() => addAttachment.run('wrong-chat-access', chat, owner.document,
    attachment.document, attachment.version, 'other-grant', now, now), /FOREIGN KEY/);
  addAttachment.run('valid-attachment', chat, owner.document,
    attachment.document, attachment.version, 'attachment-grant', now, now);
  db.prepare('UPDATE chat_source_grants SET revoked_at=? WHERE grant_id=?').run(now, 'attachment-grant');
  assert.equal(db.prepare('SELECT count(*) AS count FROM node_source_refs').get().count, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // Core must reject new use of revoked grants; SQL retains valid historical evidence.
});

test('annotation rebindings preserve the original target and ambiguous matches cannot become evidence', (t) => {
  const db = open(t);
  const source = seedDocument(db);
  db.prepare(`INSERT INTO annotations
    (annotation_id,document_id,annotation_kind,created_at,updated_at)
    VALUES ('annotation-a',?,'highlight',?,?)`).run(source.document, now, now);
  db.prepare(`INSERT INTO annotation_targets
    (target_id,document_id,annotation_id,original_version_id,original_block_id,target_kind,
      start_offset,end_offset,exact_quote,exact_quote_sha256,original_locator_json,ordinal,created_at)
    VALUES ('target-a',?,'annotation-a',?,?,'text',0,11,'Convolution',?,'{}',0,?)`)
    .run(source.document, source.version, source.block, digest('b'), now);
  db.prepare(`INSERT INTO annotation_bindings
    (binding_id,document_id,target_id,version_id,block_id,start_offset,end_offset,binding_status,created_at)
    VALUES ('binding-original',?,'target-a',?,?,0,11,'exact',?)`)
    .run(source.document, source.version, source.block, now);
  const version = 'doc-a-v2';
  db.prepare(`INSERT INTO document_versions
    (version_id,document_id,version_no,source_sha256,parser_id,parser_version,model_schema_version,parse_status,created_at)
    VALUES (?,?,2,?,'markdown','design-test',1,'ready',?)`).run(version, source.document, digest('a'), now);
  db.prepare(`INSERT INTO annotation_bindings
    (binding_id,document_id,target_id,version_id,binding_status,mapping_json,created_at)
    VALUES ('binding-ambiguous',?,'target-a',?,'ambiguous','{"reason":"multiple matching passages"}',?)`)
    .run(source.document, version, now);
  assert.equal(db.prepare('SELECT original_version_id FROM annotation_targets').get().original_version_id, source.version);
  assert.deepEqual(db.prepare('SELECT binding_status FROM annotation_bindings ORDER BY version_id').all()
    .map(row => row.binding_status), ['exact', 'ambiguous']);
  const evidence = db.prepare(`INSERT INTO source_refs
    (source_ref_id,source_document_id,version_id,block_id,annotation_target_id,annotation_binding_id,
      content_origin,quote,quote_sha256,locator_json,created_at)
    VALUES (?,?,?,?, 'target-a',?,'annotation','Convolution',?,'{}',?)`);
  evidence.run('original-evidence', source.document, source.version, source.block, 'binding-original', digest('b'), now);
  assert.throws(() => evidence.run('ambiguous-evidence', source.document, source.version,
    source.block, 'binding-ambiguous', digest('b'), now), /FOREIGN KEY/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // Matching quality and user confirmation still need runtime tests after implementation.
});
