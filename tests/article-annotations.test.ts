import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as httpServer } from 'node:http'
import test from 'node:test'
import { createCore } from '../packages/core/src/index.ts'
import { openDatabase } from '../packages/core/src/database.ts'
import { createLearningArticleService } from '../packages/core/src/learning-articles.ts'
import { startServer } from '../apps/server/src/index.ts'
import { articleContentBlocks } from '../apps/web/src/article-content.ts'

test('article ink and lasso persist independently, reject stale/foreign targets and ask with verified article context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decklens-article-ink-'))
  let core = createCore(dir)
  const db = openDatabase(dir)
  let modelPrompt = ''
  const model = httpServer(async (req, res) => {
    let data = ''; for await (const piece of req) data += piece
    modelPrompt = JSON.stringify(JSON.parse(data).messages)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ message: { content: '先按章节定位，再通过引用回到原文。[1]' } }))
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const endpoint = model.address() as { port: number }
  let instance: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const imported = await core.documents.importFile(Buffer.from('# 检索\n\n层级检索先定位章节，再检索具体内容。\n'), { originalName: '检索.md' })
    const id = imported.document.id
    const source = core.documents.blocks(id).find(block => block.type === 'paragraph')!
    const service = createLearningArticleService({ db, getDocument: doc => core.documents.get(doc), getTree: doc => core.documents.tree(doc),
      getBlocks: doc => core.documents.blocks(doc),
      getActiveProvider: () => ({ id: 'fixture', name: 'fixture', providerKind: 'ollama', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1', model: 'fixture', timeoutMs: 1000, supportsStreaming: false, supportsVision: false, hasApiKey: false, active: true, createdAt: '', updatedAt: '' }),
      complete: async request => {
        const text = request.messages[1].content as string
        const sources = JSON.parse(text.slice(text.indexOf('[{"id"'))) as Array<{ id: string }>
        return JSON.stringify({ paragraphs: [{ text: '文章中的层级检索解释：先理解章节，再回到具体段落核对。', sourceBlockIds: sources.map(item => item.id) }] })
      },
    })
    const article = await service.generate(id)
    assert.equal(article.status, 'ready', article.errorMessage)
    const target = articleContentBlocks(article).find(block => block.type === 'paragraph')!
    const scope = { surface: 'article' as const, articleRevision: article.revision }
    const geometry = { shape: 'path' as const, strokeRatio: 0.003, points: [{ x: 0.1, y: 0.3 }, { x: 0.8, y: 0.3 }] }
    const originalInk = core.annotations.create({ documentId: id, tool: 'pen', targets: [{ ...geometry, blockId: source.id }] })
    const articleInk = core.annotations.create({ documentId: id, ...scope, tool: 'pen', targets: [{ ...geometry, blockId: target.id }] })
    const highlighter = core.annotations.create({ documentId: id, ...scope, tool: 'highlighter', targets: [{ ...geometry, blockId: target.id }] })
    const lasso = core.annotations.create({ documentId: id, ...scope, tool: 'lasso', targets: [{ ...geometry, blockId: target.id, shape: 'polygon', points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.8 }, { x: 0.1, y: 0.8 }] }] })
    assert.equal(core.annotations.list(id).length, 1)
    assert.equal(core.annotations.list(id, scope).length, 3)
    assert.throws(() => core.annotations.create({ documentId: id, ...scope, articleRevision: 'retired', tool: 'pen', targets: [{ ...geometry, blockId: target.id }] }), /更新/)
    assert.throws(() => core.annotations.create({ documentId: id, ...scope, tool: 'pen', targets: [{ ...geometry, blockId: source.id }] }), /不属于/)
    const foreign = await core.documents.importFile(Buffer.from('# 别的文档\n\n不属于当前文章。'), { originalName: 'other.md' })
    assert.throws(() => core.annotations.create({ documentId: foreign.document.id, ...scope, tool: 'pen', targets: [{ ...geometry, blockId: target.id }] }), /更新/)
    await core.storage.close()
    core = createCore(dir)
    assert.deepEqual(core.annotations.list(id, scope).find(mark => mark.id === articleInk.id)?.targets, articleInk.targets)
    core.annotations.delete(highlighter.id)
    assert.equal(core.annotations.list(id, scope).length, 2)
    instance = await startServer({ dataDir: dir, core, port: 0 })
    const base = `http://127.0.0.1:${instance.port}`
    const response = await fetch(`${base}/api/documents/${id}/annotations?surface=article&articleRevision=${article.revision}`)
    assert.equal((await response.json()).length, 2)
    core.providers.save({ name: 'local test fixture', providerKind: 'ollama', protocol: 'ollama-chat', baseUrl: `http://127.0.0.1:${endpoint.port}`, model: 'fixture', timeoutMs: 3000, supportsStreaming: false, supportsVision: false, activate: true })
    const answer = await fetch(`${base}/api/ask`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ documentId: id, question: '解释这段', selectedText: '伪造内容不得进入请求', articleSelection: { revision: article.revision, targetIds: [target.id], annotationId: lasso.id } }) })
    assert.equal(answer.status, 200)
    const result = await answer.json()
    assert.ok(result.node.context.articleSelection.targetIds.includes(target.id))
    assert.ok(modelPrompt.includes('文章中的层级检索解释'))
    assert.ok(modelPrompt.includes(source.text))
    assert.ok(!modelPrompt.includes('伪造内容不得进入请求'))
    assert.ok(result.citations.every((item: { blockId: string }) => core.documents.blocks(id).some(block => block.id === item.blockId)))
    await service.generate(id, { force: true })
    const updated = core.learningArticles.get(id)!
    assert.notEqual(updated.revision, article.revision)
    assert.equal(core.annotations.list(id, { surface: 'article' }).length, 0)
    assert.equal(core.annotations.list(id)[0].id, originalInk.id)
    await assert.rejects(core.chat.ask({ documentId: id, question: '旧圈选', articleSelection: { revision: article.revision, targetIds: [target.id] } }), /更新/)
    const newTarget = articleContentBlocks(updated)[0]
    core.annotations.create({ documentId: id, surface: 'article', articleRevision: updated.revision, tool: 'pen', targets: [{ ...geometry, blockId: newTarget.id }] })
    const cleared = await fetch(`${base}/api/documents/${id}/annotations?surface=article&articleRevision=${updated.revision}`, { method: 'DELETE', headers: { origin: base } })
    assert.equal(cleared.status, 204)
    assert.equal(core.annotations.list(id, { surface: 'article' }).length, 0)
    assert.equal(core.annotations.list(id).length, 1)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  } finally {
    if (instance) await new Promise<void>(resolve => instance!.server.close(() => resolve()))
    await new Promise<void>(resolve => model.close(() => resolve()))
    db.close(); await core.storage.close(); await rm(dir, { recursive: true, force: true })
  }
})
