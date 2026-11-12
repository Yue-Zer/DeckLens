import type { LearningArticle, LearningArticleSection } from '@decklens/contracts'
import type { ContentBlock } from './platform'

/** Rendered article IDs remain distinct from the original blocks cited by each paragraph. */
export function articleContentBlocks(article: LearningArticle | null): ContentBlock[] {
  if (!article || article.status !== 'ready') return []
  const result: ContentBlock[] = []
  function addFigure(figure: LearningArticleSection['figures'][number], sectionId: string) {
    result.push({ id: figure.id, sectionId, type: 'image', text: figure.caption, payload: { assetId: figure.assetId, sourceBlockIds: [figure.blockId], sourceBlockId: figure.blockId } })
  }
  function visit(sections: LearningArticleSection[]) {
    for (const section of sections) {
      for (const figure of section.figures.filter(item => !item.afterParagraphId)) addFigure(figure, section.id)
      for (const paragraph of section.paragraphs) {
        result.push({ id: paragraph.id, sectionId: section.id, type: 'paragraph', text: paragraph.text, plainText: paragraph.text, payload: { sourceBlockIds: paragraph.sources.map(source => source.blockId) } })
        for (const figure of section.figures.filter(item => item.afterParagraphId === paragraph.id)) addFigure(figure, section.id)
      }
      visit(section.children)
    }
  }
  visit(article.sections)
  return result
}
