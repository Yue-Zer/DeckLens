import { randomUUID } from 'node:crypto';
import type { AnnotationRecord, CreateAnnotationInput, LearningArticle, LearningArticleSection } from '@decklens/contracts';
import type { SqliteDatabase } from './sqlite.js';

type Row = Record<string, unknown>;
export function createArticleAnnotations(db: SqliteDatabase, getArticle: (id: string) => LearningArticle | null) {
  function resolve(documentId: string, revision: string, targetIds?: string[]) {
    const article = getArticle(documentId);
    if (!article || article.status !== 'ready' || article.revision !== revision) {
      throw error('ARTICLE_REVISION_MISMATCH', '学习文章已更新或尚未就绪，请重新打开当前文章后再标注或提问。');
    }
    const targets = new Map<string, { id: string; text: string; sourceIds: string[]; image?: { blockId: string; assetId: string } }>();
    function visit(sections: LearningArticleSection[]) {
      for (const section of sections) {
        for (const paragraph of section.paragraphs) targets.set(paragraph.id, { id: paragraph.id, text: paragraph.text, sourceIds: paragraph.sources.map(source => source.blockId) });
        for (const figure of section.figures) targets.set(figure.id, { id: figure.id, text: figure.caption, sourceIds: [figure.blockId], image: { blockId: figure.blockId, assetId: figure.assetId } });
        visit(section.children);
      }
    }
    visit(article.sections);
    if (targetIds && (!targetIds.length || targetIds.some(id => !targets.has(id)))) throw error('INVALID_ARTICLE_TARGET', '圈选内容不属于当前学习文章。');
    return { article, targets: targetIds ? [...new Set(targetIds)].map(id => targets.get(id)!) : [...targets.values()] };
  }
  return {
    resolve,
    list(documentId: string, revision?: string): AnnotationRecord[] {
      const article = getArticle(documentId);
      if (!article || article.status !== 'ready' || (revision && article.revision !== revision)) return [];
      const rows = db.prepare('SELECT * FROM article_annotations WHERE document_id=? AND version_id=? AND article_revision=? ORDER BY created_at,annotation_id').all(documentId, article.documentVersionId, article.revision) as Row[];
      return rows.map(row => ({
        id: String(row.annotation_id), documentId, versionId: String(row.version_id), surface: 'article', articleRevision: article.revision,
        tool: row.tool as AnnotationRecord['tool'], createdAt: String(row.created_at),
        targets: (db.prepare('SELECT * FROM article_annotation_targets WHERE annotation_id=? ORDER BY target_order').all(row.annotation_id) as Row[]).map(target => ({
          blockId: String(target.target_id), shape: target.shape as 'path' | 'polygon', points: JSON.parse(String(target.points_json)), strokeRatio: Number(target.stroke_ratio),
        })),
      }));
    },
    create(input: CreateAnnotationInput): AnnotationRecord {
      if (!Array.isArray(input.targets) || !['pen', 'highlighter', 'lasso'].includes(input.tool) || !input.targets.length || input.targets.length > 500) throw error('INVALID_ANNOTATION', '标注工具或区域数量无效。');
      const { article } = resolve(input.documentId, input.articleRevision ?? '', input.targets.map(target => target.blockId));
      for (const target of input.targets) {
        if ((input.tool === 'lasso') !== (target.shape === 'polygon') || !['path', 'polygon'].includes(target.shape)
          || !Array.isArray(target.points) || target.points.length < (input.tool === 'lasso' ? 3 : 2) || target.points.length > 10000
          || !Number.isFinite(target.strokeRatio) || target.strokeRatio <= 0 || target.strokeRatio > 0.05
          || target.points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) throw error('INVALID_ANNOTATION', '文章标注的形状、点数、坐标或笔宽无效。');
      }
      const result: AnnotationRecord = { id: randomUUID(), documentId: input.documentId, versionId: article.documentVersionId, surface: 'article', articleRevision: article.revision, tool: input.tool, targets: input.targets, createdAt: new Date().toISOString() };
      db.transaction(() => {
        db.prepare('INSERT INTO article_annotations VALUES(?,?,?,?,?,?,?)').run(result.id, result.documentId, result.versionId, article.id, article.revision, input.tool, result.createdAt);
        const insert = db.prepare('INSERT INTO article_annotation_targets VALUES(?,?,?,?,?,?)');
        result.targets.forEach((target, index) => insert.run(result.id, index, target.blockId, target.shape, JSON.stringify(target.points), target.strokeRatio));
      })();
      return result;
    },
    delete(id: string) { return Boolean(db.prepare('DELETE FROM article_annotations WHERE annotation_id=?').run(id).changes); },
    clear(documentId: string, revision: string) {
      resolve(documentId, revision);
      db.prepare('DELETE FROM article_annotations WHERE document_id=? AND article_revision=?').run(documentId, revision);
    },
  };
}
function error(code: string, message: string) { return Object.assign(new Error(message), { code }); }
