import { extname, posix } from "node:path";
import JSZip from "jszip";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { ParsedBlock, ParsedDocument, ParsedSection, ProgressCallback } from "../parsers.js";

// Ordered OOXML nodes preserve runs, drawings, lists and tables in their native order.
type Node = Record<string, any>;
const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true, processEntities: true, parseTagValue: false, trimValues: false });
const name = (node: Node) => Object.keys(node).find(key => key !== ":@") ?? "";
const local = (node: Node) => name(node).split(":").at(-1)!;
const children = (node?: Node): Node[] => node && Array.isArray(node[name(node)]) ? node[name(node)] : [];
const attr = (node: Node | undefined, key: string): string | undefined => {
  const attrs = node?.[":@"] ?? {};
  const found = Object.keys(attrs).find(item => item.replace(/^@_/, "").split(":").at(-1) === key);
  return found === undefined ? undefined : String(attrs[found]);
};
const child = (node: Node | undefined, key: string) => children(node).find(item => local(item) === key);
function all(nodes: Node[], key: string): Node[] { return nodes.flatMap(node => [...(local(node) === key ? [node] : []), ...all(children(node), key)]); }
function text(nodes: Node[]): string {
  return nodes.map(node => local(node) === "t" ? children(node).map(item => String(item["#text"] ?? "")).join("")
    : ["tab", "br", "cr"].includes(local(node)) ? local(node) === "tab" ? "\t" : "\n"
    : local(node) === "del" ? "" : text(children(node))).join("");
}
function parse(source: string, part: string): Node[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(source) || XMLValidator.validate(source) !== true) throw new Error('CORRUPT_DOCX: XML 结构损坏（' + part + '）。');
  return parser.parse(source);
}
type Relationship = { target: string; external: boolean; type: string };
type Style = { basedOn?: string; level?: number; bold?: boolean; italic?: boolean; code?: boolean; numId?: string; ilvl?: number };
type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

export async function parseDocx(bytes: Buffer, sourceHash: string, onProgress?: ProgressCallback): Promise<ParsedDocument> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, { checkCRC32: false }); }
  catch { throw new Error("CORRUPT_DOCX: DOCX 压缩包损坏或格式无效。"); }
  const files = Object.values(zip.files);
  if (files.length > 20_000 || files.reduce((sum, item) => sum + Number((item as any)._data?.uncompressedSize ?? 0), 0) > 512 * 1024 * 1024) throw new Error("DOCX_TOO_LARGE: DOCX 解包超过 512 MiB 或 20000 个文件的限制。");
  const read = async (path: string, required = false) => {
    const file = zip.file(path);
    if (!file && required) throw new Error('CORRUPT_DOCX: 缺少 ' + path + '。');
    return file ? parse(await file.async("string"), path) : [];
  };
  onProgress?.({ progress: 5, message: "读取 DOCX 原生结构与样式" });
  const types = await read("[Content_Types].xml", true);
  const main = all(types, "Override").find(node => attr(node, "PartName") === "/word/document.xml");
  if (attr(main, "ContentType") !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") throw new Error("UNSUPPORTED_DOCX: 仅支持未加密的标准 DOCX；宏文档、模板或其他 Office 包不受支持。");
  const document = await read("word/document.xml", true);
  const body = all(document, "body")[0];
  if (!body) throw new Error("CORRUPT_DOCX: 缺少正文结构。");
  const styles = new Map<string, Style>();
  for (const node of all(await read("word/styles.xml"), "style")) {
    const id = attr(node, "styleId") ?? "";
    const ppr = child(node, "pPr"); const rpr = child(node, "rPr");
    const nativeLevel = attr(child(ppr, "outlineLvl"), "val");
    const heading = /^(?:Heading|标题)\s*([1-9])$/i.exec(attr(child(node, "name"), "val") ?? id);
    const num = child(ppr, "numPr");
    styles.set(id, { basedOn: attr(child(node, "basedOn"), "val"), level: nativeLevel !== undefined ? Number(nativeLevel) + 1 : heading ? Number(heading[1]) : undefined,
      bold: toggle(rpr, "b"), italic: toggle(rpr, "i"), code: /code|源码|代码/i.test(id), numId: attr(child(num, "numId"), "val"), ilvl: numberAttr(child(num, "ilvl")) });
  }
  const resolveStyle = (id?: string, seen = new Set<string>()): Style => {
    if (!id || seen.has(id)) return {};
    seen.add(id); const value = styles.get(id) ?? {};
    return Object.fromEntries(Object.entries({ ...resolveStyle(value.basedOn, seen), ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) }).filter(([, v]) => v !== undefined));
  };
  const numbering = await read("word/numbering.xml");
  const numDefinitions = new Map(all(numbering, "num").map(node => [attr(node, "numId"), node]));
  const numMap = new Map(all(numbering, "num").map(node => [attr(node, "numId"), attr(child(node, "abstractNumId"), "val")]));
  const abstract = new Map(all(numbering, "abstractNum").map(node => [attr(node, "abstractNumId"), node]));
  const listCounters = new Map<string, Map<number, number>>();
  const relationships = async (part: string) => {
    const relPath = posix.join(posix.dirname(part), "_rels", posix.basename(part) + ".rels");
    return new Map<string, Relationship>(all(await read(relPath), "Relationship").map(node => [attr(node, "Id") ?? "", { target: attr(node, "Target") ?? "", external: attr(node, "TargetMode") === "External", type: attr(node, "Type") ?? "" }]));
  };
  const rels = await relationships("word/document.xml");
  const root: ParsedSection = { sourceSectionKey: "docx:root", title: "文档", depth: 0, sourceOrder: 0, sourceLocator: { format: "docx", sourceHash }, blocks: [] };
  const sections = [root]; const stack = [root]; let order = 0; let paragraphIndex = 0;
  const warnings = new Set<string>(); const noteRefs: Array<{ kind: string; id: string; section: ParsedSection }> = [];
  const make = (type: ParsedBlock["type"], value: string, payload: Record<string, unknown>, path: string): ParsedBlock => ({ sourceBlockKey: 'docx:' + path, sourceOrder: order++, type, text: value, payload,
    sourceLocator: { format: "docx", sourceHash, elementPath: path, paragraphIndex, excerpt: value.slice(0, 240), headingPath: stack.slice(1).map(item => item.title) } });
  const image = async (drawing: Node, path: string, part: string, map: Map<string, Relationship>) => {
    const blip = all([drawing], "blip")[0] ?? all([drawing], "imagedata")[0];
    const relation = map.get(attr(blip, "embed") ?? attr(blip, "id") ?? "");
    const altNode = all([drawing], "docPr")[0];
    const alt = attr(altNode, "descr") ?? attr(altNode, "title") ?? "";
    const block = make("image", alt, { alt }, path);
    const extent = all([drawing], "extent").find(node => Number(attr(node, "cx")) > 0 && Number(attr(node, "cy")) > 0);
    if (extent) {
      block.payload.width = Number(attr(extent, "cx")) / 9525;
      block.payload.height = Number(attr(extent, "cy")) / 9525;
    }
    if (!relation || relation.external) { block.payload.missingReason = "EXTERNAL_OR_MISSING_IMAGE"; warnings.add("外链图片或缺失的媒体关系未载入"); return block; }
    const target = posix.normalize(relation.target.startsWith("/") ? relation.target.slice(1) : posix.join(posix.dirname(part), relation.target));
    if (!target.startsWith("word/media/")) { block.payload.missingReason = "UNSUPPORTED_MEDIA_PATH"; return block; }
    const file = zip.file(target);
    if (!file) { block.payload.missingReason = "IMAGE_MISSING"; warnings.add("部分内嵌图片文件缺失"); return block; }
    const extension = extname(target).slice(1).toLowerCase();
    const mimeType = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", emf: "image/emf", wmf: "image/wmf", svg: "image/svg+xml" } as Record<string, string>)[extension] ?? "application/octet-stream";
    block.asset = { bytes: await file.async("nodebuffer"), extension, mimeType };
    if (!extent && extension === "png" && block.asset.bytes.length >= 24 && block.asset.bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
      block.payload.width = block.asset.bytes.readUInt32BE(16); block.payload.height = block.asset.bytes.readUInt32BE(20);
    } else if (!extent && extension === "bmp" && block.asset.bytes.length >= 26 && block.asset.bytes.subarray(0, 2).toString() === "BM" && block.asset.bytes.readUInt32LE(14) >= 40) {
      block.payload.width = Math.abs(block.asset.bytes.readInt32LE(18)); block.payload.height = Math.abs(block.asset.bytes.readInt32LE(22));
    }
    if (!["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension)) warnings.add("部分 Word 矢量或 TIFF 图片无法在浏览器直接显示");
    return block;
  };
  const parseParagraph = async (node: Node, path: string, section: ParsedSection, part: string, map: Map<string, Relationship>, allowHeading: boolean) => {
    paragraphIndex++;
    const ppr = child(node, "pPr"); const styleId = attr(child(ppr, "pStyle"), "val"); const style = resolveStyle(styleId);
    const level = numberAttr(child(ppr, "outlineLvl"));
    const heading = level !== undefined ? level + 1 : style.level;
    if (allowHeading && heading && heading <= 9 && text(children(node)).trim()) {
      while (stack.length > 1 && stack.at(-1)!.depth >= heading) stack.pop();
      section = { sourceSectionKey: 'docx:heading:' + path, parentKey: stack.at(-1)!.sourceSectionKey, title: text(children(node)).trim(), depth: heading, sourceOrder: order,
        sourceLocator: { format: "docx", sourceHash, elementPath: path, paragraphIndex, headingSource: "native-style" }, blocks: [] };
      sections.push(section); stack.push(section);
    }
    const numPr = child(ppr, "numPr");
    const numId = attr(child(numPr, "numId"), "val") ?? style.numId;
    const ilvl = numberAttr(child(numPr, "ilvl")) ?? style.ilvl ?? 0;
    const lvl = children(abstract.get(numMap.get(numId) ?? "")).find(item => local(item) === "lvl" && Number(attr(item, "ilvl")) === ilvl);
    const ordered = attr(child(lvl, "numFmt"), "val") !== "bullet";
    let listStart = Number(attr(child(lvl, "start"), "val") ?? 1);
    if (numId && numId !== "0" && !heading) {
      const override = children(numDefinitions.get(numId)).find(item => local(item) === "lvlOverride" && Number(attr(item, "ilvl")) === ilvl);
      listStart = numberAttr(child(override, "startOverride")) ?? listStart;
      const counters = listCounters.get(numId) ?? new Map<number, number>();
      listStart = (counters.get(ilvl) ?? listStart - 1) + 1;
      counters.set(ilvl, listStart);
      for (const level of counters.keys()) if (level > ilvl) counters.delete(level);
      listCounters.set(numId, counters);
    }
    let runs: Run[] = []; let segment = 0;
    const flush = () => {
      const value = runs.map(run => run.text).join("");
      if (value.trim()) {
        const type = allowHeading && heading && heading <= 9 ? "heading" : numId && numId !== "0" ? "list" : "paragraph";
        section.blocks.push(make(type, value, { runs, ...(type === "heading" ? { level: heading, headingSource: "native-style" } : {}), ...(type === "list" ? { items: [value], ordered, level: ilvl, numId, start: listStart } : {}) }, path + '/text[' + segment++ + ']'));
      }
      runs = [];
    };
    const walk = async (nodes: Node[], inherited: Style = style) => {
      for (let i = 0; i < nodes.length; i++) {
        const item = nodes[i]; const key = local(item);
        if (["pPr", "rPr", "del"].includes(key)) continue;
        if (["drawing", "pict"].includes(key)) {
          if (all([item], "blip").length || all([item], "imagedata").length) { flush(); section.blocks.push(await image(item, path + '/image[' + segment++ + ']', part, map)); }
          continue;
        }
        if (["footnoteReference", "endnoteReference", "commentReference"].includes(key)) { noteRefs.push({ kind: key.replace("Reference", ""), id: attr(item, "id") ?? "", section }); continue; }
        if (key === "r") {
          const rpr = child(item, "rPr"); const runStyle = resolveStyle(attr(child(rpr, "rStyle"), "val"));
          const combined = { ...inherited, ...runStyle };
          await walk(children(item), { ...combined, bold: toggle(rpr, "b") ?? combined.bold, italic: toggle(rpr, "i") ?? combined.italic,
            code: combined.code || /consolas|courier|mono/i.test(attr(child(rpr, "rFonts"), "ascii") ?? "") });
        } else if (key === "t") runs.push({ text: children(item).map(value => String(value["#text"] ?? "")).join(""), bold: inherited.bold, italic: inherited.italic, code: inherited.code });
        else if (["br", "cr", "tab"].includes(key)) runs.push({ text: key === "tab" ? "\t" : "\n" });
        else if (key === "AlternateContent") await walk(children(child(item, "Choice") ?? child(item, "Fallback")), inherited);
        else await walk(children(item), inherited);
      }
    };
    await walk(children(node)); flush(); return section;
  };
  const walkBody = async (nodes: Node[], prefix: string, section: ParsedSection) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]; const path = prefix + '/' + name(node) + '[' + i + ']';
      if (local(node) === "p") section = await parseParagraph(node, path, section, "word/document.xml", rels, true);
      else if (local(node) === "tbl") {
        const rows: string[][] = []; const cells: Array<Array<Record<string, unknown>>> = [];
        for (const row of children(node).filter(item => local(item) === "tr")) {
          const rowCells = children(row).filter(item => local(item) === "tc");
          rows.push(rowCells.map(cell => all(children(cell), "p").map(p => text(children(p))).join("\n")));
          cells.push(rowCells.map(cell => ({ colSpan: Number(attr(child(child(cell, "tcPr"), "gridSpan"), "val") ?? 1), rowMerge: attr(child(child(cell, "tcPr"), "vMerge"), "val") ?? (child(child(cell, "tcPr"), "vMerge") ? "continue" : undefined) })));
        }
        section.blocks.push(make("table", rows.map(row => row.join(" | ")).join("\n"), { rows, cells }, path));
        const drawings = [...all(children(node), "drawing"), ...all(children(node), "pict")].filter(drawing => all([drawing], "blip").length || all([drawing], "imagedata").length);
        for (let j = 0; j < drawings.length; j++) section.blocks.push(await image(drawings[j], path + '/image[' + j + ']', "word/document.xml", rels));
      } else if (!["sectPr", "del"].includes(local(node))) section = await walkBody(children(node), path, section);
      if (i % 20 === 0) { onProgress?.({ progress: 15 + Math.round(65 * (i + 1) / Math.max(1, nodes.length)), message: '解析 DOCX 内容 ' + (i + 1) + '/' + nodes.length }); await new Promise<void>(resolve => setImmediate(resolve)); }
    }
    return section;
  };
  await walkBody(children(body), "word/document.xml#/body", root);
  // Notes are optional. A damaged optional part cannot invalidate an otherwise readable document.
  const seenNotes = new Set<string>();
  for (const reference of noteRefs.slice()) {
    const key = reference.kind + ':' + reference.id; if (seenNotes.has(key)) continue; seenNotes.add(key);
    const part = 'word/' + (reference.kind === "comment" ? "comments" : reference.kind + 's') + '.xml';
    try {
      const note = all(await read(part), reference.kind).find(item => attr(item, "id") === reference.id);
      const value = note ? all(children(note), "p").map(p => text(children(p))).join("\n") : "";
      if (value.trim()) reference.section.blocks.push(make("note", value, { noteKind: reference.kind, noteId: reference.id }, part + '#/' + reference.id));
    } catch { warnings.add("部分脚注、尾注或批注无法读取，已忽略"); }
  }
  const title = sections.find(item => item.depth === 1)?.title ?? sections.find(item => item.depth > 0)?.title ?? text(children(body)).trim().split("\n")[0]?.slice(0, 120) ?? "Word 文档";
  const fullText = sections.flatMap(item => item.blocks.map(block => block.text)).join("\n");
  onProgress?.({ progress: 90, message: "DOCX 结构解析完成，准备建立索引" });
  return { format: "docx", title: title || "Word 文档", language: /[\u3400-\u9fff]/u.test(fullText) ? "zh" : /[a-z]/i.test(fullText) ? "en" : "und", sections,
    metadata: { parser: "ooxml", nativeText: true, headingSource: "native-style", warnings: [...warnings] } };
}
function toggle(parent: Node | undefined, key: string): boolean | undefined { const node = child(parent, key); return node ? !["0", "false", "off"].includes(attr(node, "val") ?? "1") : undefined; }
function numberAttr(node?: Node): number | undefined { const value = attr(node, "val"); return value !== undefined && Number.isFinite(Number(value)) ? Number(value) : undefined; }
