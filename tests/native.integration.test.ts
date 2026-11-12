import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { pdfFixture, docxFixture } from './fixtures/native.mjs';
import { resolveSourceBlock } from '../apps/web/src/source-navigation.ts';

test('native formats use the Web import, progress, assets and source workflows', { timeout: 120_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'decklens-native-http-'));
  const instance = await startServer({ dataDir, port: 0 });
  const base = 'http://127.0.0.1:' + instance.port;
  async function call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, { method, headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.ok(response.ok, method + ' ' + path + ': ' + JSON.stringify(value));
    return value;
  }
  async function wait(jobId: string) {
    const deadline = Date.now() + 60_000;
    const snapshots: Array<{ status: string; progress: number; message: string }> = [];
    let previous = 0;
    while (Date.now() < deadline) {
      const job = await call('/api/imports/' + jobId);
      assert.ok(job.progress >= previous, 'progress must not go backwards');
      previous = job.progress;
      snapshots.push({ status: job.status, progress: job.progress, message: job.message });
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return { job, snapshots };
      const started = performance.now();
      assert.equal((await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) })).status, 200);
      assert.ok(performance.now() - started < 3000, 'HTTP remains responsive during native parsing');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('native import timed out');
  }
  async function upload(name: string, bytes: Uint8Array) {
    const form = new FormData();
    form.append('files', new Blob([bytes]), name);
    const response = await fetch(base + '/api/imports', { method: 'POST', headers: { origin: base }, body: form });
    assert.equal(response.status, 202);
    return wait((await response.json() as { jobId: string }).jobId);
  }
  const sections = (items: any[]): any[] => items.flatMap(item => [item, ...sections(item.children ?? [])]);
  const imported: Array<{ doc: any; bytes: Uint8Array }> = [];
  try {
    await t.test('imports a 101-page native PDF with outlines, page references and live progress', async () => {
      const bytes = await pdfFixture({ pages: 101 });
      const started = performance.now();
      const { job, snapshots } = await upload('native-101.pdf', bytes);
      assert.equal(job.status, 'completed', JSON.stringify(job));
      const doc = job.documents[0];
      imported.push({ doc, bytes });
      const tree = await call('/api/documents/' + doc.id + '/tree');
      assert.equal(tree.metadata.pageCount, 101);
      assert.equal(tree.metadata.headingSource, 'native-outline');
      const chapter = sections(tree.sections).find(item => item.title === 'Native PDF chapter');
      assert.equal(chapter.children[0].title, 'Native PDF subsection 2');
      const blocks = await call('/api/documents/' + doc.id + '/blocks?limit=500');
      assert.ok(blocks.every((block: any) => block.sourceLocator.pageNumber >= 1 && block.sourceLocator.pageNumber <= 101));
      assert.ok(blocks.some((block: any) => block.sourceLocator.pageNumber === 101));
      assert.ok(blocks.filter((block: any) => block.type === 'image').every((block: any) => block.payload.width > 0 && block.payload.height > 0), 'PDF media reserves its dimensions before loading');
      assert.ok(snapshots.some(snapshot => snapshot.progress > 2 && snapshot.progress < 99 && /PDF/.test(snapshot.message)), JSON.stringify(snapshots));
      t.diagnostic('101-page synthetic PDF: ' + Math.round(performance.now() - started) + ' ms; observed ' + snapshots.length + ' status snapshots');
    });

    await t.test('imports a 27-MiB DOCX with native headings, tables, lists, emphasis, notes and disk media', async () => {
      const bytes = await docxFixture({ large: true });
      assert.ok(bytes.length > 27 * 1024 * 1024);
      const started = performance.now();
      const { job } = await upload('large-native.docx', bytes);
      assert.equal(job.status, 'completed', JSON.stringify(job));
      const doc = job.documents[0];
      imported.push({ doc, bytes });
      const tree = await call('/api/documents/' + doc.id + '/tree');
      const chapter = sections(tree.sections).find(item => item.title === 'Native DOCX chapter');
      assert.equal(chapter.children[0].title, 'Native DOCX subsection');
      const blocks = await call('/api/documents/' + doc.id + '/blocks');
      assert.deepEqual(blocks.find((block: any) => block.type === 'table').payload.rows, [['Column A', 'Column B'], ['Value A', 'Value B']]);
      assert.deepEqual(blocks.filter((block: any) => block.type === 'list' && block.payload.ordered).map((block: any) => block.payload.start), [1, 2]);
      assert.ok(blocks.some((block: any) => block.type === 'list' && !block.payload.ordered));
      for (const style of ['bold', 'italic', 'code']) assert.ok(blocks.some((block: any) => block.payload.runs?.some((run: any) => run[style])));
      assert.ok(blocks.some((block: any) => block.type === 'note' && block.text === 'Locally retained footnote.'));
      const imageIndex = blocks.findIndex((block: any) => block.type === 'image');
      assert.equal(blocks[imageIndex - 1].text, 'Before image');
      assert.equal(blocks[imageIndex + 1].text, 'After image');
      const image = blocks[imageIndex];
      assert.ok(image.payload.assetId);
      assert.deepEqual([image.payload.width, image.payload.height], [3072, 3072]);
      assert.ok(!JSON.stringify(image.payload).includes('base64'));
      const response = await fetch(base + '/api/assets/' + image.payload.assetId);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/bmp');
      assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString(), 'BM');
      const file = join(dataDir, 'assets', doc.id, tree.versionId, image.id + '.bmp');
      assert.ok((await stat(file)).size > 27 * 1024 * 1024);
      t.diagnostic('27-MiB image DOCX: ' + Math.round(performance.now() - started) + ' ms including upload, parsing, asset fetch and assertions');
    });

    await t.test('both formats reuse deduplication, terms, lasso, exploration sources and manual reparse edits', async () => {
      for (const { doc, bytes } of imported) {
        const tree = await call('/api/documents/' + doc.id + '/tree');
        const blocks = await call('/api/documents/' + doc.id + '/blocks?limit=500');
        const paragraph = blocks.find((block: any) => block.text.startsWith('Evidence means'));
        const terms = await call('/api/documents/' + doc.id + '/terms');
        assert.ok(terms.some((term: any) => term.mentions.some((mention: any) => mention.blockId === paragraph.id)));
        const annotation = await call('/api/annotations', 'POST', { documentId: doc.id, tool: 'lasso', targets: [{ blockId: paragraph.id, shape: 'polygon', strokeRatio: .002, points: [{ x: .05, y: .1 }, { x: .95, y: .1 }, { x: .95, y: .9 }, { x: .05, y: .9 }] }] });
        assert.ok((await call('/api/documents/' + doc.id + '/annotations')).some((item: any) => item.id === annotation.id));
        const chat = (await call('/api/chats?documentId=' + doc.id))[0];
        const node = await call('/api/explore/nodes', 'POST', { documentId: doc.id, chatId: chat.id, kind: 'note', title: 'Native source note', sourceBlockId: paragraph.id, selectedText: paragraph.text });
        const source = node.sources.find((value: any) => value.blockId === paragraph.id);
        assert.equal(source.locator.format, doc.format);
        if (doc.format === 'pdf') assert.equal(source.locator.pageNumber, 1);
        assert.equal((await call('/api/blocks/' + source.blockId)).id, paragraph.id);
        const duplicate = await upload('renamed.' + doc.format, bytes);
        assert.equal(duplicate.job.documents[0].id, doc.id);
        assert.equal(duplicate.job.documents[0].duplicate, true);
        const chapter = sections(tree.sections).find(item => item.depth === 1);
        await call('/api/documents/' + doc.id + '/sections', 'PATCH', { edits: [{ operation: 'rename', sectionId: chapter.id, title: 'Retained ' + doc.format + ' chapter' }] });
        const reparse = await wait((await call('/api/documents/' + doc.id + '/reparse', 'POST')).jobId);
        assert.equal(reparse.job.status, 'completed', JSON.stringify(reparse.job));
        const nextTree = await call('/api/documents/' + doc.id + '/tree');
        assert.notEqual(nextTree.versionId, tree.versionId);
        assert.ok(sections(nextTree.sections).some(item => item.title === 'Retained ' + doc.format + ' chapter'));
        assert.equal((await call('/api/blocks/' + source.blockId)).sourceLocator.documentVersionId, tree.versionId);
        const nextBlocks = await call('/api/documents/' + doc.id + '/blocks?limit=500');
        const currentSource = resolveSourceBlock(await call('/api/blocks/' + source.blockId), nextBlocks);
        assert.ok(currentSource, 'unchanged historical citations resolve to the same source in the active version');
        assert.notEqual(currentSource.id, paragraph.id);
        assert.equal(currentSource.sourceLocator?.pageNumber, paragraph.sourceLocator.pageNumber);
        const activeAnnotations = await call('/api/documents/' + doc.id + '/annotations');
        assert.ok(!activeAnnotations.some((item: any) => item.id === annotation.id), 'annotations remain version-bound');
        const freshAnnotation = await call('/api/annotations', 'POST', { documentId: doc.id, tool: 'pen', targets: [{ blockId: currentSource.id, shape: 'path', strokeRatio: .002, points: [{ x: .1, y: .2 }, { x: .8, y: .2 }] }] });
        assert.equal(freshAnnotation.versionId, nextTree.versionId);
      }
    });

    await t.test('scan and password failures are explicit, do not create documents, and leave the server usable', async () => {
      for (const [name, bytes, message] of [
        ['scan.pdf', await pdfFixture({ scan: true, outline: false }), /SCANNED_PDF.*这是扫描件，当前版本未启用 OCR/],
        ['encrypted.pdf', await pdfFixture({ encrypted: true }), /ENCRYPTED_PDF.*需要密码/],
        ['encrypted.docx', Buffer.from('d0cf11e0a1b11ae1', 'hex'), /ENCRYPTED_OR_LEGACY_OFFICE/],
      ] as const) {
        const { job } = await upload(name, bytes);
        assert.equal(job.status, 'failed');
        assert.match(job.errors[0].message, message);
      }
      assert.equal((await call('/api/documents')).length, 2);
    });
  } finally {
    await new Promise<void>((resolve, reject) => instance.server.close(error => error ? reject(error) : resolve()));
    await instance.core.storage.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
