import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api.js";
import type { ParsedBlock, ParsedDocument, ParsedSection, ProgressCallback } from "../parsers.js";

type Fragment = { text: string; x: number; y: number; right: number; size: number; bold: boolean; native: number; end: number };
type Entry = { block: ParsedBlock; x: number; y: number; right: number; size: number; bold: boolean; native: number; column?: number };
type Bookmark = { section: ParsedSection; page: number; y: number; index: number };

/** Reads the native PDF text layer and image objects. Never rasterizes a page or invokes OCR. */
export async function parsePdf(bytes: Buffer, sourceHash: string, onProgress?: ProgressCallback): Promise<ParsedDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  // PDF.js requires a trailing forward slash; its Node factory reads filesystem paths.
  const resourceDirectory = (name: string) => join(packageRoot, name).replaceAll("\\", "/") + "/";
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, disableFontFace: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    standardFontDataUrl: resourceDirectory("standard_fonts"), cMapUrl: resourceDirectory("cmaps"), cMapPacked: true,
    wasmUrl: resourceDirectory("wasm") });
  try {
    const pdf = await task.promise;
    const warnings = new Set<string>();
    const root: ParsedSection = { sourceSectionKey: "pdf:root", title: "文档", depth: 0, sourceOrder: 0, sourceLocator: { format: "pdf", sourceHash }, blocks: [] };
    const sections = [root]; const bookmarks: Bookmark[] = [];
    const rawOutline = await pdf.getOutline().catch(() => { warnings.add("PDF 大纲无法读取，已使用自动推断"); return null; });
    if (!rawOutline?.length && !warnings.has("PDF 大纲无法读取，已使用自动推断")) warnings.add("PDF 未提供大纲，标题层级为自动推断");
    const visitOutline = async (items: NonNullable<typeof rawOutline>, parent: ParsedSection, depth: number) => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]; let page = 1; let y = 0;
        try {
          const dest = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
          if (dest?.length) {
            page = typeof dest[0] === "number" ? dest[0] + 1 : await pdf.getPageIndex(dest[0]) + 1;
            const targetPage = await pdf.getPage(page); const viewport = targetPage.getViewport({ scale: 1 });
            const type = dest[1]?.name; const top = type === "XYZ" ? dest[3] : type === "FitH" || type === "FitBH" ? dest[2] : undefined;
            if (typeof top === "number") y = viewport.convertToViewportPoint(0, top)[1];
          } else warnings.add("部分 PDF 书签没有页内目标，使用相邻章节页码");
        } catch { page = bookmarks.at(-1)?.page ?? 1; warnings.add("部分 PDF 书签目标无效，使用相邻章节页码"); }
        const section: ParsedSection = { sourceSectionKey: parent.sourceSectionKey + "/outline[" + i + "]", parentKey: parent.sourceSectionKey,
          title: item.title.trim() || "未命名书签", depth, sourceOrder: sections.length,
          sourceLocator: { format: "pdf", sourceHash, pageNumber: page, headingSource: "native-outline" }, blocks: [] };
        sections.push(section); bookmarks.push({ section, page, y, index: -1 });
        await visitOutline(item.items ?? [], section, depth + 1);
      }
    };
    await visitOutline(rawOutline ?? [], root, 1);
    const pages: Array<{ number: number; entries: Entry[]; characters: number; images: number }> = [];
    let totalChars = 0; let imageCount = 0; let orderWarning = false;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number); const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const fragments: Fragment[] = [];
      content.items.forEach((item, native) => {
        if (!("str" in item) || !item.str.trim()) return;
        const transform = pdfjs.Util.transform(viewport.transform, item.transform);
        const size = Math.hypot(transform[2], transform[3]) || item.height || 10;
        if (Math.abs(transform[1]) > 0.1 || item.dir === "ttb") orderWarning = true;
        fragments.push({ text: item.str, x: transform[4], y: transform[5], right: transform[4] + item.width, size,
          bold: /bold|black|heavy|semibold/i.test(item.fontName + " " + content.styles[item.fontName]?.fontFamily), native, end: native });
      });
      const lines = textLines(fragments);
      let entries: Entry[] = lines.map(line => ({ ...line, block: { sourceBlockKey: "pdf:p" + number + ":text:" + line.native + "-" + line.end,
        sourceOrder: 0, type: "paragraph", text: line.text, payload: {}, sourceLocator: { format: "pdf", sourceHash, pageNumber: number,
          elementPath: "page[" + number + "]/text[" + line.native + "-" + line.end + "]", paragraphIndex: line.native, excerpt: line.text.slice(0, 240) } } }));
      const extracted = await extractImages(page, number, sourceHash, pdfjs, warnings);
      imageCount += extracted.length;
      entries.push(...extracted);
      const ordered = readingOrder(entries, viewport.width);
      entries = ordered.entries; orderWarning ||= ordered.uncertain;
      // Conservative tables: multiple adjacent rows with the same narrow aligned cells.
      entries = conservativeTables(entries, viewport.width);
      const characters = fragments.reduce((sum, item) => sum + item.text.replace(/\s/g, "").length, 0);
      totalChars += characters;
      pages.push({ number, entries, characters, images: extracted.length });
      onProgress?.({ progress: 8 + Math.round(72 * number / pdf.numPages), message: "提取 PDF 文本与图片 " + number + "/" + pdf.numPages + " 页" });
      page.cleanup();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const sparsePages = pages.filter(page => page.characters < 24).map(page => page.number);
    if (totalChars === 0 || (imageCount > 0 && totalChars / pdf.numPages < 24 && sparsePages.length / pdf.numPages >= 0.8)) {
      throw new Error("SCANNED_PDF: 这是扫描件，当前版本未启用 OCR；文本层为空或极稀疏。");
    }
    if (sparsePages.some(number => pages[number - 1].images > 0)) warnings.add("部分页面文本层稀疏，可能包含扫描页；未执行 OCR");
    if (orderWarning) warnings.add("阅读顺序可能不准：复杂多栏、旋转文字或重叠内容使用 PDF 原生文本顺序回退");
    const flat = pages.flatMap(page => page.entries);
    const sizeWeights = new Map<number, number>();
    for (const entry of flat.filter(item => item.block.type === "paragraph")) { const size = Math.round(entry.size * 2) / 2; sizeWeights.set(size, (sizeWeights.get(size) ?? 0) + entry.block.text.length); }
    const bodySize = [...sizeWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
    const headingSizes = [...new Set(flat.filter(entry => candidateHeading(entry, bodySize)).map(entry => Math.round(entry.size)))].sort((a, b) => b - a);
    for (const bookmark of bookmarks) {
      const candidates = flat.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.block.sourceLocator.pageNumber === bookmark.page);
      const exact = candidates.find(({ entry }) => normalized(entry.block.text) === normalized(bookmark.section.title));
      const match = exact ?? candidates.find(({ entry }) => entry.y >= bookmark.y - entry.size);
      bookmark.index = match?.index ?? candidates[0]?.index ?? flat.length;
      if (exact && exact.entry.block.type === "paragraph") { exact.entry.block.type = "heading"; exact.entry.block.payload = { level: bookmark.section.depth, headingSource: "native-outline" }; }
    }
    const boundaries = [...bookmarks].sort((a, b) => a.index - b.index || a.section.sourceOrder - b.section.sourceOrder);
    const stack = [root]; let current = root; let boundary = 0;
    for (let index = 0; index < flat.length; index++) {
      const entry = flat[index]; const block = entry.block; block.sourceOrder = index;
      if (bookmarks.length) { while (boundary < boundaries.length && boundaries[boundary].index <= index) current = boundaries[boundary++].section; }
      else if (candidateHeading(entry, bodySize)) {
        const numbered = /^(\d+(?:\.\d+)*)[.)、]?\s+\S/.exec(block.text);
        const depth = numbered ? Math.min(6, numbered[1].split(".").length) : Math.min(6, headingSizes.indexOf(Math.round(entry.size)) + 1 || 1);
        while (stack.length > 1 && stack.at(-1)!.depth >= depth) stack.pop();
        current = { sourceSectionKey: block.sourceBlockKey + ":heading", parentKey: stack.at(-1)!.sourceSectionKey, title: block.text, depth,
          sourceOrder: sections.length, sourceLocator: { ...block.sourceLocator, headingSource: "automatic-inference", confidence: 0.65 }, blocks: [] };
        sections.push(current); stack.push(current); block.type = "heading"; block.payload = { level: depth, headingSource: "automatic-inference", inferred: true };
      }
      block.sourceLocator.headingPath = bookmarks.length ? headingPath(current, sections) : stack.slice(1).map(section => section.title);
      if (orderWarning) block.sourceLocator.readingOrderWarning = true;
      current.blocks.push(block);
    }
    const metadata = await pdf.getMetadata().catch(() => undefined);
    const infoTitle = metadata?.info && "Title" in metadata.info ? String(metadata.info.Title).trim() : "";
    const title = infoTitle || sections.find(section => section.depth === 1)?.title || flat.find(entry => entry.block.text)?.block.text.slice(0, 120) || "PDF 文档";
    const sample = flat.map(entry => entry.block.text).join("\n");
    return { format: "pdf", title, language: /[\u3400-\u9fff]/u.test(sample) ? "zh" : "en", sections,
      metadata: { parser: "pdfjs-text-layer", nativeText: true, pageCount: pdf.numPages, headingSource: bookmarks.length ? "native-outline" : "automatic-inference",
        readingOrderWarning: orderWarning, sparsePages, warnings: [...warnings] } };
  } catch (error) {
    const failure = error as { name?: string; message?: string };
    if (failure.name === "PasswordException") throw new Error("ENCRYPTED_PDF: PDF 受密码保护，需要密码。请先在本地解密后导入。");
    if (/^[A-Z_]+:/.test(failure.message ?? "")) throw error;
    throw new Error("CORRUPT_PDF: PDF 损坏、版本不受支持或原生内容无法读取。" + (failure.message ? " " + failure.message.slice(0, 200) : ""));
  } finally { await task.destroy(); }
}

function normalized(text: string) { return text.replace(/\s+/g, "").toLowerCase(); }
function headingPath(section: ParsedSection, sections: ParsedSection[]): string[] { const result: string[] = []; let current: ParsedSection | undefined = section; while (current?.parentKey) { result.unshift(current.title); current = sections.find(item => item.sourceSectionKey === current!.parentKey); } return result; }
function candidateHeading(entry: Entry, bodySize: number) {
  if (entry.block.type !== "paragraph" || entry.block.text.length > 140 || entry.block.text.length < 2) return false;
  const numbered = /^(?:\d+(?:\.\d+)*[.)、]?\s+\D|第[一二三四五六七八九十百0-9]+[章节篇部])/u.test(entry.block.text);
  return entry.size >= bodySize * 1.22 || (entry.bold && entry.size >= bodySize * 0.98 && !/[。！？.!?]$/.test(entry.block.text)) || (numbered && entry.size >= bodySize && entry.x < 140);
}

function textLines(items: Fragment[]): Fragment[] {
  const rows: Fragment[][] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].y - item.y) < Math.min(row[0].size, item.size) * 0.35) row.push(item); else rows.push([item]);
  }
  return rows.flatMap(row => {
    const result: Fragment[] = [];
    for (const item of row.sort((a, b) => a.x - b.x)) {
      const last = result.at(-1); const gap = last ? item.x - last.right : Infinity;
      if (last && gap < Math.max(6, item.size * 1.7)) {
        const space = gap > item.size * 0.15 && !/\s$/.test(last.text) && !/^\s/.test(item.text) && !/[\u3400-\u9fff]$/.test(last.text) && !/^[\u3400-\u9fff，。；：！？]/.test(item.text) ? " " : "";
        last.text += space + item.text; last.right = Math.max(last.right, item.right); last.native = Math.min(last.native, item.native); last.end = Math.max(last.end, item.end); last.size = Math.max(last.size, item.size); last.bold ||= item.bold;
      } else result.push({ ...item });
    }
    return result;
  });
}

function readingOrder(entries: Entry[], width: number): { entries: Entry[]; uncertain: boolean } {
  const text = entries.filter(item => item.block.type === "paragraph");
  const middle = width / 2;
  const left = text.filter(item => item.x < middle && item.right < middle + width * 0.04);
  const right = text.filter(item => item.x > middle - width * 0.04);
  const topDown = (a: Entry, b: Entry) => a.y - b.y || a.x - b.x || a.native - b.native;
  if (left.length >= 3 && right.length >= 3 && Math.min(...right.map(item => item.x)) - Math.max(...left.map(item => item.right)) >= width * 0.025) {
    // Full-width headings/figures split a two-column page into horizontal bands.
    const spanning = entries.filter(item => item.x < middle && item.right > middle + width * 0.05).sort(topDown);
    const result: Entry[] = []; let remaining = [...entries];
    const flush = (boundary: number) => {
      const band = remaining.filter(item => item.y < boundary); remaining = remaining.filter(item => item.y >= boundary);
      result.push(...band.filter(item => item.x < middle).sort(topDown), ...band.filter(item => item.x >= middle).sort(topDown));
    };
    for (const span of spanning) { flush(span.y - span.size * 0.5); const index = remaining.indexOf(span); if (index >= 0) { remaining.splice(index, 1); result.push(span); } }
    flush(Infinity); return { entries: result, uncertain: false };
  }
  const ambiguous = text.some(item => text.some(other => other !== item && Math.abs(other.y - item.y) < item.size * 0.4 && Math.abs(other.x - item.x) > width * 0.3));
  if (ambiguous) {
    // Retain PDF-native text order if we cannot establish a safe column partition.
    const nativeText = text.sort((a, b) => a.native - b.native); const images = entries.filter(item => item.block.type === "image");
    for (const image of images.sort(topDown)) { const at = nativeText.findIndex(item => item.y >= image.y); nativeText.splice(at < 0 ? nativeText.length : at, 0, image); }
    return { entries: nativeText, uncertain: true };
  }
  return { entries: entries.sort(topDown), uncertain: false };
}

function conservativeTables(entries: Entry[], width: number): Entry[] {
  const output: Entry[] = [];
  for (let i = 0; i < entries.length;) {
    const first = entries[i]; const rows: Entry[][] = []; let cursor = i;
    while (cursor < entries.length) {
      const row: Entry[] = []; const y = entries[cursor].y;
      while (cursor < entries.length && Math.abs(entries[cursor].y - y) < first.size * 0.4 && entries[cursor].block.type === "paragraph") row.push(entries[cursor++]);
      if (row.length < 2 || row.length > 8 || row.some(cell => cell.right - cell.x > width * 0.3 || cell.block.text.length > 60) || (rows.length && (row.length !== rows[0].length || row.some((cell, col) => Math.abs(cell.x - rows[0][col].x) > 6) || y - rows.at(-1)![0].y > first.size * 2.8))) break;
      rows.push(row);
    }
    if (rows.length >= 3) {
      const cells = rows.map(row => row.map(cell => cell.block.text));
      const consumed = rows.flat();
      output.push({ ...first, block: { ...first.block, sourceBlockKey: first.block.sourceBlockKey + ":table", type: "table", text: cells.map(row => row.join(" | ")).join("\n"),
        payload: { rows: cells, inferred: true, confidence: 0.8 }, sourceLocator: { ...first.block.sourceLocator, elementPath: first.block.sourceLocator.elementPath + "/table", confidence: 0.8 } } });
      i += consumed.length;
    } else { output.push(first); i++; }
  }
  return output;
}

async function extractImages(page: PDFPageProxy, number: number, sourceHash: string, pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"), warnings: Set<string>): Promise<Entry[]> {
  const entries: Entry[] = []; const ops = await page.getOperatorList(); const viewport = page.getViewport({ scale: 1 });
  let matrix = [1, 0, 0, 1, 0, 0]; const stack: number[][] = [];
  const add = async (object: any, index: number, transform: number[]) => {
    const coordinates = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => viewport.convertToViewportPoint(transform[0] * x + transform[2] * y + transform[4], transform[1] * x + transform[3] * y + transform[5]));
    const x = Math.min(...coordinates.map(point => point[0])); const y = Math.min(...coordinates.map(point => point[1])); const right = Math.max(...coordinates.map(point => point[0]));
    const asset = imageAsset(object);
    if (!asset) warnings.add("部分 PDF 图片编码暂不支持，保留图片位置");
    const key = "pdf:p" + number + ":image:" + index + ":" + entries.length;
    entries.push({ x, y, right, size: 0, bold: false, native: index,
      block: { sourceBlockKey: key, sourceOrder: 0, type: "image", text: "", payload: { alt: "", ...(asset ? { width: object.width, height: object.height } : { missingReason: "UNSUPPORTED_PDF_IMAGE" }) },
        sourceLocator: { format: "pdf", sourceHash, pageNumber: number, elementPath: key }, asset } });
  };
  for (let index = 0; index < ops.fnArray.length; index++) {
    const fn = ops.fnArray[index]; const args = ops.argsArray[index] ?? [];
    if (fn === pdfjs.OPS.save) stack.push([...matrix]);
    else if (fn === pdfjs.OPS.restore) matrix = stack.pop() ?? matrix;
    else if (fn === pdfjs.OPS.transform) matrix = pdfjs.Util.transform(matrix, args);
    else if ([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageXObjectRepeat].includes(fn)) {
      try {
        const object = typeof args[0] === "string" ? await new Promise<any>(resolve => (args[0].startsWith("g_") ? page.commonObjs : page.objs).get(args[0], resolve)) : args[0];
        if (fn === pdfjs.OPS.paintImageXObjectRepeat) {
          for (let i = 0; i < args[3].length; i += 2) await add(object, index, pdfjs.Util.transform(matrix, [args[1], 0, 0, args[2], args[3][i], args[3][i + 1]]));
        } else await add(object, index, matrix);
      } catch { warnings.add("部分 PDF 图片提取失败，保留图片位置"); await add(undefined, index, matrix); }
    }
  }
  return entries;
}

function imageAsset(image: any): ParsedBlock["asset"] | undefined {
  if (!image?.data || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0 || image.width * image.height > 40_000_000) return undefined;
  const data: Uint8Array = image.data; const pixels = image.width * image.height; const png = new PNG({ width: image.width, height: image.height });
  if (image.kind === 1) {
    const stride = Math.ceil(image.width / 8);
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) { const value = data[y * stride + (x >> 3)] & (128 >> (x % 8)) ? 255 : 0; const index = (y * image.width + x) * 4; png.data.set([value, value, value, 255], index); }
  } else if (image.kind === 2 || data.length === pixels * 3) {
    for (let i = 0; i < pixels; i++) { png.data[i * 4] = data[i * 3]; png.data[i * 4 + 1] = data[i * 3 + 1]; png.data[i * 4 + 2] = data[i * 3 + 2]; png.data[i * 4 + 3] = 255; }
  } else if (data.length === pixels * 4) png.data.set(data); else return undefined;
  return { bytes: PNG.sync.write(png), extension: "png", mimeType: "image/png" };
}
