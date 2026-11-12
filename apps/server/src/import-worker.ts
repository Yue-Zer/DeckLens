import { createCore } from "@decklens/core";

type Task = { kind: "import"; path: string; originalName: string; forceReparse: boolean } | { kind: "reparse"; documentId: string };

// This private process shares the exact core and data directory with the local server.
// Parsing and indexing can use CPU without blocking HTTP or rendering the reader.
if (!process.send || !process.argv[2]) throw new Error("解析进程只能由 DeckLens 本地服务启动。");

process.once("disconnect", () => process.exit(1));
process.once("message", async (task: Task) => {
  let core: ReturnType<typeof createCore> | undefined;
  let reply: unknown;
  try {
    let lastProgress = 0;
    core = createCore(process.argv[2], { onImportProgress: event => {
      const progress = Math.max(lastProgress, event.progress); lastProgress = progress;
      process.send?.({ kind: "progress", progress, message: event.message });
    } });
    const result = task.kind === "import"
      ? await core.documents.importFile(task.path, { originalName: task.originalName, forceReparse: task.forceReparse })
      : await core.documents.reparse(task.documentId);
    reply = { ok: true, result: { document: result.document, duplicate: result.duplicate } };
  } catch (error) {
    const details = error as { code?: string; message?: string };
    reply = { ok: false, error: { code: details.code || "IMPORT_FAILED", message: details.message || "文档解析失败。" } };
  } finally {
    await core?.storage.close();
  }
  process.send!(reply, () => process.exit(0));
});
