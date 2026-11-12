import type { ExploreEdge, ExploreNode } from './platform'

export type ReplyKind = 'deepens' | 'related' | 'branch'
export const nodeId = (node: ExploreNode) => node.nodeId || node.id
export const isConversation = (node: ExploreNode) => node.kind !== 'note'

/** Association edges are cross-links; only ownership edges define prompt ancestry. */
export function conversationParents(nodes: ExploreNode[], edges: ExploreEdge[]) {
  const ids = new Set(nodes.map(nodeId))
  const parents = new Map<string, string>()
  for (const node of nodes) {
    if (node.parentNodeId && ids.has(node.parentNodeId)) parents.set(nodeId(node), node.parentNodeId)
  }
  for (const edge of edges) {
    if (edge.kind !== 'related' && ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)) {
      parents.set(edge.toNodeId, edge.fromNodeId)
    }
  }
  return parents
}

export function conversationPath(nodes: ExploreNode[], edges: ExploreEdge[], activeId: string) {
  const byId = new Map(nodes.map(node => [nodeId(node), node]))
  const parents = conversationParents(nodes, edges)
  const path: ExploreNode[] = []
  const seen = new Set<string>()
  let current = byId.get(activeId)
  while (current && !seen.has(nodeId(current))) {
    const id = nodeId(current)
    seen.add(id)
    if (isConversation(current)) path.unshift(current)
    current = byId.get(parents.get(id) ?? '')
  }
  return path
}

export function latestConversationId(nodes: ExploreNode[]) {
  const latest = [...nodes].filter(isConversation)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    .at(-1)
  return latest ? nodeId(latest) : ''
}

/** Each endpoint represents one selectable history; hidden legacy notes are retained. */
export function conversationLeaves(nodes: ExploreNode[], edges: ExploreEdge[]) {
  const ancestors = new Set<string>()
  for (const node of nodes.filter(isConversation)) {
    for (const ancestor of conversationPath(nodes, edges, nodeId(node)).slice(0, -1)) ancestors.add(nodeId(ancestor))
  }
  return nodes.filter(node => isConversation(node) && !ancestors.has(nodeId(node)))
}
