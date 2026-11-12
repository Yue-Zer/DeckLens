import { createHash } from "node:crypto";
import { extname, posix } from "node:path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { parsePdf } from "./parsers/pdf.js";
import { parseDocx } from "./parsers/docx.js";
import type { BlockType, DocumentFormat, SourceLocator } from "./types.js";

export interface ParsedBlock {
  sourceBlockKey: string;
  sourceOrder: number;
  sourceKeyAliases?: string[];
  type: BlockType;
  text: string;
  payload: Record<string, unknown>;
  sourceLocator: Omit<SourceLocator, "documentVersionId" | "sectionId" | "blockId">;
  asset?: { bytes: Buffer; extension: string; mimeType: string };
}

export interface ParsedSection {
  sourceSectionKey: string;
  parentKey?: string;
  title: string;
  depth: number;
  sourceOrder: number;
  sourceLocator: Record<string, unknown>;
  blocks: ParsedBlock[];
}

export interface ParsedDocument {
  format: DocumentFormat;
  title: string;
  language: string;
  sections: ParsedSection[];
  metadata?: Record<string, unknown>;
}

export interface InputFile {
  bytes: Buffer;
  originalName: string;
}

export interface ParseProgress { progress: number; message: string }
export type ProgressCallback = (event: ParseProgress) => void;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: false,
  processEntities: false
});
const orderedXml = new XMLParser({ ignoreAttributes: false, preserveOrder: true, processEntities: false, parseTagValue: false, trimValues: false });

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function detectFormat(bytes: Buffer, originalName: string): DocumentFormat {
  const extension = extname(originalName).toLowerCase();
  if (bytes.length === 0) throw new Error("EMPTY_FILE: 文件为空。");
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (bytes.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1") throw new Error("ENCRYPTED_OR_LEGACY_OFFICE: 检测到加密 Office 或旧版二进制 Office 文档；请另存为未加密的 PDF、DOCX 或 PPTX 后导入。");
  if (bytes.length >= 4 && bytes.subarray(0, 2).toString("hex") === "504b") {
    if (bytes.includes(Buffer.from("word/document.xml")) || extension === ".docx") return "docx";
    // The ZIP filename is only a candidate. parsePptx verifies its content types and native parts.
    if (bytes.includes(Buffer.from("ppt/presentation.xml")) || extension === ".pptx") return "pptx";
    throw new Error("UNSUPPORTED_ARCHIVE: ZIP 文件不是支持的 PPTX 文档。");
  }
  // Markdown and TXT have no unique magic signature: validate bytes before consulting the extension.
  decodeText(bytes);
  if ([".md", ".markdown", ".mdown"].includes(extension)) return "markdown";
  if ([".txt", ".text"].includes(extension)) return "txt";
  throw new Error("UNSUPPORTED_FORMAT: 支持 PDF、DOCX、PPTX、Markdown 和 TXT 文件。");
}

export async function parseDocument(file: InputFile, format: DocumentFormat, sourceHash: string, onProgress?: ProgressCallback): Promise<ParsedDocument> {
  if (format === "pptx") return normalizeParsedDocument(await parsePptx(file.bytes, sourceHash));
  if (format === "pdf") return normalizeParsedDocument(await parsePdf(file.bytes, sourceHash, onProgress));
  if (format === "docx") return normalizeParsedDocument(await parseDocx(file.bytes, sourceHash, onProgress));
  const text = decodeText(file.bytes);
  return normalizeParsedDocument(format === "markdown" ? parseMarkdown(text, sourceHash) : parseTxt(text, sourceHash));
}

/** A native source location identifies an occurrence, never the text it contains. */
export function sourcePositionKey(block: Pick<ParsedBlock, "sourceBlockKey" | "sourceLocator">): string {
  const locator = block.sourceLocator;
  if (locator.elementPath) return `${locator.format}:${locator.elementPath}`;
  if (locator.lineStart !== undefined) return `${locator.format}:lines:${locator.lineStart}-${locator.lineEnd ?? locator.lineStart}`;
  if (locator.slideNumber !== undefined) return `${locator.format}:slide:${locator.slideNumber}:${locator.paragraphIndex ?? block.sourceBlockKey}`;
  return block.sourceBlockKey;
}

/** Validate/deduplicate parser output before any document rows or images are written. */
export function normalizeParsedDocument(parsed: ParsedDocument): ParsedDocument {
  const byKey = new Map<string, { block: ParsedBlock; position: string; fingerprint: string }>();
  const byPosition = new Map<string, { block: ParsedBlock; position: string; fingerprint: string }>();
  const accepted: ParsedBlock[] = [];
  const retained = new Set<ParsedBlock>();
  for (const section of parsed.sections) {
    const sectionBlocks: ParsedBlock[] = [];
    for (const block of section.blocks) {
      if (!block.sourceBlockKey || !Number.isSafeInteger(block.sourceOrder) || block.sourceOrder < 0) throw new Error("INVALID_SOURCE_POSITION: 解析器返回了无效的来源标识或原文顺序。");
      const position = sourcePositionKey(block);
      const fingerprint = canonicalJson({ type: block.type, text: block.text, payload: block.payload,
        asset: block.asset ? { sha256: sha256(block.asset.bytes), extension: block.asset.extension, mimeType: block.asset.mimeType } : undefined });
      const keyMatch = byKey.get(block.sourceBlockKey);
      if (keyMatch && (keyMatch.fingerprint !== fingerprint || keyMatch.position !== position)) throw new Error(`SOURCE_KEY_CONFLICT: 同一来源标识产生了不同内容或位置（${block.sourceBlockKey}）。`);
      const positionMatch = byPosition.get(position);
      if (positionMatch && positionMatch.fingerprint !== fingerprint) throw new Error(`SOURCE_POSITION_CONFLICT: 同一原文位置产生了不同内容（${position}）。`);
      const duplicate = keyMatch ?? positionMatch;
      if (duplicate) {
        // Retain all old parser aliases so stored manual edits can still replay.
        duplicate.block.sourceKeyAliases = [...new Set([...(duplicate.block.sourceKeyAliases ?? []), block.sourceBlockKey, ...(block.sourceKeyAliases ?? [])])];
        byKey.set(block.sourceBlockKey, duplicate);
        continue;
      }
      const record = { block, position, fingerprint };
      byKey.set(block.sourceBlockKey, record); byPosition.set(position, record);
      sectionBlocks.push(block); accepted.push(block); retained.add(block);
    }
    section.blocks = sectionBlocks;
  }
  accepted.sort((a, b) => a.sourceOrder - b.sourceOrder || sourcePositionKey(a).localeCompare(sourcePositionKey(b)) || a.sourceBlockKey.localeCompare(b.sourceBlockKey));
  accepted.forEach((block, index) => { block.sourceOrder = index; });
  for (const section of parsed.sections) section.blocks = section.blocks.filter(block => retained.has(block)).sort((a, b) => a.sourceOrder - b.sourceOrder);
  return parsed;
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}

function decodeText(bytes: Buffer): string {
  let text: string;
  try {
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
      if (bytes.length % 2 !== 0) throw new Error("odd UTF16 byte count");
      text = new TextDecoder(bytes[0] === 0xff ? "utf-16le" : "utf-16be", { fatal: true }).decode(bytes.subarray(2));
    } else {
      if (bytes.includes(0)) throw new Error("binary NUL");
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  } catch { throw new Error("INVALID_TEXT_ENCODING: 文件不是有效的 UTF-8/带 BOM 的 UTF-16 文本，或其内容为二进制文件。"); }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
    throw new Error("BINARY_TEXT_FILE: 文件包含二进制控制字符，不能作为 Markdown/TXT 解析。");
  }
  return text.replace(/^\uFEFF/, "");
}

function markdownHeading(lines: string[], index: number): { depth: number; title: string; lineCount: number } | undefined {
  const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.+?)|[ \t]*)$/.exec(lines[index]);
  if (atx && atx[2]) return { depth: atx[1].length, title: atx[2].replace(/[ \t]+#+[ \t]*$/, "").trim(), lineCount: 1 };
  if (lines[index].trim() && index + 1 < lines.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[index + 1])) {
    return { depth: lines[index + 1].trim().startsWith("=") ? 1 : 2, title: lines[index].trim(), lineCount: 2 };
  }
  return undefined;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  if (!lines[index]?.includes("|") || index + 1 >= lines.length) return false;
  const delimiter = lines[index + 1].trim().replace(/^\|/, "").replace(/\|$/, "");
  return delimiter.split("|").every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function markdownStandaloneImage(line: string): { alt: string; target: string } | undefined {
  const match = /^\s*!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)\s*$/.exec(line);
  return match ? { alt: match[1], target: match[2].replace(/^<|>$/g, "") } : undefined;
}

function extractMarkdownImage(target: string): { asset?: ParsedBlock["asset"]; reason?: string; message?: string } {
  if (!target.startsWith("data:")) return { reason: "IMAGE_EXTERNAL_OR_LOCAL_BLOCKED", message: "为保护本机文件和隐私，本版不自动读取 Markdown 外链或本地图片路径；可使用安全内嵌图片。" };
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(target);
  if (!match) return { reason: "IMAGE_UNSUPPORTED", message: "仅支持 PNG、JPEG、GIF、WebP 的 base64 内嵌图片，SVG 和其他格式暂不加载。" };
  if (match[2].length > Math.ceil(8 * 1024 * 1024 * 4 / 3) || match[2].length % 4 !== 0) return { reason: "IMAGE_TOO_LARGE_OR_INVALID", message: "内嵌图片超过 8 MiB 或编码无效。" };
  const bytes = Buffer.from(match[2], "base64");
  const mime = match[1].toLowerCase();
  const actual = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
    : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii")) ? "image/gif"
    : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : undefined;
  if (actual !== mime) return { reason: "IMAGE_SIGNATURE_MISMATCH", message: "内嵌图片的文件签名与声明格式不一致，未加载。" };
  return { asset: { bytes, extension: mime === "image/jpeg" ? "jpg" : mime.split("/")[1], mimeType: mime } };
}

function parseMarkdown(text: string, sourceHash: string): ParsedDocument {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: ParsedSection[] = [{ sourceSectionKey: "md:root", title: "文档", depth: 0, sourceOrder: 0, sourceLocator: { format: "markdown", sourceHash, lineStart: 1, lineEnd: lines.length }, blocks: [] }];
  const stack: ParsedSection[] = [sections[0]];
  let order = 0;
  let index = 0;
  let inlineImageBytes = 0;
  while (index < lines.length) {
    const line = lines[index];
    const heading = markdownHeading(lines, index);
    if (heading) {
      const { depth, title, lineCount } = heading;
      while (stack.length > 1 && stack.at(-1)!.depth >= depth) stack.pop();
      const parent = stack.at(-1)!;
      const section: ParsedSection = {
        sourceSectionKey: `md:h:${index + 1}:${title}`,
        parentKey: parent.sourceSectionKey,
        title, depth, sourceOrder: ++order,
        sourceLocator: { format: "markdown", sourceHash, lineStart: index + 1, lineEnd: index + lineCount }, blocks: []
      };
      sections.push(section);
      section.blocks.push(makeBlock("heading", title, { level: depth }, index + 1, index + lineCount, order, sourceHash, "markdown"));
      stack.push(section);
      index += lineCount;
      continue;
    }
    if (!line.trim()) { index++; continue; }
    const current = stack.at(-1)!;
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (fence) {
      const start = index + 1;
      const language = fence[2].trim();
      const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const code: string[] = [];
      index++;
      while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++]);
      const end = Math.min(index + 1, lines.length);
      if (index < lines.length) index++;
      current.blocks.push(makeBlock("code", code.join("\n"), { language }, start, end, ++order, sourceHash, "markdown"));
      continue;
    }
    const image = markdownStandaloneImage(line);
    if (image) {
      const block = makeBlock("image", image.alt, { alt: image.alt }, index + 1, index + 1, ++order, sourceHash, "markdown");
      const extracted = extractMarkdownImage(image.target);
      if (extracted.asset && inlineImageBytes + extracted.asset.bytes.length <= 32 * 1024 * 1024) {
        inlineImageBytes += extracted.asset.bytes.length; block.asset = extracted.asset;
      } else {
        block.payload.missingReason = extracted.asset ? "IMAGE_TOTAL_LIMIT" : extracted.reason;
        block.payload.missingMessage = extracted.asset ? "内嵌图片总量超过 32 MiB，未载入该图片。" : extracted.message;
      }
      current.blocks.push(block); index++; continue;
    }
    const listMatch = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.exec(line);
    if (listMatch) {
      const start = index + 1;
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/.exec(lines[index]);
        if (!item) break;
        items.push(item[1].trim()); index++;
      }
      current.blocks.push(makeBlock("list", items.join("\n"), { items, ordered: /^\s*\d/.test(line) }, start, index, ++order, sourceHash, "markdown"));
      continue;
    }
    if (isMarkdownTableStart(lines, index)) {
      const start = index + 1;
      const rows: string[][] = [];
      const parseRow = (value: string) => value.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
      rows.push(parseRow(line)); index += 2;
      while (index < lines.length && lines[index].includes("|")) rows.push(parseRow(lines[index++]));
      current.blocks.push(makeBlock("table", rows.map(row => row.join(" | ")).join("\n"), { rows }, start, index, ++order, sourceHash, "markdown"));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const start = index + 1;
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ""));
      current.blocks.push(makeBlock("note", quote.join("\n"), { quote: true }, start, index, ++order, sourceHash, "markdown"));
      continue;
    }
    const start = index + 1;
    const paragraphs = [line.trim()]; index++;
    while (index < lines.length && lines[index].trim() && !markdownHeading(lines, index) && !isMarkdownTableStart(lines, index) && !markdownStandaloneImage(lines[index]) && !/^ {0,3}(?:`{3,}|~{3,})|^\s*>|^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index])) paragraphs.push(lines[index++].trim());
    current.blocks.push(makeBlock("paragraph", paragraphs.join("\n"), {}, start, index, ++order, sourceHash, "markdown"));
  }
  const title = sections.find(section => section.depth === 1)?.title ?? firstNonEmpty(text) ?? "未命名文档";
  if (!sections.slice(1).length && sections[0].blocks.length === 0 && text.trim()) {
    sections[0].blocks.push(makeBlock("paragraph", text.trim(), {}, 1, lines.length, 1, sourceHash, "markdown"));
  }
  return { format: "markdown", title, language: detectLanguage(text), sections };
}

function parseTxt(text: string, sourceHash: string): ParsedDocument {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const root: ParsedSection = { sourceSectionKey: "txt:root", title: "文档", depth: 0, sourceOrder: 0, sourceLocator: { format: "txt", sourceHash, lineStart: 1, lineEnd: lines.length }, blocks: [] };
  const sections = [root];
  const stack: ParsedSection[] = [root];
  let current = root;
  let order = 0;
  let paragraphStart = -1;
  let paragraph: string[] = [];
  const flush = (lineEnd: number) => {
    if (!paragraph.length) return;
    current.blocks.push(makeBlock("paragraph", paragraph.join("\n"), {}, paragraphStart, lineEnd, ++order, sourceHash, "txt"));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(?:第[一二三四五六七八九十百0-9]+(?:章|节|篇|部|部分)\s*.+|\d+(?:\.\d+){0,3}[.)、]?\s+\S.*)$/.exec(line.trim());
    if (heading && line.trim().length < 100) {
      flush(i);
      const depth = /^\d+(?:\.\d+)+/.test(line.trim()) ? line.trim().match(/\./g)!.length + 1 : 1;
      while (stack.length > 1 && stack.at(-1)!.depth >= depth) stack.pop();
      const section: ParsedSection = {
        sourceSectionKey: `txt:h:${i + 1}:${line.trim()}`, parentKey: stack.at(-1)!.sourceSectionKey,
        title: line.trim(), depth, sourceOrder: ++order,
        sourceLocator: { format: "txt", sourceHash, lineStart: i + 1, lineEnd: i + 1 }, blocks: []
      };
      sections.push(section); current = section;
      stack.push(section);
      current.blocks.push(makeBlock("heading", line.trim(), { level: depth }, i + 1, i + 1, ++order, sourceHash, "txt"));
    } else if (!line.trim()) flush(i);
    else { if (!paragraph.length) paragraphStart = i + 1; paragraph.push(line); }
  }
  flush(lines.length);
  if (root.blocks.length === 0 && sections.length === 1 && text.trim()) root.blocks.push(makeBlock("paragraph", text.trim(), {}, 1, lines.length, 1, sourceHash, "txt"));
  const title = sections.length > 1 ? sections[1].title : firstNonEmpty(text) ?? "未命名文档";
  return { format: "txt", title, language: detectLanguage(text), sections };
}

function makeBlock(type: BlockType, text: string, payload: Record<string, unknown>, lineStart: number, lineEnd: number, order: number, sourceHash: string, format: DocumentFormat): ParsedBlock {
  return {
    sourceBlockKey: `${format}:lines:${lineStart}-${lineEnd}`,
    sourceOrder: order,
    sourceKeyAliases: [`${format}:${lineStart}:${lineEnd}:${order}`],
    type, text, payload,
    sourceLocator: { format, sourceHash, lineStart, lineEnd, excerpt: text.slice(0, 240) }
  };
}

async function parsePptx(bytes: Buffer, sourceHash: string): Promise<ParsedDocument> {
  let zip: JSZip;
  // Read the directory first so expansion limits apply before any entry is inflated.
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw new Error("CORRUPT_PPTX: PPTX 压缩包损坏或格式无效。"); }
  const files = Object.values(zip.files);
  if (files.length > 20_000 || files.reduce((sum, entry) => sum + Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0) > 512 * 1024 * 1024) {
    throw new Error("PPTX_TOO_LARGE: PPTX 解压后的内容超过当前安全限制（512 MiB 或 20000 个文件）。");
  }
  const typesFile = zip.file("[Content_Types].xml");
  const types = typesFile ? await typesFile.async("string") : "";
  if (!types.includes("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml")) {
    throw new Error("UNSUPPORTED_OFFICE_PACKAGE: 文件签名不是未加密的 PPTX 演示文稿，修改扩展名不能转换格式。");
  }
  const presentationFile = zip.file("ppt/presentation.xml");
  if (!presentationFile) throw new Error("CORRUPT_PPTX: 缺少演示文稿结构文件。");
  const presentation = xml.parse(await presentationFile.async("string"));
  const relsFile = zip.file("ppt/_rels/presentation.xml.rels");
  const rels = relsFile ? relationMap(xml.parse(await relsFile.async("string"))) : new Map<string, string>();
  const slideIds = findFirst(presentation, key => key.endsWith(":sldIdLst"));
  const orderedRids = slideIds ? descendants(slideIds, key => key.endsWith(":sldId")).map(node => String(node["@_r:id"] ?? "")) : [];
  if (!orderedRids.length) throw new Error("CORRUPT_PPTX: 演示文稿缺少有效幻灯片顺序列表。");
  const slidePaths = orderedRids.map((id, index) => {
    const path = normalizeZipPath("ppt", rels.get(id) ?? "");
    if (!id || !path) throw new Error(`CORRUPT_PPTX: 第 ${index + 1} 页缺少有效的幻灯片关系引用。`);
    return path;
  });

  const sections: ParsedSection[] = [{ sourceSectionKey: "pptx:root", title: "演示文稿", depth: 0, sourceOrder: 0, sourceLocator: { format: "pptx", sourceHash }, blocks: [] }];
  let sourceOrder = 0;
  for (let slideIndex = 0; slideIndex < slidePaths.length; slideIndex++) {
    const slidePath = slidePaths[slideIndex];
    const slideFile = zip.file(slidePath);
    if (!slideFile) throw new Error(`CORRUPT_PPTX: 第 ${slideIndex + 1} 页引用的幻灯片文件缺失（${slidePath}）。`);
    const slideXml = await slideFile.async("string");
    const slide = xml.parse(slideXml);
    const slideNo = slideIndex + 1;
    const section: ParsedSection = {
      sourceSectionKey: `pptx:slide:${slideNo}`, parentKey: "pptx:root", title: `第 ${slideNo} 页`, depth: 1,
      sourceOrder: slideNo, sourceLocator: { format: "pptx", sourceHash, slideNumber: slideNo }, blocks: []
    };
    sections.push(section);
    const relPath = posix.join(posix.dirname(slidePath), "_rels", `${posix.basename(slidePath)}.rels`);
    const slideRelsFile = zip.file(relPath);
    const slideRelationships = slideRelsFile ? xml.parse(await slideRelsFile.async("string")) as Record<string, unknown> : {};
    const slideRels = relationMap(slideRelationships);
    const tree = findFirst(slide, key => key.endsWith(":spTree"));
    const shapeTree = tree ?? {};
    let blockOrder = 0;
    let hasTitle = false;
    const shapeCounts = new Map<string, number>();
    const nativeShapes = findOrderedShapes(orderedXml.parse(slideXml));
    const children = nativeShapes.flatMap(native => {
      const { key } = native;
      const count = shapeCounts.get(key) ?? 0;
      shapeCounts.set(key, count + 1);
      const value = shapeTree[key];
      const item = Array.isArray(value) ? value[count] : count === 0 ? value : undefined;
      return item && typeof item === "object" ? [{ ...native, value: item }] : [];
    });
    for (const { key, value, originalIndex, orderedValue } of children) {
      const elementPath = `${slidePath}#/p:sld/p:cSld/p:spTree/*[${originalIndex + 1}]`;
      if (key.endsWith(":sp")) {
        const shape = value as Record<string, unknown>;
        const paragraphList = orderedParagraphs(orderedValue).filter(paragraph => paragraph.text);
        const text = paragraphList.map(paragraph => paragraph.text).join("\n").trim();
        if (!text) continue;
        const isTitle = !hasTitle && isTitlePlaceholder(shape);
        const locator = { format: "pptx" as const, sourceHash, slideNumber: slideNo, paragraphIndex: originalIndex, elementPath, excerpt: text.slice(0, 240) };
        section.blocks.push({ sourceBlockKey: `pptx:${elementPath}`, sourceOrder: sourceOrder++, sourceKeyAliases: [`pptx:${slideNo}:shape:${blockOrder}`], type: isTitle ? "heading" : paragraphList.some(p => p.bullet) ? "list" : "paragraph", text, payload: { paragraphs: paragraphList }, sourceLocator: locator });
        if (isTitle) hasTitle = true;
        blockOrder++;
      } else if (key.endsWith(":pic")) {
        const pic = value as Record<string, unknown>;
        const blip = descendants(pic, k => k.endsWith(":blip"))[0];
        const embed = blip?.["@_r:embed"];
        if (!embed && blip?.["@_r:link"]) continue;
        const target = embed ? slideRels.get(String(embed)) : undefined;
        if (!target) throw new Error(`CORRUPT_PPTX: 第 ${slideNo} 页的内嵌图片缺少有效关系引用。`);
        const imagePath = normalizeZipPath(posix.dirname(slidePath), target);
        const imageFile = zip.file(imagePath);
        if (!imageFile) throw new Error(`CORRUPT_PPTX: 第 ${slideNo} 页引用的内嵌图片文件缺失（${imagePath}）。`);
        const imageBytes = await imageFile.async("nodebuffer");
        const imageExt = extname(imagePath).slice(1).toLowerCase() || "bin";
        const mimeType = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp" } as Record<string, string>)[imageExt] ?? "application/octet-stream";
        const alt = descendants(pic, k => k.endsWith(":cNvPr"))[0]?.["@_descr"];
        section.blocks.push({
          sourceBlockKey: `pptx:${elementPath}`, sourceOrder: sourceOrder++, sourceKeyAliases: [`pptx:${slideNo}:image:${blockOrder}`], type: "image", text: typeof alt === "string" ? alt : "",
          payload: { alt: typeof alt === "string" ? alt : "", extension: imageExt },
          sourceLocator: { format: "pptx", sourceHash, slideNumber: slideNo, paragraphIndex: originalIndex, elementPath },
          asset: { bytes: imageBytes, extension: imageExt, mimeType }
        });
        blockOrder++;
      }
    }
    if (!hasTitle) {
      const firstText = section.blocks.find(block => block.type !== "image" && block.text.trim());
      if (firstText) {
        section.title = firstText.text.split("\n")[0].slice(0, 100);
        firstText.type = "heading";
      }
    } else {
      const titleBlock = section.blocks.find(block => block.type === "heading");
      if (titleBlock) section.title = titleBlock.text.split("\n")[0].slice(0, 100);
    }
    const notesTarget = relationships(slideRelationships).find(relation => String(relation["@_Type"] ?? "").endsWith("/notesSlide") && relation["@_TargetMode"] !== "External")?.["@_Target"];
    const notesPath = notesTarget ? normalizeZipPath(posix.dirname(slidePath), String(notesTarget)) : "";
    const noteFile = zip.file(notesPath);
    if (noteFile) {
      const noteText = orderedParagraphs(orderedXml.parse(await noteFile.async("string"))).map(paragraph => paragraph.text).filter(Boolean).join("\n").trim();
      const elementPath = `${notesPath}#/p:notes`;
      if (noteText) section.blocks.push({ sourceBlockKey: `pptx:${elementPath}`, sourceOrder: sourceOrder++, sourceKeyAliases: [`pptx:${slideNo}:note`], type: "note", text: noteText, payload: { note: true }, sourceLocator: { format: "pptx", sourceHash, slideNumber: slideNo, elementPath } });
    }
  }
  const title = sections.slice(1).find(section => section.title)?.title ?? "演示文稿";
  return { format: "pptx", title, language: "und", sections };
}

interface OrderedShape { key: string; originalIndex: number; orderedValue: unknown }

function findOrderedShapes(parsed: unknown): OrderedShape[] {
  const visit = (value: unknown): OrderedShape[] | undefined => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) { const found = visit(child); if (found) return found; }
      return;
    }
    for (const [key, children] of Object.entries(value)) {
      if (key.endsWith(":spTree") && Array.isArray(children)) return children.flatMap((child, originalIndex) => {
        if (!child || typeof child !== "object") return [];
        return Object.entries(child).filter(([name]) => name.endsWith(":sp") || name.endsWith(":pic"))
          .map(([key, orderedValue]) => ({ key, originalIndex, orderedValue }));
      });
      const found = visit(children); if (found) return found;
    }
  };
  return visit(parsed) ?? [];
}

function orderedParagraphs(value: unknown): Array<{ text: string; bullet: boolean }> {
  const paragraphs: Array<{ text: string; bullet: boolean }> = [];
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    for (const [key, children] of Object.entries(item)) {
      if (key.endsWith(":p")) paragraphs.push({ text: orderedInlineText(children), bullet: containsKey(children, name => name.endsWith(":buChar") || name.endsWith(":buAutoNum")) });
      else if (key !== ":@") visit(children);
    }
  };
  visit(value);
  return paragraphs;
}

function orderedInlineText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(orderedInlineText).join("");
  let text = "";
  for (const [key, children] of Object.entries(value)) {
    if (key.endsWith(":br")) text += "\n";
    else if (key.endsWith(":tab")) text += "\t";
    else if (key.endsWith(":t")) text += orderedTextContent(children);
    else if (key !== ":@") text += orderedInlineText(children);
  }
  return text;
}

function orderedTextContent(value: unknown): string {
  if (Array.isArray(value)) return value.map(orderedTextContent).join("");
  if (!value || typeof value !== "object") return "";
  return Object.entries(value).map(([key, child]) => key === "#text" ? String(child) : key === ":@" ? "" : orderedTextContent(child)).join("");
}

function relationMap(parsed: Record<string, unknown>): Map<string, string> {
  const entries: Array<[string, string]> = relationships(parsed).filter(relation => relation["@_TargetMode"] !== "External")
    .map(relation => [String(relation["@_Id"] ?? ""), String(relation["@_Target"] ?? "")] as [string, string])
    .filter(([id, target]) => Boolean(id && target));
  return new Map(entries);
}

function relationships(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const root = findFirst(parsed, key => /(?:^|:)Relationships$/.test(key)) ?? parsed;
  return descendants(root, key => /(?:^|:)Relationship$/.test(key));
}

function normalizeZipPath(base: string, target: string): string {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return "";
  const combined = target.startsWith("/") ? target.slice(1) : posix.join(base, target);
  const normalized = posix.normalize(combined);
  return normalized.startsWith("../") || normalized === ".." ? "" : normalized;
}

function findFirst(value: unknown, predicate: (key: string) => boolean): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findFirst(item, predicate); if (found) return found; }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (predicate(key)) {
      const candidate = Array.isArray(child) ? child[0] : child;
      if (candidate && typeof candidate === "object") return candidate as Record<string, unknown>;
      return { "#text": candidate };
    }
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function descendants(value: unknown, predicate: (key: string) => boolean): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    for (const [key, child] of Object.entries(item)) {
      if (predicate(key)) {
        const nodes = Array.isArray(child) ? child : [child];
        for (const node of nodes) if (node && typeof node === "object") result.push(node as Record<string, unknown>); else result.push({ "#text": node });
      }
      visit(child);
    }
  };
  visit(value);
  return result;
}

function containsKey(value: unknown, predicate: (key: string) => boolean): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(item => containsKey(item, predicate));
  return Object.entries(value).some(([key, child]) => predicate(key) || containsKey(child, predicate));
}

function isTitlePlaceholder(shape: Record<string, unknown>): boolean {
  return descendants(shape, key => key.endsWith(":ph")).some(placeholder => {
    const type = String(placeholder["@_type"] ?? "");
    return type === "title" || type === "ctrTitle";
  });
}

function firstNonEmpty(text: string): string | undefined {
  return text.split(/\r?\n/).map(line => line.trim().replace(/^#+\s*/, "")).find(Boolean);
}

function detectLanguage(text: string): string {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk > latin * 0.1 ? "zh" : latin ? "en" : "und";
}
