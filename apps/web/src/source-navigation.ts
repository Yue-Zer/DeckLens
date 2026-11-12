import type { ContentBlock } from './platform'

// Version IDs change on reparse. Only reuse a location when both its immutable
// source and extracted content still match, and there is exactly one candidate.
export function resolveSourceBlock(source: ContentBlock, current: ContentBlock[]): ContentBlock | undefined {
  const direct = current.find(block => block.id === source.id)
  if (direct) return direct
  const locator = source.sourceLocator ?? source.locator
  if (!source.sourceBlockKey || !locator?.sourceHash) return undefined
  const matches = current.filter(block => {
    const position = block.sourceLocator ?? block.locator
    return block.sourceBlockKey === source.sourceBlockKey
      && position?.sourceHash === locator.sourceHash
      && position?.pageNumber === locator.pageNumber
      && position?.slideNumber === locator.slideNumber
      && block.type === source.type
      && (block.plainText ?? block.text ?? '') === (source.plainText ?? source.text ?? '')
  })
  return matches.length === 1 ? matches[0] : undefined
}
