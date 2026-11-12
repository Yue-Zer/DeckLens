import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createMockServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';

const text = '# Retrieval notes\n\nRetrieval Augmented Generation is a method that uses retrieved source passages to ground an answer.\n\n## Evidence\n\nEvidence means an exact passage retained with its source location. Retrieval Augmented Generation uses Evidence.\n\n## Branches\n\nAn exploration branch inherits its ancestor questions and source passages.\n';

test('browser HTTP workflow, persistence and local security', { timeout: 120_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decklens-integration-'));
  let instance = await startServer({ dataDir, port: 0 });
  let base = `http://127.0.0.1:${instance.port}`;
  const mockRequests: Array<{ path: string; authorization?: string; body: any }> = [];
  const mock = createMockServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    mockRequests.push({ path: req.url || '', authorization: req.headers.authorization, body });
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/chat'
      ? { message: { role: 'assistant', content: 'Evidence is retained with its source location [1].' } }
      : { choices: [{ message: { content: 'Retrieval uses source passages [1].' } }] }));
  });
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = (mock.address() as { port: number }).port;

  async function call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => null);
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  async function upload(name: string, contents: string | Uint8Array) {
    const form = new FormData();
    form.append('files', new Blob([contents]), name);
    const response = await fetch(base + '/api/imports', { method: 'POST', headers: { origin: base }, body: form });
    assert.equal(response.status, 202);
    const job = await response.json() as { jobId: string };
    for (let i = 0; i < 800; i++) {
      const current = await call(`/api/imports/${job.jobId}`);
      if (['completed', 'failed', 'cancelled'].includes(current.status)) return current;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('import job timed out');
  }
  async function closeInstance() {
    await new Promise<void>((resolve, reject) => instance.server.close(error => error ? reject(error) : resolve()));
    await instance.core.storage.close();
  }

  let doc: any;
  let answer: any;
  let lassoAnnotation: any;
  let offlineNote: any;
  let chatId: string;
  try {
    await t.test('rejects untrusted browser requests and arbitrary filesystem access', async () => {
      assert.equal((await fetch(base + '/api/health')).status, 200);
      const capabilities = await call('/api/capabilities');
      assert.ok(capabilities.formats.includes('pdf'));
      assert.ok(capabilities.formats.includes('docx'));
      assert.equal((await fetch(base + '/api/health', { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
      const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(base + '/api/health', { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
        request.end();
      });
      assert.equal(rejectedHost, 403);
      assert.equal((await fetch(base + '/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await fetch(base + '/api/settings/provider', { method: 'PUT', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 400);
      assert.equal((await fetch(base + '/api/assets?path=../../config/secrets.json')).status, 404);
    });

    await t.test('imports native Markdown, preserves locations, and deduplicates by content', async () => {
      const job = await upload('retrieval.md', text);
      assert.equal(job.status, 'completed', JSON.stringify(job));
      doc = job.documents[0];
      assert.equal(doc.format, 'markdown');
      const tree = await call(`/api/documents/${doc.id}/tree`);
      assert.ok(tree.sections.length > 0);
      const blocks = await call(`/api/documents/${doc.id}/blocks?limit=500`);
      assert.ok(blocks.some((block: any) => block.text.includes('exact passage')));
      assert.ok(blocks.every((block: any) => block.sourceLocator.documentVersionId && block.sourceLocator.lineStart));
      const terms = await call(`/api/documents/${doc.id}/terms`);
      assert.ok(terms.some((term: any) => term.canonicalText === 'Retrieval Augmented Generation'));
      const duplicate = await upload('renamed.md', text);
      assert.equal(duplicate.documents[0].id, doc.id);
      assert.equal(duplicate.documents[0].duplicate, true);
      assert.equal((await call('/api/documents')).length, 1);
    });

    await t.test('keeps notes available offline and requires a configured model for AI exploration', async () => {
      const chats = await call(`/api/chats?documentId=${doc.id}`);
      chatId = chats[0].id;
      const blocks = await call(`/api/documents/${doc.id}/blocks?limit=500`);
      const sourceBlock = blocks.find((block: any) => block.text.includes('exact passage'));
      const deniedNode = await fetch(base + '/api/explore/nodes', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ documentId: doc.id, chatId, kind: 'qa', title: 'AI node without a model' }) });
      assert.equal(deniedNode.status, 409);
      offlineNote = await call('/api/explore/nodes', 'POST', { documentId: doc.id, chatId, kind: 'note', title: 'Offline reading note', sourceBlockId: sourceBlock.id, selectedText: 'exact passage' });
      await call(`/api/explore/nodes/${offlineNote.id}`, 'PATCH', { answer: 'This note is stored locally.' });
      const persistedNote = await call(`/api/explore/nodes/${offlineNote.id}`);
      assert.equal(persistedNote.kind, 'note');
      assert.ok(persistedNote.messages.some((message: any) => message.content === 'This note is stored locally.'));
      const offlineAsk = await fetch(base + '/api/ask', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ documentId: doc.id, chatId, question: 'What is Retrieval Augmented Generation?' }) });
      assert.equal(offlineAsk.status, 409);
      assert.equal((await offlineAsk.json()).error.code, 'MODEL_NOT_CONFIGURED');
      await call('/api/settings/provider', 'PUT', { provider: 'ollama', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'integration-local' });
      answer = await call('/api/ask', 'POST', { documentId: doc.id, chatId, question: 'What is Retrieval Augmented Generation?' });
      assert.equal(answer.foundEvidence, true);
      assert.ok(answer.answer.includes('Evidence is retained with its source location'), answer.answer);
      assert.ok(answer.citations.length > 0);
      lassoAnnotation = await call('/api/annotations', 'POST', {
        documentId: doc.id,
        tool: 'lasso',
        targets: [{ blockId: sourceBlock.id, shape: 'polygon', strokeRatio: 0.0025, points: [{ x: 0.04, y: 0.08 }, { x: 0.92, y: 0.08 }, { x: 0.92, y: 0.88 }, { x: 0.04, y: 0.88 }] }],
      });
      const storedAnnotations = await call(`/api/documents/${doc.id}/annotations`);
      assert.ok(storedAnnotations.some((item: any) => item.id === lassoAnnotation.id));
      await closeInstance();
      instance = await startServer({ dataDir, port: 0 });
      base = `http://127.0.0.1:${instance.port}`;
      const restoredTargets = await call(`/api/documents/${doc.id}/annotations`);
      assert.deepEqual(restoredTargets.find((item: any) => item.id === lassoAnnotation.id).targets[0].points,
        [{ x: 0.04, y: 0.08 }, { x: 0.92, y: 0.08 }, { x: 0.92, y: 0.88 }, { x: 0.04, y: 0.88 }]);
      const selectedText = sourceBlock.text;
      const selectedContext = `[${sourceBlock.sourceLocator.lineStart}] ${selectedText}`;
      const lassoAsk = await call('/api/ask', 'POST', {
        documentId: doc.id,
        chatId,
        question: '解释这个圈选段落',
        selectedText,
        anchor: { blockId: sourceBlock.id },
        context: { annotationId: lassoAnnotation.id, selectionBlockIds: [sourceBlock.id], selectionContext: selectedContext, interaction: 'lasso' },
      });
      assert.equal(lassoAsk.node.context.annotationId, lassoAnnotation.id);
      assert.deepEqual(lassoAsk.node.context.selectionBlockIds, [sourceBlock.id]);
      assert.ok(lassoAsk.node.sources.some((source: any) => source.role === 'anchor' && source.blockId === sourceBlock.id));
      const deep = await call('/api/ask', 'POST', { documentId: doc.id, chatId, parentNodeId: answer.node.id, branchKind: 'deepens', question: 'Explain Evidence' });
      const branch = await call('/api/ask', 'POST', { documentId: doc.id, chatId, parentNodeId: answer.node.id, branchKind: 'branch', question: 'Evidence in a different context' });
      assert.equal(deep.node.parentNodeId, answer.node.id);
      assert.equal(branch.node.parentNodeId, answer.node.id);
      await call('/api/explore/edges', 'POST', { chatId, fromNodeId: deep.node.id, toNodeId: branch.node.id, kind: 'related' });
      const graph = await call(`/api/explore/nodes?documentId=${doc.id}&chatId=${chatId}`);
      assert.equal(graph.nodes.length, 5, 'one local note and four AI nodes, including the lasso question');
      assert.ok(graph.edges.some((edge: any) => edge.kind === 'branch'));
      assert.ok(graph.edges.some((edge: any) => edge.kind === 'related'));
      const noEvidence = await call('/api/ask', 'POST', { documentId: doc.id, chatId, question: 'ZXQUNRELATED928337' });
      assert.equal(noEvidence.foundEvidence, false);
      assert.equal(noEvidence.citations.length, 0);
      assert.ok(noEvidence.answer.includes('没有找到'));
      const otherChat = await call('/api/chats', 'POST', { documentId: doc.id, title: 'Separate exploration' });
      const separate = await call('/api/ask', 'POST', { documentId: doc.id, chatId: otherChat.id, question: 'Explain Evidence' });
      assert.equal(separate.node.chatId, otherChat.id);
    });

    await t.test('reparses with manual sections intact and keeps old citations accessible', async () => {
      const tree = await call(`/api/documents/${doc.id}/tree`);
      const target = tree.sections[0].children[0];
      await call(`/api/documents/${doc.id}/sections`, 'PATCH', { edits: [{ operation: 'rename', sectionId: target.id, title: 'My retained chapter' }] });
      const job = await call(`/api/documents/${doc.id}/reparse`, 'POST');
      let current: any;
      for (let i = 0; i < 400; i++) {
        current = await call(`/api/imports/${job.jobId}`);
        if (['completed', 'failed'].includes(current.status)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(current.status, 'completed', JSON.stringify(current));
      const nextTree = await call(`/api/documents/${doc.id}/tree`);
      assert.ok(JSON.stringify(nextTree).includes('My retained chapter'));
      assert.notEqual(nextTree.versionId, tree.versionId);
      const oldBlock = await call(`/api/blocks/${answer.citations[0].blockId}`);
      assert.equal(oldBlock.id, answer.citations[0].blockId);
      assert.ok(oldBlock.text.length > 0);
    });

    await t.test('stores secrets only on disk and supports OpenAI-compatible and Ollama providers', async () => {
      const secret = 'test-only-' + randomUUID();
      await call('/api/settings/provider', 'PUT', { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'integration-model' });
      const rejected = await fetch(base + '/api/settings/secret', { method: 'PUT', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(rejected.status, 404, 'browser secret uploads are unavailable');
      assert.equal((await call('/api/settings')).keyConfigured, false);
      await mkdir(join(dataDir, 'config'), { recursive: true, mode: 0o700 });
      await writeFile(join(dataDir, 'config', 'secrets.json'), JSON.stringify({ apiKey: secret }), { mode: 0o600 });
      const settings = await call('/api/settings');
      assert.equal(settings.keyConfigured, true);
      assert.ok(!('apiKey' in settings), 'settings must not expose a secret field');
      assert.ok(!JSON.stringify(settings).includes(secret), 'settings must not expose the saved secret');
      assert.ok(JSON.parse(await readFile(join(dataDir, 'config', 'secrets.json'), 'utf8')).apiKey === secret, 'secret is retained only in its local config file');
      const result = await call('/api/ask', 'POST', { documentId: doc.id, chatId, question: 'Explain Evidence' });
      assert.ok(result.answer.includes('[1]'));
      assert.equal(mockRequests.at(-1)?.path, '/v1/chat/completions');
      assert.ok(mockRequests.at(-1)?.authorization === `Bearer ${secret}`, 'the backend authenticates model requests');
      const follow = await call('/api/ask', 'POST', { documentId: doc.id, chatId, parentNodeId: result.node.id, question: 'Explain Retrieval in more detail' });
      assert.equal(follow.node.parentNodeId, result.node.id);
      assert.ok(mockRequests.at(-1)!.body.messages.length >= 4, 'inherits ancestor messages');
      const databaseFiles = (await readdir(join(dataDir, 'db'))).filter(name => name === 'decklens.sqlite' || name.startsWith('decklens.sqlite-'));
      assert.ok(databaseFiles.includes('decklens.sqlite'), 'the actual database file is checked');
      assert.ok(databaseFiles.includes('decklens.sqlite-wal'), 'the active write-ahead log is checked');
      for (const name of databaseFiles) assert.ok(!(await readFile(join(dataDir, 'db', name))).includes(Buffer.from(secret)), `secret leaked into ${name}`);
      await call('/api/settings/secret', 'DELETE');
      assert.equal((await call('/api/settings')).keyConfigured, false);
      await call('/api/settings/provider', 'PUT', { provider: 'ollama', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'integration-local' });
      await call('/api/ask', 'POST', { documentId: doc.id, chatId, question: 'Explain Evidence' });
      assert.equal(mockRequests.at(-1)?.path, '/api/chat');
      assert.equal(mockRequests.at(-1)?.authorization, undefined);

      const profileKey = 'profile-only-' + randomUUID();
      const profile = await call('/api/providers', 'POST', {
        name: 'DeepSeek compatible test', providerKind: 'deepseek', protocol: 'openai-chat',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'deepseek-fixture', timeoutMs: 10000,
        supportsStreaming: true, supportsVision: false, apiKey: profileKey,
      });
      assert.equal(profile.hasApiKey, true);
      assert.ok(!('apiKey' in profile));
      assert.ok(!JSON.stringify(profile).includes(profileKey));
      const listed = await call('/api/providers');
      assert.ok(!JSON.stringify(listed).includes(profileKey));
      const updatedProfile = await call(`/api/providers/${profile.id}`, 'PUT', {
        name: 'DeepSeek compatible updated', providerKind: profile.providerKind, protocol: profile.protocol,
        baseUrl: profile.baseUrl, model: profile.model, timeoutMs: profile.timeoutMs,
        supportsStreaming: profile.supportsStreaming, supportsVision: profile.supportsVision,
      });
      assert.equal(updatedProfile.name, 'DeepSeek compatible updated');
      assert.equal(updatedProfile.hasApiKey, true, 'omitting a secret while editing preserves the local credential');
      const tested = await call(`/api/providers/${profile.id}/test`, 'POST', {});
      assert.equal(tested.ok, true);
      assert.equal(tested.model, 'deepseek-fixture');
      assert.equal(mockRequests.at(-1)?.authorization, `Bearer ${profileKey}`);
      await call(`/api/providers/${profile.id}/activate`, 'POST', {});
      const activeProfiles = await call('/api/providers');
      assert.equal(activeProfiles.activeId, profile.id);

      const streamed = await fetch(base + '/api/model/chat', {
        method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: profile.id, stream: true, messages: [{ role: 'user', content: 'stream test' }] }),
      });
      assert.equal(streamed.status, 200);
      const streamText = await streamed.text();
      assert.ok(streamText.includes('event: token'));
      assert.ok(streamText.includes('streamed'));
      assert.equal(mockRequests.at(-1)?.authorization, `Bearer ${profileKey}`);

      const removed = await fetch(`${base}/api/providers/${profile.id}`, { method: 'DELETE', headers: { origin: base } });
      assert.equal(removed.status, 204);
      assert.equal((await call('/api/providers')).profiles.some((item: any) => item.id === profile.id), false);
    });

    await t.test('rejects unsupported, corrupt and binary disguised documents with specific feedback', async () => {
      for (const [name, bytes, expected] of [
        ['file.pdf', '%PDF-1.7', /PDF/],
        ['bad.pptx', new Uint8Array([80, 75, 3, 4, 0, 1]), /PPTX|ZIP|损坏/],
        ['binary.txt', new Uint8Array([0, 1, 2, 3]), /文本|二进制|UTF/],
      ] as const) {
        const job = await upload(name, bytes);
        assert.equal(job.status, 'failed');
        assert.match(job.errors[0].message, expected);
      }
      assert.equal((await fetch(base + '/api/health')).status, 200);
    });

    await t.test('restores exploration state after service restart', async () => {
      await call(`/api/explore/state/${chatId}`, 'PUT', { activeNodeId: answer.node.id, expandedNodes: [answer.node.id] });
      await closeInstance();
      instance = await startServer({ dataDir, port: 0 });
      base = `http://127.0.0.1:${instance.port}`;
      const state = await call(`/api/explore/state/${chatId}`);
      assert.equal(state.activeNodeId, answer.node.id);
      assert.equal((await call(`/api/explore/nodes/${answer.node.id}`)).id, answer.node.id);
      const restoredGraph = await call(`/api/explore/nodes?documentId=${doc.id}&chatId=${chatId}`);
      assert.ok(restoredGraph.edges.some((edge: any) => edge.kind === 'branch'));
      const lassoNodes = restoredGraph.nodes.filter((node: any) => node.context?.annotationId === lassoAnnotation.id);
      assert.equal(lassoNodes.length, 1);
      assert.ok(lassoNodes[0].sources.some((source: any) => source.role === 'anchor' && source.blockId));
      assert.ok((await call(`/api/explore/nodes/${offlineNote.id}`)).messages.some((message: any) => message.content === 'This note is stored locally.'));
      assert.equal((await call('/api/documents')).length, 1);
    });

    await t.test('clears local document data independently of model settings', async () => {
      await call('/api/settings/clear-data', 'POST', { confirm: 'DELETE_LOCAL_DATA' });
      assert.equal((await call('/api/documents')).length, 0);
      assert.equal((await call('/api/settings')).model, 'integration-local');
      assert.equal((await readdir(join(dataDir, 'originals'))).length, 0);
    });
  } finally {
    await closeInstance();
    await new Promise<void>(resolve => mock.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
