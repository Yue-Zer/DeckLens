import { createHash, randomUUID } from "node:crypto";
import type { LearningArticle, LearningArticleFigure, LearningArticleParagraph, LearningArticleSection, ModelMessage, ProviderProfile } from "@decklens/contracts";
import type { SqliteDatabase } from "./sqlite.js";
import type { BlockRecord, DocumentRecord, DocumentTree, SectionRecord } from "./types.js";

type Row = Record<string, unknown>;
type SourceBlock = { id: string; sectionId: string; type: string; text: string; sourceOrder: number; locator: BlockRecord["sourceLocator"]; assetId?: string; mimeType?: string; caption: string; width?: number; height?: number; imageHash?: string };
type DraftParagraph = { text: string; sourceBlockIds: string[] };
type DraftSection = { sourceId?: string; sourceBlockIds?: string[]; id: string; parentId?: string; title: string; depth: number; order: number; paragraphs: DraftParagraph[]; children: DraftSection[]; figures?: Array<{ blockId: string; paragraphIndex: number }> };

const CHUNK_CHARS = 11_000;
const MERGE_CHARS = 9_000;

export function createLearningArticleService(dependencies: {
  db: SqliteDatabase;
  getDocument(documentId: string): DocumentRecord;
  getTree(documentId: string): DocumentTree;
  getBlocks(documentId: string): BlockRecord[];
  getActiveProvider(): ProviderProfile | null;
  complete(request: { profileId?: string; messages: ModelMessage[] }): Promise<string>;
}) {
  const { db } = dependencies;
  const sql = (statement: string) => db.prepare(statement);

  function sourceSnapshot(documentId: string) {
    const document = dependencies.getDocument(documentId);
    const tree = dependencies.getTree(documentId);
    const blocks = dependencies.getBlocks(documentId);
    const parts: SourceBlock[] = blocks.map(block => {
      const payload = block.payload ?? {};
      const asset = payload.asset && typeof payload.asset === "object" ? payload.asset as Record<string, unknown> : {};
      const assetId = stringValue(payload.assetId ?? asset.id);
      const caption = stringValue(payload.caption ?? payload.alt ?? block.text);
      const image = assetId ? sql('SELECT width,height,sha256 FROM assets WHERE asset_id=?').get(assetId) as Row | undefined : undefined;
      return {
        id: block.id, sectionId: block.sectionId, type: block.type,
        text: sourceText(block), sourceOrder: block.sourceOrder, locator: block.sourceLocator,
        assetId, mimeType: stringValue(asset.mimeType), caption,
        width: Number(payload.width ?? image?.width) || undefined, height: Number(payload.height ?? image?.height) || undefined, imageHash: stringValue(image?.sha256),
      };
    });
    const structureHash = createHash("sha256").update(JSON.stringify({
      articleAlgorithm: 4,
      versionId: tree.versionId,
      sections: flattenSections(tree.sections).map(section => [section.id, section.parentId ?? "", section.title, section.depth, section.displayOrder]),
      blocks: parts.map(block => [block.id, block.sectionId, block.sourceOrder, block.type, block.text, block.assetId ?? ""]),
    })).digest("hex");
    return { document, tree, blocks: parts, structureHash };
  }

  function get(documentId: string): LearningArticle | null {
    const snapshot = sourceSnapshot(documentId);
    const row = sql("SELECT * FROM learning_articles WHERE document_id=? AND version_id=?").get(documentId, snapshot.document.activeVersionId) as Row | undefined;
    return row ? mapArticle(db, row, snapshot.structureHash) : null;
  }

  async function generate(documentId: string, options: { force?: boolean; language?: string } = {}): Promise<LearningArticle> {
    const snapshot = sourceSnapshot(documentId);
    const { document, tree, blocks, structureHash } = snapshot;
    const existing = sql("SELECT * FROM learning_articles WHERE document_id=? AND version_id=?").get(documentId, tree.versionId) as Row | undefined;
    if (existing && existing.status === "generating") throw articleError("ARTICLE_GENERATION_IN_PROGRESS", "这份文档的学习文章正在生成，请稍后查看进度。");
    const language = cleanLanguage(options.language ?? "zh-CN");
    if (existing && existing.status === "ready" && existing.source_structure_hash === structureHash && existing.language === language && !options.force) return mapArticle(db, existing, structureHash);

    const articleId = String(existing?.article_id ?? randomUUID());
    const provider = dependencies.getActiveProvider();
    const timestamp = new Date().toISOString();
    sql(`INSERT INTO learning_articles(article_id,document_id,version_id,source_structure_hash,title,language,status,progress,progress_message,error_message,provider,model,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'generating',0,'正在准备全文结构',NULL,?,?,?,?)
      ON CONFLICT(document_id,version_id) DO UPDATE SET source_structure_hash=excluded.source_structure_hash,title=excluded.title,language=excluded.language,status='generating',progress=0,progress_message='正在准备全文结构',error_message=NULL,provider=excluded.provider,model=excluded.model,updated_at=excluded.updated_at`)
      .run(articleId, documentId, tree.versionId, structureHash, document.title, language, provider?.providerKind ?? null, provider?.model ?? null, existing?.created_at ?? timestamp, timestamp);

    try {
      if (!provider?.model || (!provider.hasApiKey && provider.protocol !== "ollama-chat")) {
        throw articleError("MODEL_NOT_CONFIGURED", "请先配置并启用模型，才能把整份课件整理成学习文章。原文阅读仍可继续使用。");
      }
      const outline = flattenSections(tree.sections);
      if (!blocks.some(block => block.text.trim())) throw articleError("ARTICLE_NO_TEXT", "文档没有可提取的文本，暂时无法生成学习文章。扫描件需要先识别文字。");
      const sourceBySection = new Map<string, SourceBlock[]>();
      for (const block of blocks) {
        const group = sourceBySection.get(block.sectionId) ?? [];
        group.push(block);
        sourceBySection.set(block.sectionId, group);
      }
      let completed = 0;
      const sourceRoots: DraftSection[] = [];
      const paged = document.format === "pdf" || document.format === "pptx";
      if (paged) {
        // A slide/page is a source unit, not an article chapter. Ask the model to
        // group contiguous units by topic before writing any prose.
        const ordered = [...blocks].sort((a, b) => a.sourceOrder - b.sourceOrder);
        const units = new Map<string, SourceBlock[]>();
        for (const block of ordered) {
          const number = block.locator.slideNumber ?? block.locator.pageNumber;
          const key = number ? `page_${number}` : `section_${block.sectionId}`;
          const unit = units.get(key) ?? [];
          unit.push(block); units.set(key, unit);
        }
        const entries = [...units.entries()];
        const planned: Array<{ title: string; ids: string[] }> = [];
        for (let offset = 0; offset < entries.length; offset += 30) {
          const batch = entries.slice(offset, offset + 30);
          const sourceData = batch.map(([id, items]) => ({ id, location: locationLabel(items[0].locator), text: items.map(item => item.text).filter(Boolean).join(" ").slice(0, 300) }));
          const response = await dependencies.complete({ profileId: provider.id, messages: [
            { role: "system", content: "你是课件文章的结构编辑。根据整组连续课件的主题，把相邻且内容相关的页面合并为少量知识章节，而不是每页一章。章节标题表达知识主题。中文输出时必须将英文标题翻译成简体中文，可在括号内保留英文术语。保持页面顺序，所有输入 id 必须恰好出现一次，不得省略、重复或编造。只返回 JSON：{\"sections\":[{\"title\":\"主题\",\"unitIds\":[\"page_1\",\"page_2\"]}]}。" },
            { role: "user", content: `输出语言：${language === "zh-CN" ? "简体中文" : language}\n课件：${document.title}\n页面概要：${JSON.stringify(sourceData)}` },
          ] });
          planned.push(...parseArticlePlan(response, batch.map(([id]) => id)));
          setProgress(5 + Math.floor(Math.min(entries.length, offset + 30) / Math.max(1, entries.length) * 15), "正在梳理跨页知识主题");
        }
        for (const [index, group] of planned.entries()) {
          const groupBlocks = group.ids.flatMap(id => units.get(id) ?? []).sort((a, b) => a.sourceOrder - b.sourceOrder);
          const narrativeBlocks = groupBlocks.filter(block => block.text.trim());
          const paragraphs = narrativeBlocks.length ? await summarizeSection(provider.id, provider.model, group.title, narrativeBlocks, language) : [];
          sourceRoots.push({ id: randomUUID(), sourceBlockIds: groupBlocks.map(block => block.id), title: group.title, depth: 0, order: index, paragraphs, children: [] });
          completed++;
          setProgress(Math.min(84, 20 + Math.floor(completed / Math.max(1, planned.length) * 64)), `正在撰写：${group.title}`);
        }
      } else {
        const countWithText = outline.filter(section => (sourceBySection.get(section.id) ?? []).some(block => block.text.trim())).length;
        const sectionDrafts = new Map<string, DraftSection>();
        for (const section of outline) {
          const ownBlocks = (sourceBySection.get(section.id) ?? []).sort((a, b) => a.sourceOrder - b.sourceOrder);
          const narrativeBlocks = ownBlocks.filter(block => block.text.trim());
          const paragraphs = narrativeBlocks.length ? await summarizeSection(provider.id, provider.model, section.title, narrativeBlocks, language) : [];
          sectionDrafts.set(section.id, { sourceId: section.id, id: section.id, parentId: section.parentId, title: section.title, depth: section.depth, order: section.displayOrder, paragraphs: compactParagraphs(paragraphs), children: [] });
          if (narrativeBlocks.length) completed += 1;
          setProgress(Math.min(84, 8 + Math.floor(completed / Math.max(1, countWithText) * 72)), `正在整理章节：${section.title}`);
        }
        for (const section of outline) {
          const current = sectionDrafts.get(section.id)!;
          const parent = section.parentId ? sectionDrafts.get(section.parentId) : undefined;
          if (parent) parent.children.push(current); else sourceRoots.push(current);
        }
      }
      const allNarrative = flattenDraftSections(sourceRoots).flatMap(section => section.paragraphs);
      const overviewParagraphs = allNarrative.length
        ? await summarizeDrafts(provider.id, provider.model, `整份课件《${document.title}》`, allNarrative, language, 3)
        : [];
      const allSourceIds = new Set(blocks.filter(block => block.text.trim()).map(block => block.id));
      const validatedOverview = validateDrafts(overviewParagraphs, allSourceIds).filter(item => item.text.trim());
      const overview: DraftSection = {
        id: randomUUID(), title: "全篇导读", depth: 0, order: -1,
        paragraphs: validatedOverview.length ? validatedOverview : allNarrative.slice(0, 3), children: [],
      };
      const draftTree = [overview, ...sourceRoots];
      let articleTitle = document.title;
      if (language === "zh-CN") {
        const titleEntries = [{ id: "article_title", title: articleTitle }, ...flattenDraftSections(sourceRoots).map((section, index) => ({ id: `section_${index}`, title: section.title }))];
        const needsTranslation = titleEntries.filter(entry => /[A-Za-z]{3,}/.test(entry.title));
        for (let offset = 0; offset < needsTranslation.length; offset += 40) {
          const batch = needsTranslation.slice(offset, offset + 40);
          const response = await dependencies.complete({ profileId: provider.id, messages: [
            { role: "system", content: '把学习文章的标题翻译为简体中文，保持原意，专业术语可在括号中保留英文；只输出 JSON：{"titles":[{"id":"输入ID","title":"中文标题"}]}。每个输入 ID 必须出现一次，不得增加内容。' },
            { role: "user", content: `待翻译标题：${JSON.stringify(batch)}` },
          ] });
          const translated = parseTranslatedTitles(response, batch.map(entry => entry.id));
          for (const item of translated) {
            if (item.id === "article_title") articleTitle = item.title;
            else { const section = flattenDraftSections(sourceRoots)[Number(item.id.slice("section_".length))]; if (section) section.title = item.title; }
          }
        }
      }
      const hasBlock = new Map(blocks.map(block => [block.id, block]));
      for (const section of flattenDraftSections(draftTree)) {
        section.paragraphs = section.paragraphs.map(paragraph => ({
          text: paragraph.text.trim().slice(0, 12000),
          sourceBlockIds: [...new Set(paragraph.sourceBlockIds)].filter(id => hasBlock.has(id)),
        })).filter(paragraph => paragraph.text && paragraph.sourceBlockIds.length);
      }

      // Images are optional evidence for a particular paragraph, not a page inventory.
      const usedImages = new Set<string>();
      for (const section of flattenDraftSections(sourceRoots)) {
        const candidates = figureCandidates(section, blocks).filter(block => !usedImages.has(block.imageHash || block.assetId!));
        section.figures = [];
        if (!candidates.length || !section.paragraphs.length) continue;
        setProgress(88, `正在为文章筛选相关配图：${section.title}`);
        for (let offset = 0; offset < candidates.length; offset += 20) {
          if (section.figures.length >= Math.min(3, section.paragraphs.length)) break;
          const batch = candidates.slice(offset, offset + 20);
          try {
            const input = { paragraphs: section.paragraphs.map((paragraph, index) => ({ index, ...paragraph })), images: batch.map(image => ({ id: image.id, caption: image.caption, width: image.width, height: image.height, context: nearbyText(image, blocks).map(block => ({ id: block.id, text: block.text.slice(0, 500) })) })) };
            const response = await dependencies.complete({ profileId: provider.id, messages: [
              { role: 'system', content: '你是学习文章配图编辑。仅选择直接解释某段文章中的概念、过程、数据或例子的原图，并将它放在对应段落之后。不能因为同一页或同一章节就选图；排除页眉页脚、校徽、装饰、广告、孤立单词、箭头和拆开的图形碎片。根据图注和附近原文判断；缺少可靠相关证据时不选图，允许全部不选。不要为凑图而添加内容，不生成新图片。只返回 JSON：{"figures":[{"imageBlockId":"输入图片ID","paragraphIndex":0,"reason":"图片具体解释本段的什么内容"}]}。每张图最多一次，每段最多一张，整个章节最多三张，reason 必须说明具体关联。' },
              { role: 'user', content: `文章配图候选：${JSON.stringify(input)}` },
            ] });
            const json = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
            const parsed = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1)) as Row;
            for (const value of Array.isArray(parsed.figures) ? parsed.figures : []) {
              const choice = value as Row;
              const image = batch.find(item => item.id === choice.imageBlockId);
              const index = typeof choice.paragraphIndex === 'number' ? choice.paragraphIndex : -1;
              const paragraph = section.paragraphs[index];
              if (!image || !Number.isInteger(index) || !paragraph || stringValue(choice.reason).trim().length < 8) continue;
              if (!nearbyText(image, blocks).some(block => paragraph.sourceBlockIds.includes(block.id))) continue;
              const key = image.imageHash || image.assetId!;
              if (usedImages.has(key) || section.figures.some(item => item.paragraphIndex === index) || section.figures.length >= Math.min(3, section.paragraphs.length)) continue;
              section.figures.push({ blockId: image.id, paragraphIndex: index });
              usedImages.add(key);
            }
          } catch { /* Optional illustration selection must never lose the article's text. */ }
        }
      }

      if (dependencies.getDocument(documentId).activeVersionId !== tree.versionId) {
        throw articleError("ARTICLE_SOURCE_CHANGED", "文档在生成期间重新解析了。请基于当前版本重新生成学习文章。");
      }
      setProgress(92, "正在保存文章结构、原文引用和课件配图");
      persistArticle(db, {
        articleId, documentId, versionId: tree.versionId, documentTitle: articleTitle,
        language, provider: provider.providerKind, model: provider.model, structureHash,
        draftTree, blocks,
      });
      setProgress(100, "学习文章已生成");
      sql("UPDATE learning_articles SET status='ready',progress=100,progress_message='学习文章已生成',error_message=NULL,updated_at=? WHERE article_id=?")
        .run(new Date().toISOString(), articleId);
      return get(documentId)!;
    } catch (error) {
      const message = error instanceof Error ? error.message : "学习文章生成失败。";
      sql("UPDATE learning_articles SET status='failed',progress=0,progress_message='学习文章生成失败',error_message=?,updated_at=? WHERE article_id=?")
        .run(message.slice(0, 2000), new Date().toISOString(), articleId);
      return get(documentId)!;
    }

    function setProgress(progress: number, message: string) {
      sql("UPDATE learning_articles SET progress=?,progress_message=?,updated_at=? WHERE article_id=?")
        .run(progress, message.slice(0, 300), new Date().toISOString(), articleId);
    }

    async function summarizeSection(profileId: string, model: string, title: string, source: SourceBlock[], targetLanguage: string): Promise<DraftParagraph[]> {
      const chunks = chunkBlocks(source);
      let drafts: DraftParagraph[] = [];
      for (const chunk of chunks) {
        const result = await completeJson(profileId, model, title, targetLanguage, chunk, 5);
        const validated = validateDrafts(result, new Set(chunk.map(item => item.id)));
        if (!validated.length) throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型未提供有效的原文引用，无法生成可靠的学习文章，请重试或更换模型。");
        drafts.push(...validated);
      }
      drafts = compactParagraphs(drafts);
      const allowed = new Set(source.map(item => item.id));
      const final = validateDrafts(drafts, allowed);
      if (!final.length) throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型未提供有效的原文引用，无法生成可靠的学习文章。");
      return final;
    }

    async function summarizeDrafts(profileId: string, model: string, title: string, input: DraftParagraph[], targetLanguage: string, targetCount: number): Promise<DraftParagraph[]> {
      let current = compactParagraphs(validateDrafts(input, new Set(input.flatMap(item => item.sourceBlockIds))));
      while (serializedLength(current) > MERGE_CHARS || current.length > 20) {
        const groups = groupDrafts(current, MERGE_CHARS);
        const reduced: DraftParagraph[] = [];
        for (const group of groups) {
          reduced.push(...await summarizeGroup(group, Math.min(3, targetCount)));
        }
        if (reduced.length >= current.length) break;
        current = compactParagraphs(reduced);
      }
      const final: DraftParagraph[] = [];
      for (const group of groupDrafts(current, MERGE_CHARS)) final.push(...await summarizeGroup(group, targetCount));
      return compactParagraphs(final.length ? final : current);

      async function summarizeGroup(group: DraftParagraph[], limit: number): Promise<DraftParagraph[]> {
        const refs = new Map<string, string[]>();
        const syntheticSources = group.map((item, index) => {
          const id = `draft_${String(index + 1).padStart(4, "0")}`;
          refs.set(id, item.sourceBlockIds);
          return { id, type: "article-draft", text: item.text, caption: "", locator: {} } as SourceBlock;
        });
        const result = await completeJson(profileId, model, title, targetLanguage, syntheticSources, limit);
        const valid = result.map(item => ({
          text: item.text,
          sourceBlockIds: [...new Set(item.sourceBlockIds.flatMap(id => refs.get(id) ?? []))],
        })).filter(item => item.text && item.sourceBlockIds.length);
        return valid.length ? valid : group;
      }
    }

    async function completeJson(profileId: string, model: string, title: string, targetLanguage: string, sources: SourceBlock[], targetCount: number): Promise<DraftParagraph[]> {
      const sourceData = sources.map(source => ({ id: source.id, type: source.type, location: locationLabel(source.locator), text: source.text.slice(0, CHUNK_CHARS) }));
      const messages: ModelMessage[] = [
        { role: "system", content: `你是学习文章编辑。把课件原文整理成连贯、便于理解的文章，不要写成逐页清单或零散笔记。保留作者原有脉络与章节关系，解释术语和因果关系只使用材料中有依据的信息，不增加材料外事实；信息不足时保留其边界。通过连贯的完整自然段讲清定义、原理和材料中的例子，必要时解释概念之间的联系；避免把幻灯片项目简单拼接。每段围绕一个完整观点，控制段落长度以方便阅读，并引用支撑它的来源块。只返回 JSON：{"paragraphs":[{"text":"...","sourceBlockIds":["原文块ID"]}]}。sourceBlockIds 必须逐字使用输入中的 ID；不能生成新 ID。最多 ${targetCount} 段，输出语言为 ${targetLanguage === "zh-CN" ? "简体中文：英文内容须翻译并用中文解释，专业术语可同时附英文原词" : targetLanguage}。当前供应商配置：${model}。` },
        { role: "user", content: `文章/章节：${title}\n原文块（按原始顺序）：\n${JSON.stringify(sourceData)}` },
      ];
      const response = await dependencies.complete({ profileId, messages });
      const paragraphs = parseParagraphJson(response);
      if (targetLanguage === "zh-CN" && paragraphs.some(item => /[A-Za-z]{20}/.test(item.text.replace(/[^A-Za-z]/g, "")) && !/[\u3400-\u9fff]/u.test(item.text))) {
        throw articleError("ARTICLE_LANGUAGE_MISMATCH", "模型未按要求生成中文内容，请重试或更换模型。");
      }
      return paragraphs;
    }
  }

  return { get, generate };
}

function sourceText(block: BlockRecord): string {
  if (block.text?.trim()) return block.text.trim();
  const payload = block.payload ?? {};
  if (Array.isArray(payload.items)) return payload.items.map(item => typeof item === "string" ? item : stringValue((item as Row)?.text)).filter(Boolean).join("；");
  if (Array.isArray(payload.paragraphs)) return payload.paragraphs.map(item => typeof item === "string" ? item : stringValue((item as Row)?.text)).filter(Boolean).join("\n");
  if (Array.isArray(payload.rows)) return (payload.rows as unknown[]).map(row => Array.isArray(row) ? row.map(cell => typeof cell === "string" ? cell : stringValue((cell as Row)?.text)).join(" | ") : "").filter(Boolean).join("\n");
  return stringValue(payload.caption ?? payload.alt ?? payload.note ?? payload.formula);
}

function chunkBlocks(blocks: SourceBlock[]): SourceBlock[][] {
  const chunks: SourceBlock[][] = [];
  let current: SourceBlock[] = [];
  let size = 0;
  for (const block of blocks) {
    const text = block.text;
    const pieces = text.length > CHUNK_CHARS ? splitText(text, CHUNK_CHARS) : [text];
    for (const piece of pieces) {
      const item = { ...block, text: piece };
      if (current.length && size + piece.length > CHUNK_CHARS) { chunks.push(current); current = []; size = 0; }
      current.push(item); size += piece.length;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function splitText(text: string, max: number): string[] {
  const result: string[] = [];
  for (let start = 0; start < text.length; start += max) result.push(text.slice(start, start + max));
  return result;
}

function parseTranslatedTitles(response: string, expected: string[]): Array<{ id: string; title: string }> {
  const trimmed = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: Row;
  try { parsed = JSON.parse(trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)) as Row; }
  catch { throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型返回的中文标题无法解析，请重试。"); }
  if (!Array.isArray(parsed.titles)) throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型未返回中文标题，请重试。");
  const titles = parsed.titles.map((item: unknown) => {
    const row = item && typeof item === "object" ? item as Row : {};
    return { id: stringValue(row.id), title: stringValue(row.title).trim().slice(0, 160) };
  });
  const ids = titles.map(item => item.id);
  if (titles.length !== expected.length || new Set(ids).size !== expected.length || expected.some(id => !ids.includes(id)) || titles.some(item => !item.title || (/[A-Za-z]{10}/.test(item.title.replace(/[^A-Za-z]/g, "")) && !/[\u3400-\u9fff]/u.test(item.title)))) {
    throw articleError("ARTICLE_LANGUAGE_MISMATCH", "模型未正确返回完整的中文标题，请重试或更换模型。");
  }
  return titles;
}

function parseArticlePlan(response: string, expected: string[]): Array<{ title: string; ids: string[] }> {
  const trimmed = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: Row;
  try { parsed = JSON.parse(trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)) as Row; }
  catch { throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型返回的主题结构无法解析，请重试或更换模型。"); }
  if (!Array.isArray(parsed.sections)) throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型没有返回文章主题结构，请重试或更换模型。");
  const groups = parsed.sections.map((item: unknown) => {
    const row = item && typeof item === "object" ? item as Row : {};
    return { title: stringValue(row.title).trim().slice(0, 160), ids: Array.isArray(row.unitIds) ? row.unitIds.filter((id): id is string => typeof id === "string") : [] };
  });
  const actual = groups.flatMap(group => group.ids);
  if (!groups.length || groups.some(group => !group.title || !group.ids.length) || actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型返回的主题没有按顺序完整覆盖课件，请重试或更换模型。");
  }
  return groups;
}

function parseParagraphJson(response: string): DraftParagraph[] {
  const trimmed = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型没有按要求返回文章结构化内容，请重新生成。");
  let parsed: Row;
  try { parsed = JSON.parse(trimmed.slice(start, end + 1)) as Row; }
  catch { throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型返回的文章结构无法解析，请重新生成。"); }
  if (!Array.isArray(parsed.paragraphs)) throw articleError("ARTICLE_INVALID_MODEL_RESPONSE", "模型返回内容缺少文章段落，请重新生成。");
  return parsed.paragraphs.map((item: unknown) => {
    const row = item && typeof item === "object" ? item as Row : {};
    return { text: stringValue(row.text), sourceBlockIds: Array.isArray(row.sourceBlockIds) ? row.sourceBlockIds.filter((id): id is string => typeof id === "string") : [] };
  }).filter(item => item.text.trim());
}

function validateDrafts(drafts: DraftParagraph[], allowed: Set<string>): DraftParagraph[] {
  return drafts.map(item => ({ text: item.text.trim(), sourceBlockIds: [...new Set(item.sourceBlockIds)].filter(id => allowed.has(id)) }))
    .filter(item => item.text && item.sourceBlockIds.length);
}

function compactParagraphs(drafts: DraftParagraph[]): DraftParagraph[] {
  const result: DraftParagraph[] = [];
  for (const item of drafts) {
    const text = item.text.trim();
    const ids = [...new Set(item.sourceBlockIds)];
    if (!text || !ids.length) continue;
    const previous = result.at(-1);
    if (previous && previous.text === text) previous.sourceBlockIds = [...new Set([...previous.sourceBlockIds, ...ids])];
    else result.push({ text: text.slice(0, 12000), sourceBlockIds: ids });
  }
  return result;
}

function groupDrafts(drafts: DraftParagraph[], maxChars: number): DraftParagraph[][] {
  const groups: DraftParagraph[][] = [];
  let group: DraftParagraph[] = [];
  let size = 0;
  for (const draft of drafts) {
    if (group.length && size + draft.text.length > maxChars) { groups.push(group); group = []; size = 0; }
    group.push(draft); size += draft.text.length;
  }
  if (group.length) groups.push(group);
  return groups;
}

function serializedLength(drafts: DraftParagraph[]) { return drafts.reduce((sum, item) => sum + item.text.length + item.sourceBlockIds.join("").length + 32, 0); }

function flattenSections(sections: SectionRecord[]): SectionRecord[] {
  const output: SectionRecord[] = [];
  const visit = (items: SectionRecord[]) => {
    for (const section of [...items].sort((a, b) => a.displayOrder - b.displayOrder || a.sourceOrder - b.sourceOrder)) {
      output.push(section);
      visit(section.children);
    }
  };
  visit(sections);
  return output;
}

function flattenDraftSections(sections: DraftSection[]): DraftSection[] {
  const output: DraftSection[] = [];
  const visit = (items: DraftSection[]) => { for (const section of items) { output.push(section); visit(section.children); } };
  visit(sections);
  return output;
}

function nearbyText(image: SourceBlock, blocks: SourceBlock[]) {
  const page = image.locator.slideNumber ?? image.locator.pageNumber;
  return blocks.filter(block => block.type !== 'image' && block.text.trim() && (page
    ? (block.locator.slideNumber ?? block.locator.pageNumber) === page
    : block.sectionId === image.sectionId && Math.abs(block.sourceOrder - image.sourceOrder) <= 4));
}
function figureCandidates(section: DraftSection, blocks: SourceBlock[]) {
  const images = blocks.filter(block => block.type === 'image' && block.assetId && block.mimeType);
  return images.filter(image => {
    if (!(section.sourceBlockIds ? section.sourceBlockIds.includes(image.id) : image.sectionId === section.sourceId)) return false;
    const caption = image.caption.trim();
    if (/logo|copyright|visit us|watermark|校徽|页眉|页脚|装饰|箭头|^arrow$/i.test(caption)) return false;
    const duplicates = images.filter(other => image.imageHash && other.imageHash === image.imageHash);
    if (new Set(duplicates.map(other => other.locator.pageNumber ?? other.locator.slideNumber ?? other.sectionId)).size >= 3) return false;
    const { width, height } = image;
    if (width && height && (Math.min(width, height) < 80 || width * height < 16000 || width / height > 6 || height / width > 6)) return false;
    const descriptive = caption.length >= 4 && !/^(?:image|picture|figure|diagram|示意图|图片|课件原图|图)[\s\d._-]*$/i.test(caption);
    if (!descriptive) {
      const page = image.locator.pageNumber ?? image.locator.slideNumber;
      const siblings = images.filter(other => page ? (other.locator.pageNumber ?? other.locator.slideNumber) === page : other.sectionId === image.sectionId);
      if (!width || !height || width * height < 60000 || siblings.length >= 4) return false;
      if (!nearbyText(image, blocks).some(block => /图\s*\d|示意图|流程图|结构图|figure\s*\d|diagram|chart|plot/i.test(block.text))) return false;
    }
    return true;
  });
}

function persistArticle(db: SqliteDatabase, input: {
  articleId: string; documentId: string; versionId: string; documentTitle: string; language: string;
  provider: string; model: string; structureHash: string; draftTree: DraftSection[]; blocks: SourceBlock[];
}) {
  const blocksById = new Map(input.blocks.map(block => [block.id, block]));
  const sectionIds = new Map<string, string>();
  const paragraphIds = new Map<string, string>();
  const allSections = flattenDraftSections(input.draftTree);
  for (const section of allSections) sectionIds.set(section.id, randomUUID());
  const createdAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare("DELETE FROM learning_article_sections WHERE article_id=?").run(input.articleId);
    const insertSection = db.prepare(`INSERT INTO learning_article_sections(article_section_id,article_id,version_id,source_section_id,parent_article_section_id,title,section_kind,depth,order_index)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const section of allSections) {
      const articleSectionId = sectionIds.get(section.id)!;
      const parentId = section.parentId ? sectionIds.get(section.parentId) : undefined;
      insertSection.run(articleSectionId, input.articleId, input.versionId, section.sourceId ?? null, parentId ?? null, section.title,
        section.order === -1 ? "overview" : "body", section.depth, section.order);
    }
    const insertParagraph = db.prepare("INSERT INTO learning_article_paragraphs(paragraph_id,article_section_id,paragraph_kind,order_index,paragraph_text) VALUES(?,?,?,?,?)");
    const insertSource = db.prepare("INSERT INTO learning_article_sources(source_id,paragraph_id,version_id,block_id,source_order,quote,locator_json) VALUES(?,?,?,?,?,?,?)");
    for (const section of allSections) {
      const articleSectionId = sectionIds.get(section.id)!;
      section.paragraphs.forEach((paragraph, order) => {
        if (!paragraph.sourceBlockIds.length) return;
        const paragraphId = randomUUID();
        paragraphIds.set(`${section.id}:${order}`, paragraphId);
        insertParagraph.run(paragraphId, articleSectionId, "body", order, paragraph.text);
        for (const blockId of paragraph.sourceBlockIds) {
          const source = blocksById.get(blockId);
          if (!source) continue;
          insertSource.run(randomUUID(), paragraphId, input.versionId, source.id, source.sourceOrder, source.text.slice(0, 320), JSON.stringify(source.locator));
        }
      });
    }
    const insertFigure = db.prepare(`INSERT INTO learning_article_figures(figure_id,article_section_id,version_id,block_id,asset_id,after_paragraph_id,source_order,caption)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (const section of allSections) {
      const articleSectionId = sectionIds.get(section.id)!;
      for (const selection of section.figures ?? []) {
        const figure = blocksById.get(selection.blockId)!;
        const paragraphId = paragraphIds.get(`${section.id}:${selection.paragraphIndex}`);
        if (!paragraphId) continue;
        insertFigure.run(randomUUID(), articleSectionId, input.versionId, figure.id, figure.assetId, paragraphId, figure.sourceOrder, figure.caption);
      }
    }
    db.prepare("UPDATE learning_articles SET title=?,language=?,source_structure_hash=?,provider=?,model=?,created_at=COALESCE(created_at,?) WHERE article_id=?")
      .run(input.documentTitle, input.language, input.structureHash, input.provider, input.model, createdAt, input.articleId);
  })();
}

function mapArticle(db: SqliteDatabase, row: Row, currentStructureHash: string): LearningArticle {
  const articleId = String(row.article_id);
  const sectionRows = db.prepare("SELECT * FROM learning_article_sections WHERE article_id=? ORDER BY order_index,article_section_id").all(articleId) as Row[];
  const paragraphs = new Map<string, LearningArticleParagraph[]>();
  const paragraphRows = db.prepare(`SELECT p.* FROM learning_article_paragraphs p JOIN learning_article_sections s ON s.article_section_id=p.article_section_id WHERE s.article_id=? ORDER BY s.order_index,p.order_index`).all(articleId) as Row[];
  for (const paragraph of paragraphRows) {
    const sourceRows = db.prepare("SELECT * FROM learning_article_sources WHERE paragraph_id=? ORDER BY source_order,source_id").all(paragraph.paragraph_id) as Row[];
    const id = String(paragraph.article_section_id);
    const list = paragraphs.get(id) ?? [];
    list.push({
      id: String(paragraph.paragraph_id), kind: paragraph.paragraph_kind as LearningArticleParagraph["kind"], order: Number(paragraph.order_index), text: String(paragraph.paragraph_text),
      sources: sourceRows.map(source => ({ blockId: String(source.block_id), quote: String(source.quote), sourceOrder: Number(source.source_order), locator: parseJson(source.locator_json) })),
    });
    paragraphs.set(id, list);
  }
  const figures = new Map<string, LearningArticleFigure[]>();
  const figureRows = db.prepare(`SELECT f.*,a.mime_type FROM learning_article_figures f JOIN learning_article_sections s ON s.article_section_id=f.article_section_id JOIN assets a ON a.asset_id=f.asset_id WHERE s.article_id=? ORDER BY f.source_order`).all(articleId) as Row[];
  for (const figure of figureRows) {
    const block = db.prepare("SELECT source_locator_json FROM blocks WHERE version_id=? AND block_id=?").get(figure.version_id, figure.block_id) as Row | undefined;
    const id = String(figure.article_section_id);
    const list = figures.get(id) ?? [];
    list.push({ id: String(figure.figure_id), assetId: String(figure.asset_id), blockId: String(figure.block_id), mimeType: String(figure.mime_type), caption: String(figure.caption ?? ""), sourceOrder: Number(figure.source_order), locator: parseJson(block?.source_locator_json), afterParagraphId: stringValue(figure.after_paragraph_id) || undefined });
    figures.set(id, list);
  }
  const sections = new Map<string, LearningArticleSection>();
  for (const section of sectionRows) sections.set(String(section.article_section_id), {
    id: String(section.article_section_id), sourceSectionId: stringValue(section.source_section_id) || undefined,
    parentId: stringValue(section.parent_article_section_id) || undefined, title: String(section.title), depth: Number(section.depth), order: Number(section.order_index),
    kind: section.section_kind as LearningArticleSection["kind"], paragraphs: paragraphs.get(String(section.article_section_id)) ?? [],
    figures: figures.get(String(section.article_section_id)) ?? [], children: [],
  });
  const roots: LearningArticleSection[] = [];
  for (const sectionRow of sectionRows) {
    const section = sections.get(String(sectionRow.article_section_id))!;
    const parent = section.parentId ? sections.get(section.parentId) : undefined;
    if (parent) parent.children.push(section); else roots.push(section);
  }
  const structureChanged = row.source_structure_hash !== currentStructureHash;
  return {
    id: articleId, revision: createHash('sha256').update(JSON.stringify({ paragraphs: paragraphRows.map(item => [item.paragraph_id, item.paragraph_text]), figures: figureRows.map(item => item.figure_id) })).digest('hex'), documentId: String(row.document_id), documentVersionId: String(row.version_id), title: String(row.title), language: String(row.language),
    status: structureChanged && row.status === "ready" ? "stale" : row.status as LearningArticle["status"], progress: Number(row.progress),
    progressMessage: stringValue(row.progress_message) || undefined, errorMessage: stringValue(row.error_message) || undefined,
    provider: stringValue(row.provider) || undefined, model: stringValue(row.model) || undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), sections: roots,
  };
}

function parseJson(value: unknown): any {
  if (typeof value !== "string") return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function cleanLanguage(value: string): string { return !value || value === "und" || value === "auto" || /^zh(?:-|$)/i.test(value) ? "zh-CN" : value.slice(0, 80); }
function locationLabel(locator: SourceBlock["locator"]): string {
  if (locator.slideNumber) return `幻灯片 ${locator.slideNumber}`;
  if (locator.pageNumber) return `第 ${locator.pageNumber} 页`;
  if (locator.headingPath?.length) return locator.headingPath.join(" / ");
  if (locator.lineStart) return `第 ${locator.lineStart} 行`;
  return "原文内容块";
}
function articleError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
