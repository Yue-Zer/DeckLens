import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { fork, spawn } from "node:child_process";
import { homedir } from "node:os";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { createCore } from "@decklens/core";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_PORT = 4173;
const localHostnames = new Set(["127.0.0.1", "localhost"]);
const providerInput = z.object({
  provider: z.enum(["openai-compatible", "ollama"]),
  baseUrl: z.string().url().max(2000).refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "模型地址应为不含密钥、查询参数或凭证的 HTTP/HTTPS 基础地址。"),
  model: z.string().min(1).max(300),
}).strict();
const providerProfileInput = z.object({
  name: z.string().trim().min(1).max(100),
  providerKind: z.enum(["openai-compatible", "deepseek", "ollama", "anthropic", "custom"]),
  protocol: z.enum(["openai-chat", "ollama-chat", "anthropic-messages"]),
  baseUrl: z.string().url().max(2000).refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "模型地址应为不含密钥、查询参数或凭证的 HTTP/HTTPS 基础地址。"),
  model: z.string().trim().max(300),
  timeoutMs: z.number().int().min(1000).max(600000),
  supportsStreaming: z.boolean(),
  supportsVision: z.boolean(),
  apiKey: z.string().max(1000).optional(),
  activate: z.boolean().optional(),
}).strict();
const modelMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([
    z.string().max(100000),
    z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string().max(100000) }).strict(),
      z.object({ type: z.literal("image"), dataUrl: z.string().max(1500000) }).strict(),
    ])).max(12),
  ]),
}).strict();

type ImportJob = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: { code: string; message: string };
  documents?: unknown[];
  errors?: Array<{ name: string; message: string }>;
  cancelRequested?: boolean;
};

type Core = ReturnType<typeof createCore>;
type ImportTask = { kind: "import"; path: string; originalName: string; forceReparse: boolean } | { kind: "reparse"; documentId: string };
type WorkerResult = { document: ReturnType<Core["documents"]["get"]>; duplicate: boolean };

export type ServerOptions = {
  dataDir?: string;
  staticDir?: string;
  port?: number;
  strictPort?: boolean;
  core?: Core;
};

export type StartedServer = { app: Express; server: Server; port: number; dataDir: string; core: Core };

function defaultDataDir() {
  if (process.env.DECKLENS_DATA_DIR) return resolve(process.env.DECKLENS_DATA_DIR);
  if (process.platform === "win32") return resolve(process.env.LOCALAPPDATA || process.env.APPDATA || resolve(homedir(), "AppData", "Local"), "DeckLens");
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Application Support", "DeckLens");
  return resolve(process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share"), "decklens");
}

function validateDataDir(dataDir: string) {
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const fromSource = relative(sourceRoot, dataDir);
  if (fromSource === "" || (fromSource !== ".." && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource))) {
    throw Object.assign(new Error("本地数据目录不能位于 DeckLens 源码仓库内。请将 DECKLENS_DATA_DIR 设置为仓库外的私人目录，或移除此变量以使用系统用户数据目录。"), { code: "DATA_DIR_IN_SOURCE" });
  }
}

function hostName(hostHeader: string | undefined) {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isTrustedOrigin(origin: string, requestHost: string, port?: number) {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || !localHostnames.has(parsed.hostname.toLowerCase())) return false;
    const ownOrigin = `http://${requestHost}`;
    if (origin === ownOrigin) return true;
    const configured = (process.env.DECKLENS_ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
      .split(",").map(value => value.trim()).filter(Boolean);
    return configured.includes(origin) && port !== undefined;
  } catch {
    return false;
  }
}

function localRequestGuard(port?: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.get("host");
    if (!localHostnames.has(hostName(host) || "")) return res.status(403).json({ error: { code: "HOST_REJECTED", message: "仅允许通过本机地址访问 DeckLens。" } });

    const site = req.get("sec-fetch-site");
    if (site === "cross-site") return res.status(403).json({ error: { code: "ORIGIN_REJECTED", message: "已拒绝来自其他网站的请求。" } });

    const origin = req.get("origin");
    if (origin && !isTrustedOrigin(origin, host!, port)) return res.status(403).json({ error: { code: "ORIGIN_REJECTED", message: "请求来源不受信任。" } });
    if (req.path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !origin) {
      return res.status(403).json({ error: { code: "ORIGIN_REQUIRED", message: "写入请求必须来自 DeckLens 本地页面。" } });
    }
    next();
  };
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown> | unknown) {
  return (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res)).catch(next);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "本地服务处理失败。";
}

function errorDetails(error: unknown) {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "MODEL_REQUEST_FAILED";
  return { code, message: errorMessage(error) };
}

function cleanFileName(value: string) {
  // Multipart sends UTF-8 names; Busboy's default header decoding is Latin-1.
  // Decode only a reversible UTF-8 byte sequence, leaving already-correct names alone.
  let decoded = value;
  if ([...value].every(character => character.charCodeAt(0) <= 255)) {
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "latin1")); } catch { /* Original name was not UTF-8 bytes. */ }
  }
  return decoded.replace(/[\\/\0]/g, "_").slice(0, 240) || "document";
}

function updateJob(job: ImportJob, update: Partial<ImportJob>) {
  Object.assign(job, update, { updatedAt: new Date().toISOString() });
}

async function launchEditor(filePath: string): Promise<void> {
  const [command, args] = process.platform === "win32"
    ? ["notepad.exe", [filePath]]
    : process.platform === "darwin" ? ["open", ["-t", filePath]] : ["xdg-open", [filePath]];
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => reject(Object.assign(new Error("无法启动系统文本编辑器。请手工编辑 DeckLens 用户数据目录中的 config/secrets.json，或安装可用的系统文本编辑器后重试。"), { code: "SECRET_EDITOR_UNAVAILABLE" })));
    child.once("spawn", () => { child.unref(); resolveLaunch(); });
  });
}

function publicSettings(core: Core) {
  const settings = core.settings.getPublic();
  return { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, keyConfigured: settings.hasApiKey };
}

function imageContentType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  // Active document formats such as SVG are downloaded instead of executed on this origin.
  return "application/octet-stream";
}

function runImportWorker(dataDir: string, task: ImportTask, onProgress?: (event: { progress: number; message: string }) => void): Promise<WorkerResult> {
  return new Promise((resolveResult, reject) => {
    const workerUrl = new URL(import.meta.filename.endsWith(".ts") ? "./import-worker.ts" : "./import-worker.js", import.meta.url);
    const child = fork(workerUrl, [dataDir], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    let settled = false;
    child.once("error", error => { settled = true; reject(error); });
    child.on("message", (message: unknown) => {
      if (settled || !message || typeof message !== "object") return;
      const result = message as { kind?: string; progress?: number; message?: string; ok?: boolean; result?: WorkerResult; error?: { code?: string; message?: string } };
      if (result.kind === "progress") {
        if (typeof result.progress === "number" && typeof result.message === "string") onProgress?.({ progress: result.progress, message: result.message });
        return;
      }
      settled = true;
      if (result.ok && result.result) resolveResult(result.result);
      else reject(Object.assign(new Error(result.error?.message || "解析子进程处理失败。"), { code: result.error?.code || "PARSER_FAILED" }));
    });
    child.once("exit", code => {
      if (!settled) { settled = true; reject(Object.assign(new Error(`解析子进程意外退出（${code ?? "终止"}）。`), { code: "PARSER_EXITED" })); }
    });
    child.send(task);
  });
}

export function createServer(options: ServerOptions = {}) {
  const portForChecks = options.port ?? Number(process.env.DECKLENS_PORT || DEFAULT_PORT);
  if (!Number.isInteger(portForChecks) || portForChecks < 0 || portForChecks > 65535) throw new Error("DECKLENS_PORT 必须是 0 到 65535 之间的整数。");
  const dataDir = resolve(options.dataDir || defaultDataDir());
  validateDataDir(dataDir);
  if (options.core) validateDataDir(resolve(options.core.dataDir));
  const core = options.core || createCore(dataDir);
  const app = express();
  const jobs = new Map<string, ImportJob>();
  const uploadRoot = resolve(dataDir, "tmp", "imports");
  let importQueue: Promise<void> = Promise.resolve();
  const enqueueImport = (task: () => Promise<void>) => {
    const pending = importQueue.then(task, task);
    importQueue = pending.catch(() => undefined);
    return pending;
  };

  app.disable("x-powered-by");
  app.use((_req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); next(); });
  app.use(localRequestGuard(portForChecks));
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.use(express.json({ limit: "2mb" }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => {
        mkdir(uploadRoot, { recursive: true }).then(() => callback(null, uploadRoot), error => callback(error as Error, ""));
      },
      filename: (_req, file, callback) => callback(null, `${randomUUID()}${extname(cleanFileName(file.originalname)).slice(0, 16)}`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 20, fields: 4, parts: 24 },
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true, product: "DeckLens" }));
  app.get("/api/capabilities", (_req, res) => res.json({ formats: ["pdf", "docx", "pptx", "md", "markdown", "txt"], maxUploadBytes: MAX_UPLOAD_BYTES, aiConfigured: Boolean(core.settings.getPublic().hasApiKey || core.settings.getPublic().provider === "ollama"), modelConfigured: Boolean(core.settings.getPublic().model) }));

  app.post("/api/imports", upload.array("files", 20), asyncRoute(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    if (!files.length) return res.status(400).json({ error: { code: "FILE_REQUIRED", message: "请选择要导入的文档。" } });
    const forceReparse = req.body?.forceReparse === "true";
    const job: ImportJob = {
      id: randomUUID(), status: "queued", progress: 0, message: `等待解析 ${files.length} 个文件`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), documents: [], errors: [],
    };
    jobs.set(job.id, job);
    res.status(202).json({ jobId: job.id, statusUrl: `/api/imports/${job.id}` });
    enqueueImport(async () => {
      updateJob(job, { status: "processing", progress: 1, message: "识别文件并解析结构" });
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (job.cancelRequested) break;
        try {
          const result = await runImportWorker(dataDir, { kind: "import", path: file.path, originalName: cleanFileName(file.originalname), forceReparse }, event => {
            updateJob(job, { progress: Math.max(job.progress, Math.min(99, Math.floor((index * 100 + event.progress) / files.length))), message: cleanFileName(file.originalname) + " · " + event.message });
          });
          job.documents!.push({ ...result.document, duplicate: result.duplicate });
        } catch (error) {
          job.errors!.push({ name: cleanFileName(file.originalname), message: errorMessage(error) });
        } finally {
          await unlink(file.path).catch(() => undefined);
        }
        updateJob(job, { progress: Math.round(((index + 1) / files.length) * 100), message: `已处理 ${index + 1}/${files.length} 个文件` });
      }
      const allFailed = job.documents!.length === 0;
      updateJob(job, { status: job.cancelRequested ? "cancelled" : allFailed ? "failed" : "completed", progress: 100, message: job.cancelRequested ? "导入已取消" : allFailed ? "所有文件均未能导入" : "导入完成", error: allFailed ? { code: "IMPORT_FAILED", message: job.errors!.map(item => `${item.name}: ${item.message}`).join("\n") } : undefined });
      for (const file of files) await unlink(file.path).catch(() => undefined);
    });
  }));

  app.get("/api/imports/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: { code: "JOB_NOT_FOUND", message: "导入任务不存在或服务已重启。" } });
    res.json(job);
  });
  app.delete("/api/imports/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: { code: "JOB_NOT_FOUND", message: "导入任务不存在。" } });
    if (job.status === "queued" || job.status === "processing") updateJob(job, { cancelRequested: true, message: "已请求取消；当前解析器完成后停止后续处理。" });
    res.json(job);
  });

  app.get("/api/folders", (_req, res) => res.json(core.folders.list()));
  app.post("/api/folders", asyncRoute((req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(100), parentId: z.string().uuid().nullable().optional() }).strict().parse(req.body);
    res.status(201).json(core.folders.create(body.name, body.parentId ?? null));
  }));
  app.put("/api/documents/:id/folder", asyncRoute((req, res) => {
    const body = z.object({ folderId: z.string().uuid().nullable() }).strict().parse(req.body);
    core.folders.moveDocument(req.params.id, body.folderId);
    res.status(204).end();
  }));
  app.get("/api/documents", (_req, res) => res.json(core.documents.list()));
  app.get("/api/documents/:id", asyncRoute(async (req, res) => res.json(await core.documents.get(req.params.id))));
  app.delete("/api/documents/:id", asyncRoute(async (req, res) => { await enqueueImport(async () => { await core.documents.delete(req.params.id); }); res.status(204).end(); }));
  app.post("/api/documents/:id/reparse", asyncRoute(async (req, res) => {
    // Validate before accepting work; a missing document is a regular 404.
    core.documents.get(req.params.id);
    const job: ImportJob = { id: randomUUID(), status: "queued", progress: 0, message: "等待重新解析文档", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    jobs.set(job.id, job);
    res.status(202).json({ jobId: job.id });
    enqueueImport(async () => {
      if (job.cancelRequested) { updateJob(job, { status: "cancelled", progress: 100, message: "重新解析已取消" }); return; }
      updateJob(job, { status: "processing", progress: 10, message: "重新解析文档" });
      try {
        const result = await runImportWorker(dataDir, { kind: "reparse", documentId: req.params.id }, event => updateJob(job, { progress: Math.max(job.progress, event.progress), message: event.message }));
        updateJob(job, { status: job.cancelRequested ? "cancelled" : "completed", progress: 100, message: job.cancelRequested ? "当前解析已完成并保存，重新解析任务已结束" : "重新解析完成", result, documents: [result.document], errors: [] });
      } catch (error) {
        updateJob(job, { status: "failed", progress: 100, message: "重新解析失败", error: { code: "REPARSE_FAILED", message: errorMessage(error) }, errors: [{ name: req.params.id, message: errorMessage(error) }] });
      }
    });
  }));
  app.get("/api/documents/:id/tree", asyncRoute(async (req, res) => res.json(await core.documents.tree(req.params.id))));
  app.get("/api/documents/:id/learning-article", asyncRoute(async (req, res) => {
    core.documents.get(z.string().min(1).max(128).parse(req.params.id));
    res.json(core.learningArticles.get(req.params.id));
  }));
  app.post("/api/documents/:id/learning-article/generate", asyncRoute(async (req, res) => {
    const documentId = z.string().min(1).max(128).parse(req.params.id);
    core.documents.get(documentId);
    const body = z.object({ force: z.boolean().optional(), language: z.string().min(1).max(32).optional() }).strict().parse(req.body ?? {});
    if (core.learningArticles.get(documentId)?.status === "generating") {
      res.status(409).json({ error: { code: "ARTICLE_GENERATION_IN_PROGRESS", message: "这份文档的学习文章正在生成。" } });
      return;
    }
    void core.learningArticles.generate(documentId, body).catch(() => { console.error("学习文章任务启动失败。"); });
    res.status(202).json(core.learningArticles.get(documentId));
  }));
  app.patch("/api/documents/:id/sections", asyncRoute(async (req, res) => {
    const edit = z.object({
      operation: z.enum(["rename", "move", "reorder", "split", "merge"]),
      sectionId: z.string().min(1), title: z.string().max(500).optional(), parentId: z.string().nullable().optional(), parentSectionId: z.string().nullable().optional(),
      order: z.number().int().nonnegative().optional(), displayOrder: z.number().int().nonnegative().optional(), splitAtBlockId: z.string().optional(), blockId: z.string().optional(), targetSectionId: z.string().optional(), splitOffset: z.number().int().nonnegative().optional(), newTitle: z.string().max(500).optional(),
    }).strict();
    const body = z.object({ edits: z.array(edit).min(1).max(500) }).strict().parse(req.body);
    const edits = body.edits.map(item => ({ ...item, parentSectionId: item.parentSectionId ?? item.parentId, displayOrder: item.displayOrder ?? item.order, blockId: item.blockId ?? item.splitAtBlockId }));
    await (core as any).sections.applyEdits(req.params.id, edits);
    res.json(await core.documents.tree(req.params.id));
  }));
  app.get("/api/documents/:id/blocks", asyncRoute(async (req, res) => {
    const query = z.object({ sectionId: z.string().optional(), offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    res.json(await core.documents.blocks(req.params.id, query));
  }));
  app.get("/api/blocks/:blockId", asyncRoute(async (req, res) => {
    res.json(await core.documents.block(z.string().min(1).max(128).parse(req.params.blockId)));
  }));
  app.get("/api/documents/:id/terms", asyncRoute(async (req, res) => res.json(await core.terms.list(req.params.id))));
  app.get("/api/documents/:id/annotations", asyncRoute(async (req, res) => {
    res.json(core.annotations.list(z.string().min(1).max(128).parse(req.params.id)));
  }));
  app.post("/api/annotations", asyncRoute(async (req, res) => {
    const point = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict();
    const body = z.object({
      documentId: z.string().min(1).max(128), tool: z.enum(["pen", "highlighter", "lasso"]),
      targets: z.array(z.object({ blockId: z.string().min(1).max(128), shape: z.enum(["path", "polygon"]), points: z.array(point).min(2).max(10000), strokeRatio: z.number().finite().gt(0).max(0.05) }).strict()).min(1).max(500),
    }).strict().parse(req.body);
    res.status(201).json(core.annotations.create(body));
  }));
  app.delete("/api/annotations/:annotationId", asyncRoute(async (req, res) => {
    core.annotations.delete(z.string().min(1).max(128).parse(req.params.annotationId));
    res.status(204).end();
  }));
  app.delete("/api/documents/:id/annotations", asyncRoute(async (req, res) => {
    core.annotations.clear(z.string().min(1).max(128).parse(req.params.id));
    res.status(204).end();
  }));
  const serveAsset = asyncRoute(async (req, res) => {
    const assetIdOrPath = z.string().min(1).max(1024).parse(req.params.assetId || req.query.path);
    const bytes = await core.documents.asset(assetIdOrPath);
    res.setHeader("Cache-Control", "private, max-age=3600");
    const contentType = imageContentType(bytes);
    if (contentType === "application/octet-stream") res.setHeader("Content-Disposition", "attachment");
    res.type(contentType).send(bytes);
  });
  app.get("/api/assets", serveAsset);
  app.get("/api/assets/:assetId", serveAsset);

  app.get("/api/terms/:termId", asyncRoute(async (req, res) => {
    res.json(await (core as any).terms.getById(req.params.termId));
  }));
  app.post("/api/terms/:termId/explain", asyncRoute(async (req, res) => {
    res.json(await core.terms.explain(z.string().min(1).max(128).parse(req.params.termId)));
  }));

  app.get("/api/explore/nodes", asyncRoute(async (req, res) => {
    const query = z.object({ documentId: z.string().min(1), chatId: z.string().optional() }).parse(req.query);
    const [nodes, edges] = await Promise.all([
      core.exploration.listNodes(query.documentId, query.chatId),
      (core.exploration as any).listEdges(query.documentId, query.chatId),
    ]);
    res.json({ nodes, edges });
  }));
  app.post("/api/explore/nodes", asyncRoute(async (req, res) => {
    const body = z.object({
      documentId: z.string().min(1), chatId: z.string().optional(), parentNodeId: z.string().nullable().optional(),
      kind: z.enum(["qa", "explanation", "note", "deepening", "deepens", "branch", "related"]).optional(), title: z.string().max(300).optional(), question: z.string().max(10000).optional(),
      sourceBlockId: z.string().optional(), sourceVersionId: z.string().optional(), selectedText: z.string().max(20000).optional(), contextNodeId: z.string().optional(), startOffset: z.number().int().nonnegative().optional(), endOffset: z.number().int().nonnegative().optional(),
      branchKind: z.enum(["deepens", "branch", "related"]).optional(), termId: z.string().min(1).max(128).optional(), context: z.record(z.string(), z.unknown()).optional(),
    }).strict().parse(req.body);
    const { kind, selectedText, contextNodeId, sourceBlockId, sourceVersionId, startOffset, endOffset, ...rest } = body;
    const requestedKind = kind === "deepening" || kind === "deepens" || kind === "branch" || kind === "related" ? "qa" : kind ?? "qa";
    const activeProvider = core.providers.getActive();
    const providerReady = Boolean(activeProvider?.model && (activeProvider.hasApiKey || activeProvider.protocol === "ollama-chat"));
    if (requestedKind !== "note" && !providerReady) {
      throw Object.assign(new Error("请先在模型设置中配置并启用可用的 AI 服务。未配置模型时，只能创建本地笔记节点。"), { code: "MODEL_NOT_CONFIGURED" });
    }
    const normalizedKind = kind === "deepening" || kind === "deepens" || kind === "branch" || kind === "related" ? "qa" : kind;
    const branchKind = body.branchKind || (kind === "deepening" || kind === "deepens" ? "deepens" : kind === "branch" || kind === "related" ? kind : undefined);
    const node = await core.exploration.createNode({ ...rest, parentNodeId: rest.parentNodeId ?? undefined, kind: normalizedKind || "qa", title: rest.title || rest.question || "新的探索", branchKind, anchor: sourceBlockId ? { blockId: sourceBlockId, startOffset, endOffset, quote: selectedText } : undefined, context: { ...rest.context, selectedText, contextNodeId, sourceVersionId } });
    res.status(201).json(node);
  }));
  app.get("/api/explore/nodes/:nodeId/children", asyncRoute(async (req, res) => {
    const parent = await core.exploration.getNode(req.params.nodeId) as any;
    const allNodes = await core.exploration.listNodes(parent.documentId, parent.chatId);
    res.json(allNodes.filter((node: any) => node.parentNodeId === req.params.nodeId));
  }));
  app.get("/api/explore/nodes/:nodeId", asyncRoute(async (req, res) => res.json(await core.exploration.getNode(req.params.nodeId))));
  app.patch("/api/explore/nodes/:nodeId", asyncRoute(async (req, res) => {
    const body = z.object({ title: z.string().max(300).optional(), question: z.string().max(10000).optional(), answer: z.string().max(100000).optional() }).strict().parse(req.body);
    res.json(await core.exploration.updateNode(req.params.nodeId, body));
  }));
  app.delete("/api/explore/nodes/:nodeId", asyncRoute(async (req, res) => { await core.exploration.deleteNode(req.params.nodeId); res.status(204).end(); }));
  app.post("/api/explore/edges", asyncRoute(async (req, res) => {
    const body = z.object({ chatId: z.string().min(1).optional(), fromNodeId: z.string().min(1), toNodeId: z.string().min(1), kind: z.enum(["deepens", "branch", "related"]), label: z.string().max(300).optional() }).strict().parse(req.body);
    const source = body.chatId ? undefined : await core.exploration.getNode(body.fromNodeId) as any;
    const chatId = body.chatId || source?.chatId;
    const existing = (await core.exploration.listEdges(source?.documentId || (await core.exploration.getNode(body.toNodeId) as any).documentId, chatId)).find((edge: any) => edge.fromNodeId === body.fromNodeId && edge.toNodeId === body.toNodeId && edge.kind === body.kind);
    res.status(existing ? 200 : 201).json(existing || await core.exploration.addEdge({ ...body, chatId }));
  }));
  app.delete("/api/explore/branches/:nodeId", asyncRoute(async (req, res) => { await core.exploration.deleteBranch(req.params.nodeId); res.status(204).end(); }));
  app.get("/api/explore/state/:chatId", asyncRoute(async (req, res) => {
    const viewId = z.string().max(100).optional().parse(req.query.viewId);
    res.json(await core.exploration.getState(req.params.chatId, viewId) ?? null);
  }));
  app.put("/api/explore/state/:chatId", asyncRoute(async (req, res) => {
    const state = z.object({ viewId: z.string().max(100).optional(), activeNodeId: z.string().max(128).optional(), activeVersionId: z.string().max(128).optional(), activeBlockId: z.string().max(128).optional(), textOffset: z.number().int().nonnegative().optional(), scrollAnchor: z.string().max(500).optional(), expandedNodes: z.array(z.string().max(128)).max(10000).optional(), branchChoices: z.record(z.string(), z.string().max(128)).optional(), floatingCards: z.object({ openNodeIds: z.array(z.string().min(1).max(128)).max(1000), activeCardId: z.string().min(1).max(128).optional(), cardScrollOffsets: z.record(z.string().min(1).max(128), z.number().finite().nonnegative().max(10000000)).optional() }).strict().optional() }).strict().parse(req.body);
    await core.exploration.saveState(req.params.chatId, state);
    res.status(204).end();
  }));

  app.get("/api/chats", asyncRoute(async (req, res) => {
    const documentId = z.string().min(1).parse(req.query.documentId);
    res.json(await core.chat.list(documentId));
  }));
  app.post("/api/chats", asyncRoute(async (req, res) => {
    const body = z.object({ documentId: z.string().min(1), title: z.string().max(300).optional() }).strict().parse(req.body);
    res.status(201).json(await core.chat.create(body.documentId, body.title));
  }));
  app.get("/api/chats/:chatId/messages", asyncRoute(async (req, res) => res.json(await (core.chat as any).messages(req.params.chatId))));
  app.post("/api/chats/:chatId/messages", asyncRoute(async (req, res) => {
    const body = z.object({ documentId: z.string().min(1), question: z.string().min(1).max(10000), parentNodeId: z.string().optional(), sourceBlockId: z.string().optional(), selectedText: z.string().max(20000).optional(), anchor: z.object({ blockId: z.string().min(1), startOffset: z.number().int().nonnegative().optional(), endOffset: z.number().int().nonnegative().optional() }).optional(), branchKind: z.enum(["deepens", "branch", "related"]).optional() }).strict().parse(req.body);
    res.json(await core.chat.ask({ ...body, chatId: req.params.chatId, anchor: body.anchor || (body.sourceBlockId ? { blockId: body.sourceBlockId } : undefined) }));
  }));
  app.post("/api/ask", asyncRoute(async (req, res) => {
    const body = z.object({ documentId: z.string().min(1), question: z.string().min(1).max(10000), chatId: z.string().optional(), nodeId: z.string().optional(), parentNodeId: z.string().optional(), contextNodeId: z.string().optional(), selectedText: z.string().max(60000).optional(), context: z.record(z.string(), z.unknown()).optional(), images: z.array(z.object({ blockId: z.string().min(1).max(128), assetId: z.string().min(1).max(128) }).strict()).max(4).optional(), mode: z.enum(["local", "global", "deepen", "branch", "related"]).optional(), branchKind: z.enum(["deepens", "branch", "related"]).optional(), anchor: z.object({ blockId: z.string().min(1), startOffset: z.number().int().nonnegative().optional(), endOffset: z.number().int().nonnegative().optional() }).optional(), sourceBlockId: z.string().optional(), sourceVersionId: z.string().optional(), startOffset: z.number().int().nonnegative().optional(), endOffset: z.number().int().nonnegative().optional() }).strict().parse(req.body);
    const { mode, branchKind, sourceBlockId, sourceVersionId, startOffset, endOffset, nodeId: _nodeId, contextNodeId: _contextNodeId, ...rest } = body;
    const edgeKind = branchKind || (mode === "deepen" ? "deepens" : mode === "branch" || mode === "related" ? mode : undefined);
    const answer = await core.chat.ask({ ...rest, anchor: body.anchor || (sourceBlockId ? { blockId: sourceBlockId, startOffset, endOffset } : undefined), branchKind: edgeKind });
    res.json(answer);
  }));

  app.get("/api/providers", (_req, res) => {
    const profiles = core.providers.list();
    res.json({ profiles, activeId: profiles.find(profile => profile.active)?.id ?? null });
  });
  app.post("/api/providers", asyncRoute(async (req, res) => {
    res.status(201).json(core.providers.save(providerProfileInput.parse(req.body)));
  }));
  app.put("/api/providers/:profileId", asyncRoute(async (req, res) => {
    const body = providerProfileInput.parse(req.body);
    res.json(core.providers.save({ ...body, id: req.params.profileId }));
  }));
  app.delete("/api/providers/:profileId", (req, res, next) => {
    try { core.providers.remove(req.params.profileId); res.status(204).end(); } catch (error) { next(error); }
  });
  app.post("/api/providers/:profileId/activate", asyncRoute(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.json(core.providers.activate(req.params.profileId));
  }));
  app.delete("/api/providers/:profileId/key", (req, res, next) => {
    try { core.providers.clearApiKey(req.params.profileId); res.status(204).end(); } catch (error) { next(error); }
  });
  app.post("/api/providers/:profileId/test", asyncRoute(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.json(await core.providers.test(req.params.profileId));
  }));
  app.post("/api/model/chat", asyncRoute(async (req, res) => {
    const body = z.object({
      profileId: z.string().min(1).max(80).optional(),
      messages: z.array(modelMessage).min(1).max(80),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).max(32000).optional(),
      stream: z.boolean().default(false),
    }).strict().parse(req.body);
    const request = { profileId: body.profileId, messages: body.messages, temperature: body.temperature, maxTokens: body.maxTokens };
    if (!body.stream) return res.json({ text: await core.providers.complete(request) });
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    try {
      for await (const text of core.providers.stream(request)) res.write(`event: token\ndata: ${JSON.stringify({ text })}\n\n`);
      res.write("event: done\ndata: {}\n\n");
      res.end();
    } catch (error) {
      const details = errorDetails(error);
      res.write(`event: error\ndata: ${JSON.stringify(details)}\n\n`);
      res.end();
    }
  }));

  app.get("/api/settings", (_req, res) => res.json(publicSettings(core)));
  app.put("/api/settings", asyncRoute(async (req, res) => {
    const body = providerInput.parse(req.body);
    await core.settings.saveProvider(body);
    res.json(publicSettings(core));
  }));
  app.put("/api/settings/provider", asyncRoute(async (req, res) => {
    const body = providerInput.parse(req.body);
    await core.settings.saveProvider(body);
    res.json(publicSettings(core));
  }));
  app.delete("/api/settings/secret", asyncRoute(async (_req, res) => {
    await core.settings.clearSecret();
    res.status(204).end();
  }));
  app.post("/api/settings/secret/open", asyncRoute(async (_req, res) => {
    z.object({}).strict().parse(_req.body ?? {});
    const secretPath = resolve(await core.settings.openSecretConfig());
    if (secretPath !== resolve(dataDir, "config", "secrets.json")) throw Object.assign(new Error("仅允许打开 DeckLens 的固定密钥配置文件。"), { code: "INVALID_SECRET_CONFIG" });
    // The UI receives status only; the actual path remains in the backend.
    await launchEditor(secretPath);
    res.status(202).json({ opened: true, instructions: "请在打开的本机编辑器中配置密钥，保存后返回此页。" });
  }));
  app.post("/api/settings/secret/clear", asyncRoute(async (_req, res) => {
    await core.settings.clearSecret();
    res.status(204).end();
  }));
  app.post("/api/settings/clear-data", asyncRoute(async (req, res) => {
    z.object({ confirm: z.literal("DELETE_LOCAL_DATA") }).strict().parse(req.body ?? {});
    await enqueueImport(async () => { await core.settings.clearData(); jobs.clear(); });
    res.status(204).end();
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: { code: "ROUTE_NOT_FOUND", message: "本地接口不存在。" } }));

  const staticDir = options.staticDir || resolve(import.meta.dirname, "../../web/dist");
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, fallthrough: true }));
    app.get("*", (_req, res, next) => res.sendFile(resolve(staticDir, "index.html"), error => error && next()));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const multerError = error instanceof multer.MulterError;
    const parseError = (error as { type?: string })?.type === "entity.parse.failed";
    const validationError = error instanceof z.ZodError;
    const coreCode = (error as { code?: string })?.code;
    const status = multerError ? error.code === "LIMIT_FILE_SIZE" ? 413 : 400 : validationError || parseError ? 400 : coreCode?.endsWith("_NOT_FOUND") || coreCode === "ASSET_MISSING" ? 404 : coreCode === "AI_NOT_CONFIGURED" || coreCode === "MODEL_NOT_CONFIGURED" ? 409 : coreCode === "PROVIDER_TIMEOUT" ? 504 : coreCode === "PROVIDER_PROTOCOL_RESERVED" || coreCode === "PROVIDER_STREAM_UNSUPPORTED" || coreCode === "MODEL_VISION_UNSUPPORTED" || coreCode === "MODEL_VISION_REJECTED" || coreCode === "PROVIDER_PARAMETER_UNSUPPORTED" ? 422 : coreCode === "SECRET_EDITOR_UNAVAILABLE" ? 503 : coreCode?.startsWith("INVALID_") || coreCode?.endsWith("_MISMATCH") ? 400 : 500;
    const code = multerError ? error.code : validationError || parseError ? "INVALID_REQUEST" : coreCode || "SERVER_ERROR";
    const message = multerError ? "文件超过 512 MiB 限制或上传字段无效。" : validationError ? "请求参数不符合接口要求。" : parseError ? "请求正文不是有效的 JSON。" : errorMessage(error);
    res.status(status).json({ error: { code, message } });
  });

  return { app, core, dataDir, port: portForChecks };
}

export async function startServer(options: ServerOptions = {}): Promise<StartedServer> {
  const instance = createServer(options);
  const port = instance.port;
  const listen = (targetPort: number) => new Promise<Server>((resolveServer, reject) => {
    const server = createHttpServer(instance.app);
    server.once("error", reject);
    server.listen(targetPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveServer(server);
    });
  });

  let server: Server;
  try {
    server = await listen(port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (options.strictPort) {
      await instance.core.storage.close();
      throw new Error(`本机端口 ${port} 已被占用。请关闭占用进程，或设置 DECKLENS_PORT 后重新启动前后端。`);
    }
    server = await listen(0);
  }
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { app: instance.app, server, port: actualPort, dataDir: instance.dataDir, core: instance.core };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  startServer({ strictPort: process.argv.includes("--strict-port") }).then(({ port }) => {
    process.stdout.write(`DeckLens local server: http://127.0.0.1:${port}\n`);
  }).catch(error => {
    process.stderr.write(`DeckLens server failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
