import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';

test('basic reading works and persists without any model configuration', { timeout: 120_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decklens-reading-'));
  let instance = await startServer({ dataDir, port: 0 });
  let base = `http://127.0.0.1:${instance.port}`;
  async function call(path: string, method = 'GET') {
    const response = await fetch(base + path, { method, headers: { origin: base } });
    const body = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  async function wait(jobId: string) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const job = await call(`/api/imports/${jobId}`);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      assert.equal((await fetch(base + '/api/health')).status, 200, 'the reader service remains available while parsing');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Parsing did not finish within 60 seconds');
  }
  async function upload(files: Array<[string, string | Uint8Array]>) {
    const body = new FormData();
    for (const [name, content] of files) body.append('files', new Blob([content]), name);
    const response = await fetch(base + '/api/imports', { method: 'POST', headers: { origin: base }, body });
    assert.equal(response.status, 202);
    return wait((await response.json() as { jobId: string }).jobId);
  }
  async function close() {
    await new Promise<void>((resolveClose, reject) => instance.server.close(error => error ? reject(error) : resolveClose()));
    await instance.core.storage.close();
  }
  const source = '# 离线阅读\n\n重复句子应保留原位置。\n\n## 第二节\n\n重复句子应保留原位置。\n\n- 第一项\n- 第二项\n\n| 格式 | 内容 |\n| --- | --- |\n| TXT | 原文 |\n\n```js\nconst value = 1;\n```\n\n> 可追溯的引用。\n';
  let document: any;
  let activeVersion: string;
  try {
    await t.test('imports a mixed batch with specific errors and preserves Unicode file names', async () => {
      assert.equal((await call('/api/settings')).keyConfigured, false);
      const job = await upload([
        ['离线笔记.md', source],
        ['章节文本.txt', '第一章 本地阅读\n\n不需要配置模型即可阅读。\n\n第二章 来源\n\n每段保留行号。'],
        ['unsupported.pdf', '%PDF-1.7\nNative PDF support is pending.'],
      ]);
      assert.equal(job.status, 'completed', JSON.stringify(job));
      assert.equal(job.documents.length, 2);
      assert.equal(job.errors.length, 1);
      assert.match(job.errors[0].message, /PDF/);
      document = job.documents.find((item: any) => item.format === 'markdown');
      assert.equal(document.originalName, '离线笔记.md');
      assert.equal((await call('/api/documents')).length, 2);
      const plain = job.documents.find((item: any) => item.format === 'txt');
      assert.ok((await call(`/api/documents/${plain.id}/blocks`)).some((block: any) => block.text.includes('不需要配置模型')));
    });

    await t.test('returns a structured tree and every original occurrence exactly once', async () => {
      const tree = await call(`/api/documents/${document.id}/tree`);
      activeVersion = tree.versionId;
      assert.equal(tree.sections[0].children[0].title, '离线阅读');
      const blocks = await call(`/api/documents/${document.id}/blocks`);
      assert.equal(blocks.filter((block: any) => block.text === '重复句子应保留原位置。').length, 2);
      assert.equal(new Set(blocks.map((block: any) => block.id)).size, blocks.length);
      assert.deepEqual(blocks.map((block: any) => block.sourceOrder), [...blocks.map((block: any) => block.sourceOrder)].sort((a: number, b: number) => a - b));
      for (const type of ['heading', 'paragraph', 'list', 'table', 'code', 'note']) assert.ok(blocks.some((block: any) => block.type === type), `missing ${type}`);
      assert.ok(blocks.every((block: any) => block.sourceLocator.lineStart > 0 && block.sourceLocator.documentVersionId === tree.versionId));
    });

    await t.test('deduplicates renamed files and reparses into a new version', async () => {
      const duplicate = await upload([['renamed.md', source]]);
      assert.equal(duplicate.documents[0].id, document.id);
      assert.equal(duplicate.documents[0].duplicate, true);
      assert.equal((await call(`/api/documents/${document.id}/tree`)).versionId, activeVersion);
      const reparse = await wait((await call(`/api/documents/${document.id}/reparse`, 'POST')).jobId);
      assert.equal(reparse.status, 'completed');
      const tree = await call(`/api/documents/${document.id}/tree`);
      assert.notEqual(tree.versionId, activeVersion);
      activeVersion = tree.versionId;
      assert.equal((await call('/api/documents')).length, 2);
    });

    await t.test('paginates more than 500 blocks without repeating or interleaving chapters', async () => {
      const content = Array.from({ length: 260 }, (_, index) => `# Chapter ${index}\n\nBody ${index}.\n\n`).join('');
      const imported = await upload([['many-chapters.md', content]]);
      assert.equal(imported.status, 'completed');
      const id = imported.documents[0].id;
      const first = await call(`/api/documents/${id}/blocks?offset=0&limit=500`);
      const second = await call(`/api/documents/${id}/blocks?offset=500&limit=500`);
      const last = await call(`/api/documents/${id}/blocks?offset=1000&limit=500`);
      assert.equal(first.length, 500);
      assert.equal(second.length, 20);
      assert.equal(last.length, 0);
      const blocks = [...first, ...second];
      assert.equal(new Set(blocks.map(block => block.id)).size, 520);
      for (let index = 0; index < 260; index++) {
        assert.equal(blocks[index * 2].text, `Chapter ${index}`);
        assert.equal(blocks[index * 2 + 1].text, `Body ${index}.`);
      }
    });

    await t.test('keeps the previous readable version when a reparse fails', async () => {
      await writeFile(resolve(dataDir, document.sourceRelativePath), Buffer.from([0, 1, 2, 3]));
      const failed = await wait((await call(`/api/documents/${document.id}/reparse`, 'POST')).jobId);
      assert.equal(failed.status, 'failed');
      assert.ok(failed.error.message.length > 0);
      assert.equal((await call(`/api/documents/${document.id}/tree`)).versionId, activeVersion);
      assert.ok((await call(`/api/documents/${document.id}/blocks`)).some((block: any) => block.text === '离线阅读'));
    });

    await t.test('restores documents, sections and blocks after a clean service restart', async () => {
      await close();
      instance = await startServer({ dataDir, port: 0 });
      base = `http://127.0.0.1:${instance.port}`;
      assert.equal((await call('/api/documents')).length, 3);
      assert.equal((await call(`/api/documents/${document.id}/tree`)).versionId, activeVersion);
      assert.ok((await call(`/api/documents/${document.id}/blocks`)).length > 5);
      assert.equal((await call('/api/settings')).keyConfigured, false);
    });
  } finally {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
