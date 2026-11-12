// Run after `npm run build`. Preview uses a fresh temporary database, never user data.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createCore } from '../packages/core/dist/index.js';
import { openDatabase } from '../packages/core/dist/database.js';
import { createLearningArticleService } from '../packages/core/dist/learning-articles.js';
import { startServer } from '../apps/server/dist/index.js';

const dataDir = await mkdtemp(join(tmpdir(), 'decklens-screenshots-'));
const core = createCore(dataDir);
const source = `# 检索与分支探索

先在原文里找到依据，再沿着问题逐步深入。阅读、提问和回到出处，应当是一条连贯的路径。

## 先找结构，再找原文

### 层级检索

层级检索（Hierarchical Retrieval）是先定位相关章节，再检索章节内的段落。章节提供上下文，内容块提供精确的引用位置。

### 原文引用

原文引用把回答与文档中的具体内容块关联起来。点击来源，可以回到对应的行号、页码或幻灯片，检查回答是否符合原意。

## 沿着问题，保留不同思路

分支探索是从同一条回答延伸出多条独立路径。深入用于继续解释当前问题，关联用于寻找相邻概念，分支用于尝试另一种思路。

| 操作 | 适合解决的问题 |
| --- | --- |
| 深入 | 这个概念为什么成立？ |
| 关联 | 它和哪些知识有关？ |
| 分支 | 换一种方法会怎样？ |

## 用引用完成一次复核

1. 阅读原文，理解章节的上下文。
2. 围绕一个具体问题展开对话。
3. 点击回答中的来源，回到原文核对。
4. 从已有回答继续深入，或保留一条新的分支。

> 这份说明和预置对话仅用于展示界面，不是实际模型生成的回答。
`;
const { document } = await core.documents.importFile(Buffer.from(source), { originalName: '检索与分支探索.md' });
const library = core.folders.create('阅读笔记');
const topic = core.folders.create('检索与提问', library.id);
core.folders.moveDocument(document.id, topic.id);
const blocks = core.documents.blocks(document.id);
const retrieval = blocks.find(block => block.text.startsWith('层级检索（'));
const reference = blocks.find(block => block.text.startsWith('原文引用把'));
const branch = blocks.find(block => block.text.startsWith('分支探索是'));
if (!retrieval || !reference || !branch) throw new Error('Screenshot source blocks were not parsed.');
// Author article fixtures through the same persistence/validation path, without any model request.
const db = openDatabase(dataDir);
const fixtureProvider = { id: 'fixture', name: 'fixture', providerKind: 'ollama', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1', model: 'fixture', timeoutMs: 1000, supportsStreaming: false, supportsVision: false, hasApiKey: false, active: true, createdAt: '', updatedAt: '' };
const articleService = createLearningArticleService({
  db, getDocument: core.documents.get, getTree: core.documents.tree, getBlocks: id => core.documents.blocks(id),
  getActiveProvider: () => fixtureProvider,
  complete: async request => {
    const user = request.messages[1].content;
    const sources = JSON.parse(user.slice(user.indexOf('[{"id"')));
    if (sources[0]?.type === 'article-draft') return JSON.stringify({ paragraphs: [{ text: '先理解章节中的概念，再围绕问题展开追问，最后回到原文复核。这条阅读路径把知识结构、对话思路和可检查的出处连在一起。', sourceBlockIds: sources.slice(0, 3).map(item => item.id) }] });
    const paragraphs = sources.filter(item => item.type !== 'heading').map(item => ({ text: item.text, sourceBlockIds: [item.id] }));
    return JSON.stringify({ paragraphs: paragraphs.length ? paragraphs : sources.map(item => ({ text: item.text, sourceBlockIds: [item.id] })) });
  },
});
const article = await articleService.generate(document.id);
if (article.status !== 'ready') throw new Error(article.errorMessage);
db.close();
const chat = core.chat.create(document.id, '阅读路径 · 预置展示');
const first = core.exploration.createNode({
  documentId: document.id, chatId: chat.id, kind: 'qa',
  title: '为什么要先按章节检索？', question: '为什么要先按章节检索？',
  answer: '先确定相关章节，可以保留概念所在的上下文；再定位具体段落，便于把回答落到可检查的原文上。',
  anchor: { blockId: retrieval.id },
  citations: [{ blockId: retrieval.id, quote: retrieval.text }],
  context: { origin: 'local', screenshotFixture: true },
});
core.exploration.createNode({
  documentId: document.id, chatId: chat.id, parentNodeId: first.id, branchKind: 'branch', kind: 'qa',
  title: '怎样保留另一种思路？', question: '怎样保留另一种思路？',
  answer: '从同一条回答另开分支，分别保留不同的追问路径。切换路径后，可以继续沿着选中的思路阅读和提问。',
  anchor: { blockId: branch.id }, citations: [{ blockId: branch.id, quote: branch.text }],
  context: { origin: 'local', screenshotFixture: true },
});
core.exploration.createNode({
  documentId: document.id, chatId: chat.id, parentNodeId: first.id, branchKind: 'deepens', kind: 'qa',
  title: '如何检查回答有没有依据？', question: '如何检查回答有没有依据？',
  answer: '打开回答下方的原文引用，点击来源返回正文，再结合前后段落核对。引用保留行号、页码或幻灯片位置。',
  anchor: { blockId: reference.id }, citations: [{ blockId: reference.id, quote: reference.text }],
  context: { origin: 'local', screenshotFixture: true },
});
// Optional local response stub for exercising lasso/chat controls. It never leaves loopback.
let responseStub;
if (process.argv.includes('--test-model')) {
  responseStub = createServer(async (req, res) => {
    for await (const _ of req) { /* Consume the local fixture request. */ }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: '先按章节确定上下文，再定位具体段落。点击原文引用可以核对出处；也可以从当前回答继续深入或另开分支。[1]' } }));
  });
  await new Promise(resolve => responseStub.listen(0, '127.0.0.1', resolve));
  core.providers.save({ name: '本地交互测试', providerKind: 'ollama', protocol: 'ollama-chat', baseUrl: `http://127.0.0.1:${responseStub.address().port}`, model: 'local-fixture', timeoutMs: 3000, supportsStreaming: false, supportsVision: true, activate: true });
}
const instance = await startServer({ dataDir, core, port: 0 });
console.log(`Screenshot preview: http://127.0.0.1:${instance.port}`);
console.log(`Isolated temporary data: ${dataDir}`);
console.log('Document, article and conversations are authored presentation fixtures. No external model is called.');
async function stop() {
  await new Promise(resolve => instance.server.close(resolve));
  if (responseStub) await new Promise(resolve => responseStub.close(resolve));
  await core.storage.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
