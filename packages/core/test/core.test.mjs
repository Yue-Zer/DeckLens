import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { SqliteDatabase as Database } from "../dist/sqlite.js";
import JSZip from "jszip";
import { createCore } from "../dist/index.js";
import { normalizeParsedDocument } from "../dist/parsers.js";

async function withCore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "decklens-core-test-"));
  const core = createCore(dir);
  try { await fn(core, dir); }
  finally { await core.storage.close(); await rm(dir, { recursive: true, force: true }); }
}

const markdown = `# 机器学习\n\n机器学习：计算机通过数据改善任务表现的方法。\n\n## Neural Network\n\nNeural Network is a layered model that learns representations from data.\n\nA Neural Network differs from Network and a NetworkX library.\n\n## Ranking\n\nRanking compares retrieved evidence and selects relevant document passages.\n`;

const flat = (sections) => sections.flatMap(section => [section, ...flat(section.children)]);

test("fresh SQLite migrates, persists, and reopens without source directory data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decklens-migration-test-"));
  let core = createCore(dir);
  try {
    assert.deepEqual(core.documents.list(), []);
    const result = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
    await core.storage.close();
    core = createCore(dir);
    assert.equal(core.documents.get(result.document.id).title, "机器学习");
    const db = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 7);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally { db.close(); }
  } finally { await core.storage.close(); await rm(dir, { recursive: true, force: true }); }
});

test("SQLite nested savepoints preserve outer writes and reject asynchronous callbacks", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE items(value TEXT)");
    db.transaction(() => {
      db.prepare("INSERT INTO items VALUES(?)").run("outer-before");
      assert.throws(() => db.transaction(() => { db.prepare("INSERT INTO items VALUES(?)").run("inner"); throw new Error("fail inner"); })(), /fail inner/);
      db.prepare("INSERT INTO items VALUES(?)").run("outer-after");
    })();
    assert.deepEqual(db.prepare("SELECT value FROM items ORDER BY rowid").all().map(row => row.value), ["outer-before", "outer-after"]);
    assert.throws(() => db.transaction(() => { db.transaction(() => db.prepare("INSERT INTO items VALUES(?)").run("nested"))(); throw new Error("outer failure"); })(), /outer failure/);
    assert.throws(() => db.transaction(async () => {})(), /synchronously/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get().n, 2);
  } finally { db.close(); }
});

test("v1 databases migrate without losing structure, exploration, sources or indexed text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decklens-old-schema-"));
  let core = createCore(dir);
  try {
    const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "old.md" });
    const section = flat(imported.tree.sections).find(item => item.title === "Ranking");
    core.sections.applyEdits(imported.document.id, [{ operation: "rename", sectionId: section.id, title: "手动标题" }]);
    const node = core.exploration.createNode({ documentId: imported.document.id, title: "原文引用", anchor: { blockId: section.blocks[1].id } });
    const before = core.documents.blocks(imported.document.id).map(block => [block.text, block.sourceLocator.lineStart]);
    await core.storage.close();
    core = undefined;
    const old = new Database(join(dir, "db", "decklens.sqlite"));
    try {
      old.exec(`
        DROP TABLE article_annotation_targets;
        DROP TABLE article_annotations;
        DROP TABLE file_folder_memberships;
        DROP TABLE file_folders;
        DROP TABLE learning_article_figures;
        DROP TABLE learning_article_sources;
        DROP TABLE learning_article_paragraphs;
        DROP TABLE learning_article_sections;
        DROP TABLE learning_articles;
        DROP INDEX blocks_source_order_idx;
        ALTER TABLE blocks DROP COLUMN source_order;
        ALTER TABLE explore_state DROP COLUMN floating_state_json;
        DELETE FROM schema_migrations WHERE version>=2;
      `);
    } finally { old.close(); }
    core = createCore(dir);
    const blocks = core.documents.blocks(imported.document.id);
    assert.deepEqual(blocks.map(block => [block.text, block.sourceLocator.lineStart]), before);
    assert.deepEqual(blocks.map(block => block.sourceOrder), blocks.map((_, index) => index));
    assert.ok(flat(core.documents.tree(imported.document.id).sections).some(item => item.title === "手动标题"));
    assert.equal(core.exploration.getNode(node.id).sources[0].blockId, section.blocks[1].id);
    const db = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
    try {
      assert.ok(db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'Ranking'").get().n > 0);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally { db.close(); }
  } finally { if (core) await core.storage.close(); await rm(dir, { recursive: true, force: true }); }
});

test("unknown or altered migration history refuses startup without modifying documents", async () => {
  for (const mutation of ["UPDATE schema_migrations SET checksum='tampered' WHERE version=1", "INSERT INTO schema_migrations SELECT MAX(version)+1,'future','2026-01-01' FROM schema_migrations"]) {
    const dir = await mkdtemp(join(tmpdir(), "decklens-bad-migration-"));
    let core = createCore(dir);
    try {
      const imported = await core.documents.importFile(Buffer.from("# Safe\n\nPreserved."), { originalName: "safe.md" });
      await core.storage.close();
      const db = new Database(join(dir, "db", "decklens.sqlite"));
      try { db.exec(mutation); } finally { db.close(); }
      assert.throws(() => createCore(dir), /MIGRATION_CHECKSUM_MISMATCH|SCHEMA_VERSION_UNSUPPORTED/);
      const verify = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
      try { assert.equal(verify.prepare("SELECT document_id FROM documents").get().document_id, imported.document.id); }
      finally { verify.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("provider profiles keep API keys outside SQLite and public profile records", async () => {
  await withCore(async (core, dir) => {
    const key = "test-secret-that-must-not-enter-sqlite";
    const profile = core.providers.save({
      name: "DeepSeek test", providerKind: "deepseek", protocol: "openai-chat",
      baseUrl: "https://api.deepseek.com", model: "deepseek-chat", timeoutMs: 30000,
      supportsStreaming: true, supportsVision: false, apiKey: key, activate: true,
    });
    assert.equal(profile.active, true);
    assert.equal(profile.hasApiKey, true);
    assert.equal("apiKey" in profile, false);
    assert.equal("secret" in profile, false);
    assert.throws(() => core.providers.save({
      name: "Insecure remote", providerKind: "custom", protocol: "openai-chat",
      baseUrl: "http://model.example.com/v1", model: "unsafe", timeoutMs: 30000,
      supportsStreaming: true, supportsVision: false,
    }), error => error.code === "INVALID_PROVIDER_URL");

    const db = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
    const storedRows = db.prepare("SELECT * FROM provider_profiles").all();
    assert.equal(JSON.stringify(storedRows).includes(key), false);
    db.close();

    const secrets = JSON.parse(await readFile(join(dir, "config", "provider-secrets.json"), "utf8"));
    assert.equal(secrets.profiles[profile.id], key);
    const second = core.providers.save({
      name: "Ollama test", providerKind: "ollama", protocol: "ollama-chat",
      baseUrl: "http://127.0.0.1:11434", model: "local-model", timeoutMs: 30000,
      supportsStreaming: true, supportsVision: false,
    });
    assert.equal(core.providers.activate(second.id).active, true);
    assert.equal(core.providers.get(profile.id).active, false);
    core.providers.remove(profile.id);
    await assert.rejects(readFile(join(dir, "config", "provider-secrets.json"), "utf8"), error => error.code === "ENOENT");
  });
});

test("provider adapters normalize OpenAI-compatible and Ollama chat and stream responses", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    requests.push({ path: request.url, authorization: request.headers.authorization, payload });
    if (payload.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (request.url === "/v1/chat/completions") {
        response.end('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\ndata: [DONE]\n\n');
      } else {
        response.end('{"message":{"content":"ollama-stream"},"done":true}\n');
      }
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/v1/chat/completions"
      ? JSON.stringify({ choices: [{ message: { content: "openai-compatible response" } }] })
      : JSON.stringify({ message: { content: "ollama response" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await withCore(async core => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const compatible = core.providers.save({
        name: "Compatible", providerKind: "openai-compatible", protocol: "openai-chat",
        baseUrl: `${baseUrl}/v1`, model: "fixture-model", timeoutMs: 5000,
        supportsStreaming: true, supportsVision: false, apiKey: "fixture-key", activate: true,
      });
      assert.equal(await core.providers.complete({ profileId: compatible.id, messages: [{ role: "user", content: "hello" }], temperature: 0.2, maxTokens: 32 }), "openai-compatible response");
      assert.equal(requests[0].path, "/v1/chat/completions");
      assert.equal(requests[0].authorization, "Bearer fixture-key");
      assert.equal(requests[0].payload.temperature, 0.2);
      assert.equal(requests[0].payload.max_tokens, 32);

      const tokens = [];
      for await (const token of core.providers.stream({ profileId: compatible.id, messages: [{ role: "user", content: "hello" }] })) tokens.push(token);
      assert.deepEqual(tokens, ["streamed"]);

      const ollama = core.providers.save({
        name: "Local", providerKind: "ollama", protocol: "ollama-chat",
        baseUrl, model: "llama-local", timeoutMs: 5000,
        supportsStreaming: true, supportsVision: true,
      });
      assert.equal(await core.providers.complete({ profileId: ollama.id, messages: [{ role: "user", content: "hello" }], maxTokens: 21 }), "ollama response");
      assert.equal(requests.at(-1).path, "/api/chat");
      assert.equal(requests.at(-1).payload.options.num_predict, 21);
      const localTokens = [];
      for await (const token of core.providers.stream({ profileId: ollama.id, messages: [{ role: "user", content: "hello" }] })) localTokens.push(token);
      assert.deepEqual(localTokens, ["ollama-stream"]);
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("provider capability checks and upstream errors explain unsupported requests without exposing response bodies", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "raw provider body with secret should not surface" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await withCore(async core => {
      const profile = core.providers.save({
        name: "No vision", providerKind: "custom", protocol: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "text-only", timeoutMs: 5000,
        supportsStreaming: false, supportsVision: false, apiKey: "private-key",
      });
      await assert.rejects(core.providers.complete({ profileId: profile.id, messages: [{ role: "user", content: [{ type: "image", dataUrl: "data:image/png;base64,AQ==" }] }] }), error => error.code === "MODEL_VISION_UNSUPPORTED");
      await assert.rejects(async () => {
        for await (const _token of core.providers.stream({ profileId: profile.id, messages: [{ role: "user", content: "hello" }] })) { /* consume */ }
      }, error => error.code === "PROVIDER_STREAM_UNSUPPORTED");
      assert.equal(requests, 0);

      const capable = core.providers.save({
        name: "Vision configured", providerKind: "custom", protocol: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "vision-model", timeoutMs: 5000,
        supportsStreaming: true, supportsVision: true, apiKey: "vision-key",
      });
      await assert.rejects(core.providers.complete({ profileId: capable.id, messages: [{ role: "user", content: [{ type: "image", dataUrl: "data:image/png;base64,AQ==" }] }] }), error => error.code === "MODEL_VISION_REJECTED" && !error.message.includes("raw provider body"));
      await assert.rejects(core.providers.complete({ profileId: capable.id, messages: [{ role: "user", content: "hello" }], temperature: 0.5 }), error => error.code === "PROVIDER_PARAMETER_UNSUPPORTED");
      assert.equal(requests, 2);

      const reserved = core.providers.save({
        name: "Reserved", providerKind: "anthropic", protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com", model: "claude", timeoutMs: 5000,
        supportsStreaming: true, supportsVision: false, apiKey: "reserved-key",
      });
      await assert.rejects(core.providers.complete({ profileId: reserved.id, messages: [{ role: "user", content: "hello" }] }), error => error.code === "PROVIDER_PROTOCOL_RESERVED");
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("provider request timeout returns a specific timeout error", async () => {
  const server = createServer((_request, response) => setTimeout(() => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
  }, 1500));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await withCore(async core => {
      const profile = core.providers.save({
        name: "Slow", providerKind: "custom", protocol: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "slow-model", timeoutMs: 1000,
        supportsStreaming: false, supportsVision: false, apiKey: "slow-key",
      });
      await assert.rejects(core.providers.complete({ profileId: profile.id, messages: [{ role: "user", content: "hello" }] }), error => error.code === "PROVIDER_TIMEOUT");
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("provider requests reject redirects instead of forwarding prompts or credentials", async () => {
  let destinationRequests = 0;
  const destination = createServer((_request, response) => {
    destinationRequests++;
    response.end(JSON.stringify({ choices: [{ message: { content: "unexpected" } }] }));
  });
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/capture` });
    response.end();
  });
  await new Promise(resolve => redirect.listen(0, "127.0.0.1", resolve));
  try {
    await withCore(async core => {
      const profile = core.providers.save({
        name: "Redirect", providerKind: "custom", protocol: "openai-chat",
        baseUrl: `http://127.0.0.1:${redirect.address().port}/v1`, model: "redirect-model", timeoutMs: 5000,
        supportsStreaming: false, supportsVision: false, apiKey: "redirect-secret",
      });
      await assert.rejects(core.providers.complete({ profileId: profile.id, messages: [{ role: "user", content: "private prompt" }] }), error => error.code === "PROVIDER_CONNECTION_FAILED");
      assert.equal(destinationRequests, 0);
    });
  } finally {
    await Promise.all([
      new Promise(resolve => redirect.close(resolve)),
      new Promise(resolve => destination.close(resolve)),
    ]);
  }
});

test("source identity keeps repeated text at distinct positions while removing duplicate emissions", () => {
  const block = (key, line) => ({ sourceBlockKey: key, sourceOrder: line, type: "paragraph", text: "same text", payload: {}, sourceLocator: { format: "markdown", sourceHash: "hash", lineStart: line, lineEnd: line } });
  const parsed = { format: "markdown", title: "test", language: "en", sections: [{ sourceSectionKey: "root", title: "test", depth: 0, sourceOrder: 0, sourceLocator: {}, blocks: [block("one", 1), block("alias", 1), block("two", 3)] }] };
  const normalized = normalizeParsedDocument(parsed);
  assert.deepEqual(normalized.sections[0].blocks.map(item => item.sourceBlockKey), ["one", "two"]);
  assert.deepEqual(normalized.sections[0].blocks.map(item => item.sourceOrder), [0, 1]);
  assert.deepEqual(normalized.sections[0].blocks[0].sourceKeyAliases, ["alias"]);
  assert.throws(() => normalizeParsedDocument({ ...parsed, sections: [{ ...parsed.sections[0], blocks: [block("key", 1), block("key", 2)] }] }), /SOURCE_KEY_CONFLICT/);
});

test("Markdown source ordering and safe embedded image handling", async () => {
  await withCore(async (core, dir) => {
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
    const content = `Learning\n========\n\nSame paragraph.\n\n![pixel](data:image/png;base64,${pixel})\n\nSame paragraph.\n\n![external](https://example.com/pixel.png)\n\n![file](../../secret.png)\n\n![svg](data:image/svg+xml;base64,PHN2Zz4=)\n\n~~~js\nconst x = 1;\n~~~`;
    const imported = await core.documents.importFile(Buffer.from(content), { originalName: "images.md" });
    const blocks = core.documents.blocks(imported.document.id);
    assert.deepEqual(blocks.map(item => item.sourceOrder), blocks.map((_, index) => index));
    assert.equal(blocks[0].text, "Learning");
    assert.deepEqual(blocks.filter(block => block.text === "Same paragraph.").map(block => block.sourceLocator.lineStart), [4, 8]);
    const images = blocks.filter(block => block.type === "image");
    assert.equal(images.length, 4);
    assert.equal(images[0].sourceLocator.lineStart, 6);
    assert.ok(images[0].payload.assetId);
    assert.equal(core.documents.assetById(images[0].payload.assetId).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(images[1].payload.missingReason, "IMAGE_EXTERNAL_OR_LOCAL_BLOCKED");
    assert.equal(images[2].payload.missingReason, "IMAGE_EXTERNAL_OR_LOCAL_BLOCKED");
    assert.equal(images[3].payload.missingReason, "IMAGE_UNSUPPORTED");
    assert.ok(blocks.some(block => block.type === "code" && block.payload.language === "js"));
    const db = new Database(join(dir, "db", "decklens.sqlite"));
    const primary = db.prepare("SELECT * FROM assets WHERE asset_id=?").get(images[0].payload.assetId);
    db.prepare("INSERT INTO assets(asset_id,version_id,block_id,relative_path,mime_type,size_bytes,sha256) VALUES(?,?,?,?,?,?,?)").run("second-asset", primary.version_id, primary.block_id, "assets/second.png", primary.mime_type, primary.size_bytes, primary.sha256);
    db.close();
    assert.equal(core.documents.blocks(imported.document.id).length, blocks.length);
    assert.equal(flat(core.documents.tree(imported.document.id).sections).flatMap(section => section.blocks).filter(block => block.id === images[0].id).length, 1);
    assert.equal(core.documents.block(images[0].id).payload.assets.length, 2);
  });
});

test("normalized annotations persist across database reopen and reject invalid geometry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decklens-annotation-test-"));
  let core = createCore(dir);
  try {
    const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "annotated.md" });
    const block = core.documents.blocks(imported.document.id).find(item => item.text.includes("Ranking compares"));
    const saved = core.annotations.create({
      documentId: imported.document.id,
      tool: "lasso",
      targets: [{ blockId: block.id, shape: "polygon", strokeRatio: 0.0025, points: [{ x: 0.12, y: 0.2 }, { x: 0.82, y: 0.18 }, { x: 0.78, y: 0.76 }] }],
    });
    assert.equal(core.annotations.list(imported.document.id)[0].id, saved.id);
    assert.throws(() => core.annotations.create({
      documentId: imported.document.id,
      tool: "pen",
      targets: [{ blockId: block.id, shape: "path", strokeRatio: 0.003, points: [{ x: -0.1, y: 0.2 }, { x: 0.5, y: 0.3 }] }],
    }), error => error.code === "INVALID_ANNOTATION");
    await core.storage.close();
    core = createCore(dir);
    const restored = core.annotations.list(imported.document.id);
    assert.equal(restored.length, 1);
    assert.deepEqual(restored[0].targets[0].points, [{ x: 0.12, y: 0.2 }, { x: 0.82, y: 0.18 }, { x: 0.78, y: 0.76 }]);
    core.annotations.delete(saved.id);
    assert.deepEqual(core.annotations.list(imported.document.id), []);
  } finally { await core.storage.close(); await rm(dir, { recursive: true, force: true }); }
});

test("image lasso asks require visual capability and persist their annotation source", async () => {
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "圖片內容已依照可見證據解釋。" } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await withCore(async core => {
      const imported = await core.documents.importFile(Buffer.from(`# Image study\n\n![pixel](data:image/png;base64,${pixel})`), { originalName: "image.md" });
      const image = core.documents.blocks(imported.document.id).find(block => block.type === "image");
      const imageRef = { blockId: image.id, assetId: image.payload.assetId };
      const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      core.providers.save({ name: "Text only", providerKind: "custom", protocol: "openai-chat", baseUrl, model: "text-only", timeoutMs: 5000, supportsStreaming: true, supportsVision: false, apiKey: "text-key", activate: true });
      await assert.rejects(core.chat.ask({ documentId: imported.document.id, question: "解释图片", anchor: { blockId: image.id }, images: [imageRef] }), error => error.code === "MODEL_VISION_UNSUPPORTED");
      assert.equal(requests.length, 0);

      core.providers.save({ name: "Vision capable", providerKind: "custom", protocol: "openai-chat", baseUrl, model: "vision-model", timeoutMs: 5000, supportsStreaming: true, supportsVision: true, apiKey: "vision-key", activate: true });
      const result = await core.chat.ask({ documentId: imported.document.id, question: "解释这个圈选区域", anchor: { blockId: image.id }, images: [imageRef], context: { annotationId: "annotation-region-1", selectionBlockIds: [image.id] } });
      assert.equal(result.node.context.annotationId, "annotation-region-1");
      assert.equal(result.node.sources.find(source => source.role === "anchor").blockId, image.id);
      const imagePart = requests[0].messages.at(-1).content.find(part => part.type === "image_url");
      assert.ok(imagePart.image_url.url.startsWith("data:image/png;base64,"));
      assert.equal(requests[0].messages.at(-1).content[0].type, "text");
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("failed reparse preserves the active version, edits, and historical source references", async () => {
  await withCore(async (core, dir) => {
    const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
    const section = flat(imported.tree.sections).find(item => item.title === "Ranking");
    core.sections.applyEdits(imported.document.id, [{ operation: "rename", sectionId: section.id, title: "保留的章节" }]);
    const node = core.exploration.createNode({ documentId: imported.document.id, title: "原文锚点", anchor: { blockId: section.blocks[1].id } });
    const source = join(dir, ...imported.document.sourceRelativePath.split("/"));
    await writeFile(source, "corrupted source");
    await assert.rejects(core.documents.reparse(imported.document.id), error => error.code === "SOURCE_HASH_MISMATCH");
    assert.equal(core.documents.get(imported.document.id).activeVersionId, imported.document.activeVersionId);
    assert.ok(flat(core.documents.tree(imported.document.id).sections).some(item => item.title === "保留的章节"));
    assert.equal(core.exploration.getNode(node.id).sources[0].blockId, section.blocks[1].id);
  });
});

test("text validation rejects binary masquerading as text and preserves UTF-16 text", async () => {
  await withCore(async core => {
    await assert.rejects(core.documents.importFile(Buffer.from([0xff, 0x00, 0x01, 0x02]), { originalName: "binary.md" }), /INVALID_TEXT_ENCODING|BINARY_TEXT_FILE/);
    await assert.rejects(core.documents.importFile(Buffer.from("%PDF-1.7 fake"), { originalName: "renamed.txt" }), /CORRUPT_PDF/);
    await assert.rejects(core.documents.importFile(Buffer.from("d0cf11e0a1b11ae1", "hex"), { originalName: "encrypted.pptx" }), /ENCRYPTED_OR_LEGACY_OFFICE/);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("第一章 文本\n\n本地文档解析正常。", "utf16le")]);
    const imported = await core.documents.importFile(bytes, { originalName: "utf16.txt" });
    assert.equal(imported.document.format, "txt");
    assert.ok(core.documents.blocks(imported.document.id).some(block => block.text.includes("本地文档")));
  });
});

test("duplicate hashes, Chinese source definitions, and longest term matching are deterministic", async () => {
  await withCore(async core => {
    const result = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
    const duplicate = await core.documents.importFile(Buffer.from(markdown), { originalName: "renamed.txt" });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.document.id, result.document.id);
    const zh = result.terms.find(term => term.canonicalText === "机器学习");
    assert.ok(zh, "Chinese term must survive normalization");
    assert.equal(zh.normalizedText, "机器学习");
    assert.equal(zh.definitions[0].kind, "source");
    assert.equal(zh.definitions[0].sourceLocator.format, "markdown");
    const byBlock = new Map();
    for (const term of result.terms) for (const mention of term.mentions) {
      const previous = byBlock.get(mention.blockId) ?? [];
      assert.ok(previous.every(range => mention.startOffset >= range.endOffset || mention.endOffset <= range.startOffset), "term spans cannot overlap");
      byBlock.set(mention.blockId, [...previous, mention]);
      const block = core.documents.block(mention.blockId);
      assert.equal(block.text.slice(mention.startOffset, mention.endOffset), mention.matchedText);
      if (term.canonicalText === "Network") assert.ok(!block.text.slice(mention.startOffset).startsWith("NetworkX"));
    }
    assert.ok(result.terms.flatMap(term => term.mentions).filter(mention => mention.displayMode === "anchor").length <= 6);
    const before = zh.definitions.length;
    const refreshed = core.terms.refresh(result.document.id).find(term => term.id === zh.id);
    assert.equal(refreshed.definitions.length, before);
  });
});

test("TXT explicit numbering keeps nested headings under their nearest parent", async () => {
  await withCore(async core => {
    const content = "1 第一部分\n\n概述。\n\n1.1 第一小节\n\n细节。\n\n1.1.1 下钻内容\n\n证据。\n\n1.2 第二小节\n\n第二段。\n\n2 第二部分\n\n结束。";
    const imported = await core.documents.importFile(Buffer.from(content), { originalName: "numbered.txt" });
    const roots = imported.tree.sections[0].children;
    assert.deepEqual(roots.map(section => section.title), ["1 第一部分", "2 第二部分"]);
    assert.deepEqual(roots[0].children.map(section => section.title), ["1.1 第一小节", "1.2 第二小节"]);
    assert.equal(roots[0].children[0].children[0].title, "1.1.1 下钻内容");
    assert.equal(roots[0].children[0].children[0].depth, 3);
    assert.ok(roots[0].children[0].children[0].blocks.some(block => block.text === "证据。"));
  });
});

test("short explicit definitions and parenthesized aliases prefer native sources", async () => {
  await withCore(async core => {
    const content = "# 文档证据\n\nRAG 是指检索增强生成。回答应当基于检索到的原文证据。\n\n上下文（Context）是指前后信息。\n\nID means identity.\n\n标识符 (Identifier) 定义为唯一标记。";
    const imported = await core.documents.importFile(Buffer.from(content), { originalName: "short-definitions.md" });
    for (const label of ["RAG", "上下文", "Context", "ID", "标识符", "Identifier"]) {
      const term = imported.terms.find(candidate => candidate.canonicalText === label);
      assert.ok(term, `${label} must be extracted`);
      assert.equal(term.definitions[0].kind, "source", `${label} must use its explicit source definition`);
      assert.equal((await core.terms.explain(term.id)).definitions[0].kind, "source");
    }
    assert.equal(imported.terms.find(term => term.canonicalText === "RAG").definitions[0].text, "检索增强生成");
    assert.equal(imported.terms.find(term => term.canonicalText === "Context").definitions[0].text, "前后信息");
  });
});

test("hierarchical exploration persists sources, context, branches and selected chat", async () => {
  const server = createServer(async (request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ message: { content: "Ranking compares retrieved evidence and selects relevant document passages. [1]" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await withCore(async (core, dir) => {
      const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
      const id = imported.document.id;
      const selected = core.chat.create(id, "第二条探索主线");
      core.settings.saveProvider({ provider: "ollama", baseUrl: `http://127.0.0.1:${server.address().port}`, model: "fixture-model" });
      const root = await core.chat.ask({ documentId: id, chatId: selected.id, question: "How does Ranking select evidence?" });
      assert.equal(root.node.chatId, selected.id);
      assert.equal(root.foundEvidence, true);
      assert.ok(root.citations.length > 0);
      assert.match(root.answer, /Ranking compares/);
      const branch = await core.chat.ask({ documentId: id, chatId: selected.id, parentNodeId: root.node.id, branchKind: "branch", question: "Explain Ranking evidence" });
      const related = core.exploration.createNode({ documentId: id, chatId: selected.id, parentNodeId: root.node.id, branchKind: "related", kind: "explanation", title: "关联表示", answer: "引用保留", anchor: { blockId: root.citations[0].blockId } });
      assert.equal(branch.node.parentNodeId, root.node.id);
      assert.equal(related.parentNodeId, root.node.id);
      assert.ok(related.edges.some(edge => edge.kind === "related"));
      core.exploration.saveState(selected.id, { activeNodeId: branch.node.id, expandedNodes: [root.node.id], activeBlockId: root.citations[0].blockId });
      assert.equal(core.exploration.getState(selected.id).activeNodeId, branch.node.id);
      assert.throws(() => core.exploration.addEdge({ chatId: selected.id, fromNodeId: branch.node.id, toNodeId: root.node.id, kind: "deepens" }), /形成循环/);
      assert.ok(core.chat.messages(selected.id).some(message => message.role === "assistant" && message.citations.length > 0));
      const db = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
      const snapshot = JSON.parse(db.prepare("SELECT sources_json FROM context_snapshots WHERE snapshot_id=?").get(branch.node.contextSnapshotId).sources_json);
      assert.ok(snapshot.ancestors.includes(root.node.id));
      assert.ok(snapshot.sources.length > 0);
      assert.ok(snapshot.sources.every(source => source.locator.documentVersionId));
      db.close();
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("referential follow-ups inherit verified parent evidence without grounding unrelated topics", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ message: { content: "Ranking compares retrieved evidence and selects relevant passages. [1]" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await withCore(async (core, dir) => {
      const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
      core.settings.saveProvider({ provider: "ollama", baseUrl: `http://127.0.0.1:${server.address().port}`, model: "fixture-model" });
      const root = await core.chat.ask({ documentId: imported.document.id, question: "Explain Ranking" });
      assert.equal(root.foundEvidence, true);
      for (const question of ["继续解释", "为什么？", "why?", "换个角度：继续解释", "继续深入：为什么？", "换个角度：继续深入：换个角度：why?"]) {
        const followUp = await core.chat.ask({ documentId: imported.document.id, parentNodeId: root.node.id, branchKind: "branch", question });
        assert.equal(followUp.foundEvidence, true, `${question} must retain its parent's evidence`);
        assert.equal(followUp.node.parentNodeId, root.node.id);
        assert.deepEqual(followUp.citations, root.citations);
        assert.ok(followUp.node.sources.every(source => source.documentVersionId === imported.document.activeVersionId));
        assert.ok(requests.at(-1).messages.some(message => message.content === "Explain Ranking"), "the model must receive the ancestor question");
      }
      const callsBeforeUnrelated = requests.length;
      const wrappedUnrelated = await core.chat.ask({ documentId: imported.document.id, parentNodeId: root.node.id, branchKind: "branch", question: "换个角度：继续深入：火星地幔由什么组成？" });
      assert.equal(wrappedUnrelated.foundEvidence, false, "application wrappers must not turn a new topic into a referential follow-up");
      assert.deepEqual(wrappedUnrelated.citations, []);
      assert.equal(requests.length, callsBeforeUnrelated);
      const unrelated = await core.chat.ask({ documentId: imported.document.id, parentNodeId: root.node.id, question: "火星为什么适合居住？" });
      assert.equal(unrelated.foundEvidence, false);
      assert.deepEqual(unrelated.citations, []);
      assert.equal(requests.length, callsBeforeUnrelated, "an unrelated topic cannot borrow parent evidence or call the model");
      const afterRefusal = await core.chat.ask({ documentId: imported.document.id, parentNodeId: unrelated.node.id, question: "为什么？" });
      assert.equal(afterRefusal.foundEvidence, false, "a refusal cannot silently resume evidence from an earlier topic");
      const wrappedAfterRefusal = await core.chat.ask({ documentId: imported.document.id, parentNodeId: wrappedUnrelated.node.id, branchKind: "branch", question: "换个角度：继续深入：继续解释" });
      assert.equal(wrappedAfterRefusal.foundEvidence, false, "wrapped follow-ups cannot cross a refusal to borrow an older topic");
      assert.deepEqual(wrappedAfterRefusal.citations, []);
      assert.equal(requests.length, callsBeforeUnrelated);
      const reparsed = await core.documents.reparse(imported.document.id);
      const historical = await core.chat.ask({ documentId: imported.document.id, parentNodeId: root.node.id, question: "why is that?" });
      assert.equal(historical.foundEvidence, true);
      assert.notEqual(reparsed.document.activeVersionId, imported.document.activeVersionId);
      assert.match(historical.answer, /历史解析版本/);
      assert.deepEqual(historical.citations, root.citations);
      for (const source of historical.node.sources) {
        assert.equal(source.documentVersionId, imported.document.activeVersionId);
        assert.equal(source.locator.documentVersionId, imported.document.activeVersionId);
        const block = core.documents.block(source.blockId);
        assert.equal(block.text.slice(source.startOffset, source.endOffset), source.quote);
      }
      const db = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
      const snapshot = JSON.parse(db.prepare("SELECT sources_json FROM context_snapshots WHERE snapshot_id=?").get(historical.node.contextSnapshotId).sources_json);
      assert.equal(snapshot.context.retrievalMode, "parent-source-fallback");
      assert.ok(snapshot.context.inheritedSources.every(source => source.nodeId === root.node.id && source.documentVersionId === imported.document.activeVersionId));
      db.close();
      await assert.rejects(core.chat.ask({ documentId: imported.document.id, question: "Ranking?", anchor: { blockId: root.citations[0].blockId } }), error => error.code === "STALE_ANCHOR");
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("single-node deletion rejects live child branches and permits deleting leaves", async () => {
  await withCore(async core => {
    const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
    const root = core.exploration.createNode({ documentId: imported.document.id, title: "root" });
    const child = core.exploration.createNode({ documentId: imported.document.id, parentNodeId: root.id, title: "child", branchKind: "branch" });
    const leaf = core.exploration.createNode({ documentId: imported.document.id, parentNodeId: child.id, title: "leaf" });
    assert.throws(() => core.exploration.deleteNode(root.id), error => error.code === "NODE_HAS_CHILDREN");
    assert.throws(() => core.exploration.deleteNode(child.id), error => error.code === "NODE_HAS_CHILDREN");
    assert.equal(core.exploration.getNode(child.id).parentNodeId, root.id);
    core.exploration.deleteNode(leaf.id);
    assert.throws(() => core.exploration.getNode(leaf.id), error => error.code === "NODE_NOT_FOUND");
    core.exploration.deleteNode(child.id);
    core.exploration.deleteNode(root.id);
    assert.deepEqual(core.exploration.listNodes(imported.document.id), []);
    const branchRoot = core.exploration.createNode({ documentId: imported.document.id, title: "another root" });
    core.exploration.createNode({ documentId: imported.document.id, parentNodeId: branchRoot.id, title: "another child" });
    core.exploration.deleteBranch(branchRoot.id);
    assert.deepEqual(core.exploration.listNodes(imported.document.id), []);
  });
});

test("context snapshots record exact outbound messages and ancestor truncation", async () => {
  let outboundMessages;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    outboundMessages = JSON.parse(body).messages;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ message: { content: "Ranking selects relevant passages. [1]" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await withCore(async (core, dir) => {
      const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
      let parent;
      const ancestorMessages = [];
      for (let index = 0; index < 6; index++) {
        const question = `ancestor-question-${index}`;
        const answer = `ancestor-answer-${index}`;
        parent = core.exploration.createNode({ documentId: imported.document.id, parentNodeId: parent?.id, title: question, question, answer });
        ancestorMessages.push({ role: "user", content: question }, { role: "assistant", content: answer });
      }
      const note = core.exploration.createNode({ documentId: imported.document.id, parentNodeId: parent.id, kind: "note", title: "离线阅读笔记" });
      core.exploration.updateNode(note.id, { answer: "我对 Ranking 的理解" });
      assert.equal(core.exploration.getNode(note.id).messages.at(-1).content, "我对 Ranking 的理解");
      core.settings.saveProvider({ provider: "ollama", baseUrl: `http://127.0.0.1:${server.address().port}`, model: "fixture-model" });
      const answer = await core.chat.ask({ documentId: imported.document.id, parentNodeId: parent.id, question: "Explain Ranking" });
      const db = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
      const snapshot = db.prepare("SELECT * FROM context_snapshots WHERE snapshot_id=?").get(answer.node.contextSnapshotId);
      assert.deepEqual(JSON.parse(snapshot.messages_json), outboundMessages);
      assert.equal(outboundMessages.length, 10);
      assert.equal(outboundMessages[0].role, "system");
      assert.deepEqual(outboundMessages.slice(1, -1), ancestorMessages.slice(-8));
      assert.equal(JSON.parse(snapshot.ancestor_path_json).length, 6);
      assert.deepEqual(JSON.parse(snapshot.truncation_json), { policy: "last-8-ancestor-messages", maxAncestorMessages: 8,
        availableAncestorMessages: 12, includedAncestorMessages: 8, omittedAncestorMessages: 4, requestAttempted: true, requestOutcome: "complete" });
      assert.equal(snapshot.policy_version, "context-v2");
      db.close();
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("cross-document and cross-chat references are rejected before model calls", async () => {
  await withCore(async core => {
    const first = await core.documents.importFile(Buffer.from(markdown), { originalName: "one.md" });
    const second = await core.documents.importFile(Buffer.from("# Other\n\nOther evidence."), { originalName: "two.md" });
    const node = core.exploration.createNode({ documentId: first.document.id, title: "根" });
    const otherChat = core.chat.create(first.document.id, "另一会话");
    const foreignBlock = core.documents.blocks(second.document.id)[0];
    await assert.rejects(core.chat.ask({ documentId: second.document.id, parentNodeId: node.id, question: "Other?" }), /同一文档/);
    await assert.rejects(core.chat.ask({ documentId: first.document.id, chatId: otherChat.id, parentNodeId: node.id, question: "Ranking?" }), /所选会话/);
    await assert.rejects(core.chat.ask({ documentId: first.document.id, question: "Other?", anchor: { blockId: foreignBlock.id } }), /当前文档/);
    await assert.rejects(core.chat.ask({ documentId: second.document.id, chatId: otherChat.id, question: "Other?" }), /当前文档/);
    const foreignNode = core.exploration.createNode({ documentId: second.document.id, title: "另一个根" });
    assert.throws(() => core.exploration.addEdge({ chatId: node.chatId, fromNodeId: node.id, toNodeId: foreignNode.id, kind: "related" }), /同一会话/);
  });
});

test("view state rejects foreign paths and preserves an explicit historical source version", async () => {
  await withCore(async core => {
    const first = await core.documents.importFile(Buffer.from(markdown), { originalName: "one.md" });
    const second = await core.documents.importFile(Buffer.from("# Other\n\nOther evidence."), { originalName: "two.md" });
    const root = core.exploration.createNode({ documentId: first.document.id, title: "根" });
    const branch = core.exploration.createNode({ documentId: first.document.id, chatId: root.chatId, parentNodeId: root.id, title: "分支", branchKind: "branch" });
    const otherChat = core.chat.create(first.document.id, "另一会话");
    const foreignNode = core.exploration.createNode({ documentId: first.document.id, chatId: otherChat.id, title: "另一个节点" });
    const oldBlock = core.documents.blocks(first.document.id)[0];
    const foreignBlock = core.documents.blocks(second.document.id)[0];
    assert.throws(() => core.exploration.saveState(root.chatId, { activeNodeId: foreignNode.id }), error => error.code === "CROSS_CHAT_STATE");
    assert.throws(() => core.exploration.saveState(root.chatId, { expandedNodes: [foreignNode.id] }), error => error.code === "CROSS_CHAT_STATE");
    assert.throws(() => core.exploration.saveState(root.chatId, { activeBlockId: foreignBlock.id }), error => error.code === "CROSS_DOCUMENT_STATE");
    assert.throws(() => core.exploration.saveState(root.chatId, { activeVersionId: second.document.activeVersionId }), error => error.code === "CROSS_DOCUMENT_STATE");
    assert.throws(() => core.exploration.saveState(root.chatId, { branchChoices: { [root.id]: foreignNode.id } }), error => error.code === "CROSS_CHAT_STATE");
    assert.throws(() => core.exploration.saveState(root.chatId, { branchChoices: { [branch.id]: root.id } }), error => error.code === "INVALID_BRANCH_STATE");
    assert.throws(() => core.exploration.saveState(root.chatId, { activeBlockId: oldBlock.id, textOffset: oldBlock.text.length + 1 }), error => error.code === "INVALID_TEXT_RANGE");
    const reparsed = await core.documents.reparse(first.document.id);
    assert.throws(() => core.exploration.saveState(root.chatId, { activeBlockId: oldBlock.id, activeVersionId: reparsed.document.activeVersionId }), error => error.code === "STATE_VERSION_MISMATCH");
    core.exploration.saveState(root.chatId, { activeNodeId: branch.id, activeBlockId: oldBlock.id, textOffset: 1, expandedNodes: [root.id], branchChoices: { [root.id]: branch.id } });
    assert.equal(core.exploration.getState(root.chatId).activeVersionId, first.document.activeVersionId);
    assert.equal(core.exploration.getState(root.chatId).activeBlockId, oldBlock.id);
  });
});

test("term explanations prioritize original definitions and cache AI output with disclosure", async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ message: { content: "Ranking 依据相关性给候选原文排序。这是 AI 生成的参考解释。" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await withCore(async core => {
      const result = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
      const sourceTerm = result.terms.find(term => term.canonicalText === "机器学习");
      assert.equal((await core.terms.explain(sourceTerm.id)).definitions[0].kind, "source");
      const missing = result.terms.find(term => term.canonicalText === "Ranking");
      await assert.rejects(core.terms.explain(missing.id), error => error.code === "AI_NOT_CONFIGURED");
      const address = server.address();
      core.settings.saveProvider({ provider: "ollama", baseUrl: `http://127.0.0.1:${address.port}`, model: "fixture-model" });
      const explained = await core.terms.explain(missing.id);
      assert.equal(explained.definitions[0].kind, "ai");
      assert.equal(explained.definitions[0].disclaimer, "AI 生成，仅供参考");
      assert.equal(explained.definitions[0].model, "fixture-model");
      assert.equal(explained.definitions[0].sourceBlockId, undefined);
      await core.terms.explain(missing.id);
      assert.equal(calls, 1);
      assert.equal(core.exploration.listNodes(result.document.id).length, 0);
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("section boundary edits replay on reparse while old source citations remain valid", async () => {
  await withCore(async (core, dir) => {
    const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
    const docId = imported.document.id;
    let all = flat(imported.tree.sections);
    const titleSection = all.find(section => section.title === "机器学习");
    const ranking = all.find(section => section.title === "Ranking");
    const network = all.find(section => section.title === "Neural Network");
    const source = core.exploration.createNode({ documentId: docId, title: "来源", anchor: { blockId: network.blocks[1].id } });
    assert.throws(() => core.sections.applyEdits(docId, [{ operation: "move", sectionId: titleSection.id, parentSectionId: network.id }]), /子孙/);
    assert.throws(() => core.sections.applyEdits(docId, [{ operation: "merge", sectionId: titleSection.id, targetSectionId: network.id }]), /子孙/);
    core.sections.applyEdits(docId, [{ operation: "rename", sectionId: titleSection.id, title: "我的学习路线" }, { operation: "split", sectionId: network.id, blockId: network.blocks[1].id, splitOffset: 0, newTitle: "网络定义" }, { operation: "move", sectionId: ranking.id, parentSectionId: titleSection.id, displayOrder: 10 }]);
    const current = core.documents.block(network.blocks[1].id);
    assert.equal(current.text, network.blocks[1].text, "split cannot modify source text");
    assert.notEqual(current.sectionId, network.id);
    const reparsed = await core.documents.reparse(docId);
    all = flat(reparsed.tree.sections);
    assert.ok(all.some(section => section.title === "我的学习路线"));
    assert.ok(all.some(section => section.title === "网络定义"));
    assert.notEqual(reparsed.document.activeVersionId, imported.document.activeVersionId);
    assert.equal(core.documents.block(network.blocks[1].id).documentVersionId, imported.document.activeVersionId);
    assert.equal(core.exploration.getNode(source.id).sources[0].locator.documentVersionId, imported.document.activeVersionId);
    const db = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM section_edits WHERE state='needs_review'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM section_edits").get().n, 3, "replay must not duplicate edit records");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.close();
  });
});

test("reparse exposes a review count when a manual edit cannot be mapped", async () => {
  await withCore(async (core, dir) => {
    const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
    const section = flat(imported.tree.sections).find(item => item.title === "Ranking");
    core.sections.applyEdits(imported.document.id, [{ operation: "rename", sectionId: section.id, title: "个人调整" }]);
    const db = new Database(join(dir, "db", "decklens.sqlite"));
    db.prepare("UPDATE section_edits SET source_keys_json=? WHERE document_id=?").run(JSON.stringify({ section: "missing-parser-key" }), imported.document.id);
    db.close();
    const reparsed = await core.documents.reparse(imported.document.id);
    assert.equal(reparsed.tree.sectionEditsNeedReview, 1);
    assert.equal(core.documents.tree(imported.document.id).sectionEditsNeedReview, 1);
  });
});

async function pptxFixture() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`);
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="256" r:id="r2"/><p:sldId id="257" r:id="r1"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="slide" Target="slides/slide1.xml"/><Relationship Id="r2" Type="slide" Target="slides/slide2.xml"/></Relationships>`);
  const slide = (title, extra = "") => `<p:sld xmlns:p="urn:p" xmlns:a="urn:a" xmlns:r="urn:r"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>${extra}</p:spTree></p:cSld></p:sld>`;
  zip.file("ppt/slides/slide2.xml", slide("First in presentation"));
  zip.file("ppt/slides/slide1.xml", slide("Second with image", `<p:pic><p:nvPicPr><p:cNvPr descr="synthetic pixel"/></p:nvPicPr><p:blipFill><a:blip r:embed="image1"/></p:blipFill></p:pic><p:sp><p:txBody><a:p><a:r><a:t>Text after image.</a:t></a:r></a:p></p:txBody></p:sp>`));
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/pixel.png"/><Relationship Id="notes1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide99.xml"/></Relationships>`);
  zip.file("ppt/notesSlides/notesSlide99.xml", `<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><p:sp><a:p><a:r><a:t>Native speaker note.</a:t></a:r></a:p></p:sp></p:notes>`);
  zip.file("ppt/media/pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("native PPTX honors OOXML order, standard rels, image ownership and notes relationship", async () => {
  await withCore(async (core, dir) => {
    const imported = await core.documents.importFile(await pptxFixture(), { originalName: "native.pptx" });
    const slides = imported.tree.sections[0].children;
    assert.equal(slides[0].title, "First in presentation");
    assert.equal(slides[1].title, "Second with image");
    assert.equal(slides[0].blocks.filter(block => block.type === "image").length, 0);
    const image = slides[1].blocks.find(block => block.type === "image");
    assert.ok(image);
    assert.equal(image.sourceLocator.slideNumber, 2);
    assert.deepEqual(slides[1].blocks.slice(0, 3).map(block => block.type), ["heading", "image", "paragraph"]);
    assert.equal(slides[1].blocks[2].text, "Text after image.");
    assert.ok(slides[1].blocks.some(block => block.type === "note" && block.text === "Native speaker note."));
    assert.ok(core.documents.blocks(imported.document.id).find(block => block.id === image.id).payload.asset.id);
    const buffer = core.documents.assetById(image.payload.asset.id);
    assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const db = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
    const asset = db.prepare("SELECT relative_path FROM assets WHERE asset_id=?").get(image.payload.asset.id);
    assert.match(asset.relative_path, /^assets\//);
    assert.deepEqual(await readFile(join(dir, ...asset.relative_path.split("/"))), buffer);
    db.close();
    const word = new JSZip(); word.file("word/document.xml", "<document/>"); word.file("[Content_Types].xml", "<Types/>");
    const docx = await word.generateAsync({ type: "nodebuffer" });
    await assert.rejects(core.documents.importFile(docx, { originalName: "renamed.pptx" }), /UNSUPPORTED_DOCX/);
    await assert.rejects(core.documents.importFile(docx, { originalName: "word.docx" }), /UNSUPPORTED_DOCX/);
    await assert.rejects(core.documents.importFile(Buffer.from("PKbroken"), { originalName: "broken.pptx" }), /CORRUPT_PPTX/);
  });
});

test("PPTX missing referenced slides or embedded images fails explicitly instead of reporting ready", async () => {
  await withCore(async (core, dir) => {
    const fixture = await pptxFixture();
    for (const [missingPath, expected] of [
      ["ppt/slides/slide2.xml", /CORRUPT_PPTX: 第 1 页引用的幻灯片文件缺失/],
      ["ppt/_rels/presentation.xml.rels", /CORRUPT_PPTX: 第 1 页缺少有效的幻灯片关系引用/],
      ["ppt/media/pixel.png", /CORRUPT_PPTX: 第 2 页引用的内嵌图片文件缺失/],
      ["ppt/slides/_rels/slide1.xml.rels", /CORRUPT_PPTX: 第 2 页的内嵌图片缺少有效关系引用/]
    ]) {
      const zip = await JSZip.loadAsync(fixture);
      zip.remove(missingPath);
      await assert.rejects(core.documents.importFile(await zip.generateAsync({ type: "nodebuffer" }), { originalName: "incomplete.pptx" }), expected);
      assert.deepEqual(core.documents.list(), [], "a damaged import must not become a ready document");
    }
    const db = new Database(join(dir, "db", "decklens.sqlite"), { readonly: true });
    const jobs = db.prepare("SELECT status,error_code FROM import_jobs").all();
    assert.equal(jobs.length, 4);
    assert.ok(jobs.every(job => job.status === "failed" && job.error_code === "CORRUPT_PPTX"));
    db.close();
    assert.equal((await core.documents.importFile(fixture, { originalName: "valid.pptx" })).document.status, "ready");
  });
});

test("unrelated questions fail closed and local data clears without clearing provider settings", async () => {
  await withCore(async core => {
    const imported = await core.documents.importFile(Buffer.from(markdown), { originalName: "learning.md" });
    await assert.rejects(core.chat.ask({ documentId: imported.document.id, question: "Explain Ranking" }), error => error.code === "MODEL_NOT_CONFIGURED");
    assert.equal(core.exploration.listNodes(imported.document.id).length, 0, "a missing model cannot create an AI node");
    const note = core.exploration.createNode({ documentId: imported.document.id, kind: "note", title: "Offline note" });
    core.exploration.updateNode(note.id, { answer: "Editable without a model." });
    assert.equal(core.exploration.getNode(note.id).kind, "note");
    assert.equal(core.exploration.getNode(note.id).messages.at(-1).content, "Editable without a model.");
    core.settings.saveProvider({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "local-model" });
    const answer = await core.chat.ask({ documentId: imported.document.id, question: "quasar flibbertigibbet" });
    assert.equal(answer.foundEvidence, false);
    assert.equal(answer.citations.length, 0);
    assert.match(answer.answer, /没有找到/);
    assert.throws(() => core.settings.saveProvider({ provider: "openai-compatible", baseUrl: "https://host/v1?key=do-not-store", model: "m" }), /不能包含/);
    core.settings.saveProvider({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "local-model" });
    await core.settings.clearData();
    assert.equal(core.documents.list().length, 0);
    assert.equal(core.settings.getPublic().model, "local-model");
    const next = await core.documents.importFile(Buffer.from("# Restored\n\nLocal works."), { originalName: "new.md" });
    assert.ok(next.document.id);
    await core.documents.delete(next.document.id);
    assert.equal(core.documents.list().length, 0);
  });
});
