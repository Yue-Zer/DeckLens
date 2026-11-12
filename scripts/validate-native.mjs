import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createCore } from '../packages/core/dist/index.js';
const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node scripts/validate-native.mjs <local PDF/DOCX paths...>');
const dir = await mkdtemp(join(tmpdir(), 'decklens-native-validation-'));
const core = createCore(dir);
const flatten = sections => sections.flatMap(s => [{ title: s.title, depth: s.depth, blocks: s.blocks.length, page: s.sourceLocator?.pageNumber }, ...flatten(s.children)]);
try {
  for (const file of files) {
    const started = Date.now();
    try {
      const result = await core.documents.importFile(file);
      const blocks = result.tree.sections.flatMap(function visit(section) { return [...section.blocks, ...section.children.flatMap(visit)]; });
      console.log(JSON.stringify({ name: basename(file), milliseconds: Date.now() - started, format: result.document.format, title: result.document.title,
        tree: flatten(result.tree.sections), counts: Object.fromEntries([...new Set(blocks.map(b => b.type))].map(type => [type, blocks.filter(b => b.type === type).length])), metadata: result.tree.metadata }, null, 2));
    } catch (error) { console.log(JSON.stringify({ name: basename(file), milliseconds: Date.now() - started, error: error.message }, null, 2)); }
  }
} finally { await core.storage.close(); await rm(dir, { recursive: true, force: true }); }
