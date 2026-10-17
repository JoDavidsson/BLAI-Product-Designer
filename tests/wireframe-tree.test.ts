import { describe, expect, it } from 'vitest';
import { createNode, type Screen, type WireNode } from '../shared/model';
import {
  cloneWireNode,
  nodeParent,
  reparentNode,
  wireframeLimitError,
} from '../src/lib/wireframe-tree';

const screen = (nodes: WireNode[], id = 'screen_one'): Screen => ({
  id,
  name: 'Example',
  state: 'default',
  description: '',
  platform: 'desktop',
  nodes,
});

describe('composable wireframe editing', () => {
  it('moves a complete annotated subtree into an empty container without changing IDs or the original tree', () => {
    const card = createNode('card');
    const label = createNode('text', 'Keep this note attached');
    card.children = [label];
    const emptyColumn = createNode('column');
    const original = [card, emptyColumn];
    const before = structuredClone(original);
    const moved = reparentNode(original, card.id, emptyColumn.id)!;
    expect(moved).toHaveLength(1);
    expect(moved[0].children[0]).toEqual(card);
    expect(nodeParent(moved, label.id)).toBe(card.id);
    expect(nodeParent(moved, card.id)).toBe(emptyColumn.id);
    expect(original).toEqual(before);
    const restored = reparentNode(moved, card.id, '')!;
    expect(restored[0].children).toEqual([]);
    expect(restored[1]).toEqual(card);
  });

  it('rejects moves into oneself, descendants, leaves, missing containers, and unchanged parents', () => {
    const section = createNode('section');
    const card = createNode('card');
    const leaf = createNode('text');
    card.children = [leaf];
    section.children = [card];
    const nodes = [section];
    for (const parent of [section.id, card.id, leaf.id, 'missing', ''])
      expect(reparentNode(nodes, section.id, parent)).toBeNull();
    expect(reparentNode(nodes, card.id, section.id)).toBeNull();
    expect(reparentNode(nodes, 'missing', '')).toBeNull();
  });

  it('copies all descendants with fresh IDs while keeping outward links and remapping a screen copy’s self links', () => {
    const source = createNode('card');
    const self = createNode('button', 'Restart');
    self.action = { screenId: 'original_screen' };
    const outward = createNode('button', 'Next');
    outward.action = { screenId: 'another_screen' };
    source.children = [self, outward];
    const copy = cloneWireNode(source, { from: 'original_screen', to: 'new_screen' });
    expect(
      new Set([source.id, self.id, outward.id, copy.id, ...copy.children.map((node) => node.id)])
        .size,
    ).toBe(6);
    expect(copy.children[0].action?.screenId).toBe('new_screen');
    expect(copy.children[1].action?.screenId).toBe('another_screen');
    expect(self.action.screenId).toBe('original_screen');
    expect(cloneWireNode(source).children[0].action?.screenId).toBe('original_screen');
    copy.children[0].text = 'Edited copy';
    expect(source.children[0].text).toBe('Restart');
  });

  it('prevents nesting and collection limits from making an unsavable draft', () => {
    const nested = (depth: number): WireNode => ({
      ...createNode('column'),
      children: depth > 1 ? [nested(depth - 1)] : [],
    });
    expect(wireframeLimitError([screen([nested(10)])])).toBeUndefined();
    expect(wireframeLimitError([screen([nested(11)])])).toMatch(/10 levels/);
    expect(
      wireframeLimitError([screen(Array.from({ length: 100 }, () => createNode('text')))]),
    ).toBeUndefined();
    expect(
      wireframeLimitError([screen(Array.from({ length: 101 }, () => createNode('text')))]),
    ).toMatch(/100 components/);
    expect(
      wireframeLimitError(Array.from({ length: 31 }, (_, i) => screen([], `screen_${i}`))),
    ).toMatch(/30 screens/);
    expect(
      wireframeLimitError(
        Array.from({ length: 11 }, (_, i) =>
          screen(
            Array.from({ length: 100 }, () => createNode('text')),
            `screen_${i}`,
          ),
        ),
      ),
    ).toMatch(/1,000/);
  });
});
