import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSourceBlock } from '../apps/web/src/source-navigation.ts';
import type { ContentBlock } from '../apps/web/src/platform.ts';

const source: ContentBlock = { id: 'old', sourceBlockKey: 'pdf:p2:text:4-5', type: 'paragraph', text: 'Retained evidence', sourceLocator: { sourceHash: 'abc', pageNumber: 2 } };
const current = { ...source, id: 'current' };

test('historical citations resolve only to unchanged content at the same immutable source', () => {
  assert.equal(resolveSourceBlock(source, [current]), current);
  assert.equal(resolveSourceBlock(source, [source]), source);
});

test('historical citations reject changed text, location, source, or ambiguous candidates', () => {
  for (const candidate of [
    { ...current, text: 'Changed evidence' },
    { ...current, type: 'heading' },
    { ...current, sourceLocator: { sourceHash: 'other', pageNumber: 2 } },
    { ...current, sourceLocator: { sourceHash: 'abc', pageNumber: 3 } },
    { ...current, sourceBlockKey: 'pdf:p2:text:6' },
  ]) assert.equal(resolveSourceBlock(source, [candidate]), undefined);
  assert.equal(resolveSourceBlock(source, [current, { ...current, id: 'duplicate' }]), undefined);
  assert.equal(resolveSourceBlock({ ...source, sourceLocator: undefined }, [current]), undefined);
});
