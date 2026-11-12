import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCore } from '../packages/core/src/index.ts';

test('folder migration preserves documents and folder membership survives reparse and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decklens-folders-'));
  let core: ReturnType<typeof createCore> | undefined;
  try {
    core = createCore(dir);
    const imported = await core.documents.importFile(Buffer.from('# 测试\n\n保留原文。'), { originalName: '测试.md' });
    const id = imported.document.id;
    await core.storage.close();
    core = undefined;

    // Recreate the pre-folder schema on this isolated database, retaining existing documents.
    const oldDb = new DatabaseSync(join(dir, 'db', 'decklens.sqlite'));
    oldDb.exec('DROP TABLE file_folder_memberships; DROP TABLE file_folders; DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)');
    oldDb.close();
    core = createCore(dir);
    assert.equal(core.documents.tree(id).document.id, id);
    assert.deepEqual(core.folders.list().folders, []);
    const parent = core.folders.create('课程');
    const child = core.folders.create('章节', parent.id);
    assert.throws(() => core!.folders.create('课程'), /同名/);
    assert.throws(() => core!.folders.create('不存在的目录', 'missing'), /找不到/);
    assert.throws(() => core!.folders.moveDocument(id, 'missing'), /找不到/);
    core.folders.moveDocument(id, child.id);
    await core.documents.importFile(Buffer.from('# 测试\n\n保留原文。'), { originalName: '测试.md', forceReparse: true });
    await core.storage.close();
    core = createCore(dir);
    assert.deepEqual(core.folders.list().memberships, [{ documentId: id, folderId: child.id }]);
    assert.equal(core.documents.tree(id).document.id, id);
    core.folders.moveDocument(id, null);
    assert.deepEqual(core.folders.list().memberships, []);
  } finally {
    if (core) await core.storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
