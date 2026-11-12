import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCore } from '../packages/core/src/index.ts'
import { openDatabase } from '../packages/core/src/database.ts'
import { createLearningArticleService } from '../packages/core/src/learning-articles.ts'
import { articleContentBlocks } from '../apps/web/src/article-content.ts'

test('article figures require paragraph relevance, filter fragments and remain optional on model failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decklens-figures-'))
  const core = createCore(dir)
  const db = openDatabase(dir)
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    const image = (caption: string, key: string) => `![${caption}](data:image/png;base64,${Buffer.concat([png, Buffer.from(key)]).toString('base64')})`
    const imported = await core.documents.importFile(Buffer.from([
      '# 检索流程', '层级检索先确定章节，再定位段落。图1解释这个流程。',
      image('层级检索流程示意图', 'relevant'), image('同一检索流程图副本', 'relevant'),
      image('页眉装饰', 'decoration'), image('检索方向图形碎片', 'tiny'),
      ...Array.from({ length: 7 }, (_, i) => `历史沿革的附加背景段落${i}。`),
      image('历史沿革时间轴', 'unrelated'),
    ].join('\n\n')), { originalName: '检索配图.md' })
    const id = imported.document.id
    const blocks = core.documents.blocks(id).map(block => block.type === 'image' ? { ...block, payload: { ...block.payload, width: block.text.includes('碎片') ? 30 : 640, height: 400 } } : block)
    const source = blocks.find(block => block.type === 'paragraph')!
    const findImage = (caption: string) => blocks.find(block => block.type === 'image' && block.text === caption)!
    const relevant = findImage('层级检索流程示意图')
    const duplicate = findImage('同一检索流程图副本')
    const unrelated = findImage('历史沿革时间轴')
    let strategy: 'select' | 'empty' | 'fail' = 'select'
    let candidateIds: string[] = []
    const service = createLearningArticleService({
      db, getDocument: core.documents.get, getTree: core.documents.tree, getBlocks: () => blocks,
      getActiveProvider: () => ({ id: 'mock', name: 'mock', providerKind: 'ollama', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1', model: 'mock', timeoutMs: 1000, supportsStreaming: false, supportsVision: false, hasApiKey: false, active: true, createdAt: '', updatedAt: '' }),
      complete: async request => {
        const user = request.messages[1].content as string
        if (user.startsWith('文章配图候选：')) {
          const input = JSON.parse(user.slice('文章配图候选：'.length))
          candidateIds = input.images.map((item: { id: string }) => item.id)
          if (strategy === 'fail') throw new Error('optional image selection failed')
          const reason = '此图解释本段先定位章节再寻找段落的检索过程'
          return JSON.stringify({ figures: strategy === 'empty' ? [] : [
            { imageBlockId: unrelated.id, paragraphIndex: 0, reason },
            { imageBlockId: 'invented', paragraphIndex: 0, reason },
            { imageBlockId: relevant.id, paragraphIndex: 999, reason },
            { imageBlockId: relevant.id, paragraphIndex: 0, reason },
            { imageBlockId: duplicate.id, paragraphIndex: 1, reason },
          ] })
        }
        const sources = JSON.parse(user.slice(user.indexOf('[{"id"'))) as Array<{ id: string }>
        const refs = sources.some(item => item.id === source.id) ? [source.id] : sources.map(item => item.id)
        return JSON.stringify({ paragraphs: [
          { text: '先定位章节，再检索其中的具体段落。', sourceBlockIds: refs },
          { text: '返回引用可以检查回答是否符合原意。', sourceBlockIds: refs },
        ] })
      },
    })
    const selected = await service.generate(id)
    assert.equal(selected.status, 'ready', selected.errorMessage)
    const flatten = (sections: typeof selected.sections): typeof selected.sections => sections.flatMap(section => [section, ...flatten(section.children)])
    const body = flatten(selected.sections).find(section => section.title === '检索流程')!
    assert.deepEqual(body.figures.map(figure => figure.blockId), [relevant.id])
    assert.equal(body.figures[0].afterParagraphId, body.paragraphs[0].id)
    const rendered = articleContentBlocks(selected)
    assert.equal(rendered[rendered.findIndex(block => block.id === body.paragraphs[0].id) + 1].id, body.figures[0].id)
    assert.ok(candidateIds.includes(unrelated.id), 'unrelated candidate must fail the paragraph-source check')
    assert.ok(!candidateIds.includes(findImage('页眉装饰').id))
    assert.ok(!candidateIds.includes(findImage('检索方向图形碎片').id))
    for (const next of ['empty', 'fail'] as const) {
      strategy = next
      const result = await service.generate(id, { force: true })
      assert.equal(result.status, 'ready', result.errorMessage)
      assert.ok(flatten(result.sections).find(section => section.title === '检索流程')!.paragraphs.length)
      assert.ok(flatten(result.sections).every(section => !section.figures.length))
    }
  } finally {
    db.close(); await core.storage.close(); await rm(dir, { recursive: true, force: true })
  }
})

test('learning articles retain hierarchy and real references across database connections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decklens-article-'))
  const core = createCore(dir)
  const db = openDatabase(dir)
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
    const imported = await core.documents.importFile(Buffer.from(`# 第一章\n\n基础知识。\n\n## 第二节\n\n深入内容。\n\n![示意图](data:image/png;base64,${png})\n`), { originalName: 'test.md' })
    const id = imported.document.id
    let invalid = false
    const service = createLearningArticleService({
      db, getDocument: core.documents.get, getTree: core.documents.tree,
      getBlocks: documentId => core.documents.blocks(documentId, { limit: 500 }),
      getActiveProvider: () => ({ id: 'mock', name: 'mock', providerKind: 'ollama', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1', model: 'mock', timeoutMs: 1000, supportsStreaming: false, supportsVision: false, hasApiKey: false, active: true, createdAt: '', updatedAt: '' }),
      complete: async request => {
        const user = request.messages[1].content as string
        const sources = JSON.parse(user.slice(user.indexOf('[{"id"'))) as Array<{ id: string; text: string }>
        return JSON.stringify({ paragraphs: [{ text: '整理后的学习内容。', sourceBlockIds: invalid ? ['unknown'] : sources.map(source => source.id) }] })
      },
    })
    const result = await service.generate(id)
    assert.equal(result.status, 'ready', result.errorMessage)
    assert.equal(result.sections[0].title, '全篇导读')
    const findSection = (items: typeof result.sections, title: string): typeof result.sections[number] | undefined => {
      for (const item of items) { if (item.title === title) return item; const child = findSection(item.children, title); if (child) return child }
      return undefined
    }
    const first = findSection(result.sections, '第一章')!
    assert.ok(first)
    assert.equal(first.children[0].title, '第二节')
    assert.equal(first.children[0].figures.length, 0, 'uncaptioned illustrations are not inserted automatically')
    const blockIds = new Set(core.documents.blocks(id, { limit: 500 }).map(block => block.id))
    for (const section of [result.sections[0], first, first.children[0]]) {
      for (const paragraph of section.paragraphs) assert.ok(paragraph.sources.every(source => blockIds.has(source.blockId)))
    }
    assert.deepEqual(service.get(id), result)
    invalid = true
    const failed = await service.generate(id, { force: true })
    assert.equal(failed.status, 'failed')
    assert.match(failed.errorMessage || '', /引用/)
  } finally {
    db.close()
    await core.storage.close()
    await rm(dir, { recursive: true, force: true })
  }
})


test('slide-like pages become a thematic article with traceable images and complete page planning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decklens-topics-'))
  const core = createCore(dir)
  const db = openDatabase(dir)
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
    const imported = await core.documents.importFile(Buffer.from(`# 第一页\n\n概念基础。\n\n# 第二页\n\n概念应用。\n\n![图](data:image/png;base64,${png})\n`), { originalName: 'synthetic.md' })
    const id = imported.document.id
    const tree = core.documents.tree(id)
    const originals = core.documents.blocks(id, { limit: 500 })
    const sections = tree.sections.flatMap(item => [item, ...(item.children ?? [])])
    const pageMap = new Map(sections.map((item, index) => [item.id, index + 1]))
    const blocks = originals.map(block => ({ ...block, sourceLocator: { ...block.sourceLocator, format: 'pdf' as const, pageNumber: pageMap.get(block.sectionId) ?? 1 } }))
    let invalidPlan = false
    const service = createLearningArticleService({
      db, getDocument: documentId => ({ ...core.documents.get(documentId), format: 'pdf' }), getTree: core.documents.tree,
      getBlocks: () => blocks,
      getActiveProvider: () => ({ id: 'mock', name: 'mock', providerKind: 'ollama', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1', model: 'mock', timeoutMs: 1000, supportsStreaming: false, supportsVision: false, hasApiKey: false, active: true, createdAt: '', updatedAt: '' }),
      complete: async request => {
        const user = request.messages[1].content as string
        if (user.includes('页面概要：')) {
          const units = JSON.parse(user.slice(user.indexOf('[{"id"'))) as Array<{ id: string }>
          return JSON.stringify({ sections: [{ title: '概念与应用', unitIds: invalidPlan ? units.slice(0, -1).map(unit => unit.id) : units.map(unit => unit.id) }] })
        }
        const sources = JSON.parse(user.slice(user.indexOf('[{"id"'))) as Array<{ id: string }>
        return JSON.stringify({ paragraphs: [{ text: '概念与应用的连贯说明。', sourceBlockIds: sources.map(source => source.id) }] })
      },
    })
    const result = await service.generate(id)
    assert.equal(result.status, 'ready', result.errorMessage)
    assert.equal(result.sections.length, 2)
    assert.equal(result.sections[1].title, '概念与应用')
    assert.equal(result.sections[1].kind, 'body')
    assert.ok(new Set(result.sections[1].paragraphs.flatMap(p => p.sources.map(s => s.locator.pageNumber))).size >= 2)
    assert.equal(result.sections[1].figures.length, 0, 'page membership alone is not evidence of image relevance')
    invalidPlan = true
    const failed = await service.generate(id, { force: true })
    assert.equal(failed.status, 'failed')
    assert.match(failed.errorMessage || '', /完整覆盖/)
  } finally {
    db.close()
    await core.storage.close()
    await rm(dir, { recursive: true, force: true })
  }
})


test('English source produces a Chinese article with translated headings and original citations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decklens-translation-'))
  const core = createCore(dir)
  const db = openDatabase(dir)
  try {
    const imported = await core.documents.importFile(Buffer.from('# Neural Networks\n\nNeural networks learn patterns from data.\n\n## Model Training\n\nTraining adjusts the model parameters.\n'), { originalName: 'lesson.md' })
    const id = imported.document.id
    let englishOnly = false
    let sawChinesePrompt = false
    const service = createLearningArticleService({
      db, getDocument: core.documents.get, getTree: core.documents.tree,
      getBlocks: documentId => core.documents.blocks(documentId, { limit: 500 }),
      getActiveProvider: () => ({ id: 'mock', name: 'mock', providerKind: 'ollama', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1', model: 'mock', timeoutMs: 1000, supportsStreaming: false, supportsVision: false, hasApiKey: false, active: true, createdAt: '', updatedAt: '' }),
      complete: async request => {
        const system = request.messages[0].content as string
        const user = request.messages[1].content as string
        if (user.startsWith('待翻译标题：')) {
          const titles = JSON.parse(user.slice(user.indexOf('[{"id"'))) as Array<{ id: string; title: string }>
          return JSON.stringify({ titles: titles.map(item => ({ id: item.id, title: item.title.includes('Training') ? '模型训练' : '神经网络' })) })
        }
        sawChinesePrompt ||= system.includes('英文内容须翻译并用中文解释')
        const sources = JSON.parse(user.slice(user.indexOf('[{"id"'))) as Array<{ id: string }>
        return JSON.stringify({ paragraphs: [{ text: englishOnly ? 'Neural networks learn patterns from data.' : '神经网络从数据中学习规律。', sourceBlockIds: sources.map(source => source.id) }] })
      },
    })
    const result = await service.generate(id)
    assert.equal(result.status, 'ready', result.errorMessage)
    assert.equal(result.language, 'zh-CN')
    assert.equal(result.title, '神经网络')
    assert.ok(sawChinesePrompt)
    const all = (items: typeof result.sections): typeof result.sections => items.flatMap(item => [item, ...all(item.children)])
    assert.ok(all(result.sections).some(section => section.title === '模型训练'))
    assert.ok(all(result.sections).some(section => section.paragraphs.some(paragraph => paragraph.sources.some(source => /Neural networks/.test(source.quote)))))
    englishOnly = true
    const failed = await service.generate(id, { force: true })
    assert.equal(failed.status, 'failed')
    assert.match(failed.errorMessage || '', /中文/)
  } finally {
    db.close()
    await core.storage.close()
    await rm(dir, { recursive: true, force: true })
  }
})
