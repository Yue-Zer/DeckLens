import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationLeaves, conversationPath, latestConversationId, nodeId } from '../apps/web/src/conversation.ts'
import type { ExploreEdge, ExploreNode } from '../apps/web/src/platform.ts'

const node = (id: string, options: Partial<ExploreNode> = {}): ExploreNode => ({ id, title: id, kind: 'qa', ...options })

test('conversation paths follow ownership without mixing related branches or local notes', () => {
  const nodes = [
    node('root'),
    node('left', { parentNodeId: 'root' }),
    node('right', { parentNodeId: 'root' }),
    node('note', { parentNodeId: 'left', kind: 'note' }),
    node('follow-up', { parentNodeId: 'note' }),
  ]
  const edges: ExploreEdge[] = [
    { id: 'ownership', fromNodeId: 'root', toNodeId: 'left', kind: 'deepens' },
    { id: 'association', fromNodeId: 'right', toNodeId: 'left', kind: 'related' },
  ]
  assert.deepEqual(conversationPath(nodes, edges, 'follow-up').map(nodeId), ['root', 'left', 'follow-up'])
  assert.deepEqual(conversationLeaves(nodes, edges).map(nodeId).sort(), ['follow-up', 'right'])
})

test('conversation navigation handles legacy node IDs, missing targets and malformed cycles', () => {
  const nodes = [node('legacy-a', { nodeId: 'a', parentNodeId: 'b' }), node('b', { parentNodeId: 'a' })]
  const path = conversationPath(nodes, [], 'a').map(nodeId)
  assert.equal(path.at(-1), 'a')
  assert.equal(path.length, 2)
  assert.equal(new Set(path).size, 2)
  assert.deepEqual(conversationPath(nodes, [], 'missing'), [])
})

test('restoring a conversation selects the most recent answer rather than a later local note', () => {
  const nodes = [
    node('first', { createdAt: '2026-11-10T01:00:00Z' }),
    node('latest', { createdAt: '2026-11-11T01:00:00Z' }),
    node('local-note', { kind: 'note', createdAt: '2026-11-12T01:00:00Z' }),
  ]
  assert.equal(latestConversationId(nodes), 'latest')
  assert.equal(latestConversationId([nodes[2]]), '')
  assert.equal(latestConversationId([]), '')
})
