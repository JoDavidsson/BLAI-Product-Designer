import { describe, expect, it } from 'vitest';
import { createNode, type NodeType, type WireNode } from '../shared/model';
import {
  alignNodes,
  defaultFrame,
  distributeNodes,
  frameCorners,
  frameFor,
  frameMatrix,
  groupNodes,
  invertMatrix,
  moveNodes,
  multiplyMatrices,
  normalizeFrame,
  reflowAutoLayouts,
  reflowContainer,
  reorderNodes,
  reparentNodes,
  resizeFrame,
  resizeNode,
  rootSelection,
  rotatedBounds,
  rotateNodes,
  sceneIndex,
  selectionBounds,
  transformPoint,
  ungroupNodes,
  worldBounds,
  type Frame,
  type Point,
  type ResizeHandle,
} from '../src/lib/freeform-geometry';

function layer(
  id: string,
  frame: Partial<Frame> = {},
  children: WireNode[] = [],
  type: NodeType = 'rectangle',
): WireNode {
  return {
    ...createNode(type),
    id,
    frame: { x: 0, y: 0, width: 100, height: 60, rotation: 0, ...frame },
    children,
  };
}

function pointClose(actual: Point, expected: Point) {
  expect(actual.x).toBeCloseTo(expected.x, 7);
  expect(actual.y).toBeCloseTo(expected.y, 7);
}

function corners(nodes: WireNode[], id: string) {
  const entry = sceneIndex(nodes).get(id)!;
  return frameCorners(frameFor(entry.node), entry.parentMatrix);
}

function sameWorld(before: WireNode[], after: WireNode[], ids: string[]) {
  for (const id of ids)
    corners(after, id).forEach((point, i) => pointClose(point, corners(before, id)[i]));
}

describe('freeform affine geometry', () => {
  it('rotates about the centre and composes parent-local transforms', () => {
    const frame = { x: 10, y: 20, width: 100, height: 40, rotation: 90 };
    pointClose(transformPoint(frameMatrix(frame), { x: 0, y: 0 }), { x: 80, y: -10 });
    pointClose(transformPoint(frameMatrix(frame), { x: 50, y: 20 }), { x: 60, y: 40 });
    const bounds = rotatedBounds(frame);
    pointClose(bounds, { x: 40, y: -10 });
    expect(bounds.width).toBeCloseTo(40);
    expect(bounds.height).toBeCloseTo(100);
    const child = frameMatrix({ ...frame, x: -20, rotation: -35 });
    const point = { x: 17, y: 13 };
    pointClose(
      transformPoint(multiplyMatrices(frameMatrix(frame), child), point),
      transformPoint(frameMatrix(frame), transformPoint(child, point)),
    );
  });

  it('round-trips points through deeply nested translated and rotated groups', () => {
    const nodes = [
      layer(
        'outer',
        { x: -301.5, y: 811.4, rotation: 127 },
        [
          layer(
            'inner',
            { x: 54.75, y: -32.25, rotation: -76 },
            [layer('leaf', { x: -40, y: 90, width: 167, height: 39, rotation: 248 })],
            'group',
          ),
        ],
        'group',
      ),
    ];
    const entry = sceneIndex(nodes).get('leaf')!;
    for (let i = 0; i < 40; i++) {
      const point = { x: i * 9.341 - 100, y: i * -7.387 + 200 };
      pointClose(
        transformPoint(invertMatrix(entry.worldMatrix), transformPoint(entry.worldMatrix, point)),
        point,
      );
    }
    // Comment pins use the same local-to-world transform as the layer itself.
    const frame = frameFor(entry.node),
      pin = { x: frame.width * 0.2, y: frame.height * 0.8 };
    pointClose(
      transformPoint(invertMatrix(entry.worldMatrix), transformPoint(entry.worldMatrix, pin)),
      pin,
    );
    expect(() => invertMatrix({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toThrow(/singular/);
  });

  it('keeps interactive defaults finite and within persisted frame limits', () => {
    expect(
      normalizeFrame({ x: Infinity, y: -90000, width: NaN, height: 90000, rotation: 1085 }),
    ).toEqual({ x: 0, y: -20000, width: 1, height: 20000, rotation: 5 });
    expect(defaultFrame('line', NaN, Infinity)).toEqual({
      x: 0,
      y: 0,
      width: 240,
      height: 2,
      rotation: 0,
    });
    expect(defaultFrame('text').width).toBeGreaterThan(defaultFrame('button').width);
    expect(selectionBounds([], ['missing'])).toBeNull();
  });

  it('prunes nested selections and respects inherited hidden and locked layers', () => {
    const child = layer('child'),
      locked = { ...layer('locked', {}, [layer('locked-child')], 'group'), locked: true };
    const hidden = { ...layer('hidden', {}, [layer('hidden-child')], 'group'), hidden: true };
    const nodes = [layer('parent', {}, [child], 'group'), locked, hidden];
    expect(
      rootSelection(nodes, [
        'child',
        'parent',
        'locked-child',
        'hidden-child',
        'missing',
        'parent',
      ]),
    ).toEqual(['parent']);
    expect(rootSelection(nodes, ['locked-child', 'hidden-child'], { editable: false })).toEqual([
      'locked-child',
      'hidden-child',
    ]);
    expect(moveNodes(nodes, ['locked-child'], 10, 20)).toBe(nodes);
    expect(resizeNode(nodes, 'hidden-child', { width: 300 })).toBe(nodes);
  });

  it('nudges in canvas pixels at every viewport zoom and under rotated ancestors', () => {
    const nodes = [
      layer(
        'parent',
        { x: 190, y: -20, rotation: 90 },
        [layer('leaf', { x: 10, y: 20, rotation: 37 })],
        'group',
      ),
    ];
    const before = structuredClone(nodes);
    for (const zoom of [0.2, 0.5, 1, 2, 4]) {
      const pointerDelta = { x: 12 * zoom, y: -7 * zoom };
      const moved = moveNodes(nodes, ['leaf'], pointerDelta.x / zoom, pointerDelta.y / zoom);
      corners(moved, 'leaf').forEach((point, i) =>
        pointClose(point, {
          x: corners(nodes, 'leaf')[i].x + 12,
          y: corners(nodes, 'leaf')[i].y - 7,
        }),
      );
      const nudged = moveNodes(nodes, ['leaf'], 1, 0);
      pointClose(corners(nudged, 'leaf')[0], {
        x: corners(nodes, 'leaf')[0].x + 1,
        y: corners(nodes, 'leaf')[0].y,
      });
    }
    expect(nodes).toEqual(before);
    const parentMoved = moveNodes(nodes, ['parent', 'leaf'], 3, 4);
    pointClose(corners(parentMoved, 'leaf')[0], {
      x: corners(nodes, 'leaf')[0].x + 3,
      y: corners(nodes, 'leaf')[0].y + 4,
    });
  });

  it('stops a multiselection together at coordinate limits', () => {
    const nodes = [layer('a', { x: 19995, y: 10 }), layer('b', { x: 100, y: 50 })];
    const moved = moveNodes(nodes, ['a', 'b'], 10, 8);
    expect(moved[0].frame).toMatchObject({ x: 20000, y: 14 });
    expect(moved[1].frame).toMatchObject({ x: 105, y: 54 });
    expect(moveNodes(nodes, ['a'], Infinity, NaN)[0].frame).toEqual(nodes[0].frame);
    const huge = moveNodes(
      [layer('parent', { rotation: -45 }, [layer('child', { x: 50, y: 10 })], 'group')],
      ['child'],
      Number.MAX_VALUE,
      Number.MAX_VALUE,
    );
    const frame = sceneIndex(huge).get('child')!.node.frame!;
    expect(Object.values(frame).every(Number.isFinite)).toBe(true);
    expect(frame.y).toBeCloseTo(20000);
    expect(frame.x).toBeCloseTo(50);
  });

  it('keeps the opposite anchor fixed for every resize handle and rotation', () => {
    const handles: ResizeHandle[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
    for (const rotation of [-173, -45, 0, 90, 137])
      for (const handle of handles) {
        const frame = { x: 25, y: 80, width: 180, height: 100, rotation };
        const resized = resizeFrame(frame, handle, 24, -11);
        const anchor = {
          x: handle.includes('w') ? 1 : handle.includes('e') ? 0 : 0.5,
          y: handle.includes('n') ? 1 : handle.includes('s') ? 0 : 0.5,
        };
        pointClose(
          transformPoint(frameMatrix(resized), {
            x: anchor.x * resized.width,
            y: anchor.y * resized.height,
          }),
          transformPoint(frameMatrix(frame), {
            x: anchor.x * frame.width,
            y: anchor.y * frame.height,
          }),
        );
      }
  });

  it('scales rotated nested groups uniformly with their descendants', () => {
    const nodes = [
      layer(
        'group',
        { x: 100, y: 100, width: 300, height: 200, rotation: 35 },
        [
          layer(
            'inner',
            { x: 50, y: 25, width: 90, height: 60, rotation: -75 },
            [layer('leaf', { x: 20, y: 10, width: 30, height: 20, rotation: 20 })],
            'group',
          ),
        ],
        'group',
      ),
    ];
    const frame = nodes[0].frame!,
      anchor = transformPoint(frameMatrix(frame), { x: 0, y: 0 });
    const resizedFrame = resizeFrame(frame, 'se', 70, 70, true);
    const resized = resizeNode(nodes, 'group', resizedFrame),
      scale = resizedFrame.width / frame.width;
    for (const id of ['group', 'inner', 'leaf'])
      corners(resized, id).forEach((point, i) => {
        const before = corners(nodes, id)[i];
        pointClose(point, {
          x: anchor.x + (before.x - anchor.x) * scale,
          y: anchor.y + (before.y - anchor.y) * scale,
        });
      });
    expect(resized[0].frame!.width / resized[0].frame!.height).toBeCloseTo(1.5);
  });

  it('rotates a selection in world space without changing relative placement', () => {
    const nodes = [
      layer('parent', { rotation: 29 }, [layer('a', { x: 40, y: 20, rotation: 17 })], 'group'),
      layer('b', { x: 400, y: 230, rotation: -42 }),
    ];
    const pivot = { x: 150, y: 100 },
      rotated = rotateNodes(nodes, ['a', 'b'], 90, pivot);
    for (const id of ['a', 'b'])
      corners(rotated, id).forEach((point, i) => {
        const before = corners(nodes, id)[i];
        pointClose(point, { x: pivot.x - (before.y - pivot.y), y: pivot.y + (before.x - pivot.x) });
      });
  });
});

describe('freeform scene operations', () => {
  it('groups and ungroups rotated nested children without moving any world point or losing IDs', () => {
    const nodes = [
      layer(
        'outer',
        { x: 200, y: -80, width: 600, height: 500, rotation: 39 },
        [
          layer('a', { x: 10, y: 30, rotation: -73 }),
          layer(
            'b',
            { x: 190, y: 90, rotation: 121 },
            [layer('leaf', { x: 4, y: 17, rotation: 8 })],
            'group',
          ),
          layer('untouched', { x: 400 }),
        ],
        'group',
      ),
    ];
    const snapshot = structuredClone(nodes);
    const grouped = groupNodes(nodes, ['b', 'a', 'leaf'], 'new_group')!;
    expect(grouped.groupId).toBe('new_group');
    expect(
      sceneIndex(grouped.nodes)
        .get('new_group')!
        .node.children.map((node) => node.id),
    ).toEqual(['a', 'b']);
    sameWorld(nodes, grouped.nodes, ['a', 'b', 'leaf', 'untouched']);
    const rotated = rotateNodes(grouped.nodes, ['new_group'], 63);
    const ungrouped = ungroupNodes(rotated, ['new_group']);
    sameWorld(rotated, ungrouped, ['a', 'b', 'leaf', 'untouched']);
    expect(ungrouped[0].children.map((node) => node.id)).toEqual(['a', 'b', 'untouched']);
    sameWorld(nodes, ungroupNodes(grouped.nodes, ['new_group']), ['a', 'b', 'leaf']);
    expect(nodes).toEqual(snapshot);
    expect(groupNodes(nodes, ['outer', 'a'], 'a')).toBeNull();
    expect(groupNodes(nodes, ['a', 'leaf'])).toBeNull();
  });

  it('reparents between rotated groups and back while retaining the full subtree and paint order', () => {
    const nodes = [
      layer(
        'source',
        { x: -100, y: 70, rotation: -135 },
        [
          layer(
            'a',
            { x: 40, y: 10, rotation: 73 },
            [layer('leaf', { x: -5, y: 10, rotation: -24 })],
            'group',
          ),
          layer('b', { x: 200, y: 80, rotation: 15 }),
        ],
        'group',
      ),
      layer('destination', { x: 400, y: 300, rotation: 105 }, [layer('existing')], 'group'),
    ];
    const moved = reparentNodes(nodes, ['b', 'a', 'leaf'], 'destination', 0)!;
    expect(moved[0].children).toEqual([]);
    expect(moved[1].children.map((node) => node.id)).toEqual(['a', 'b', 'existing']);
    sameWorld(nodes, moved, ['a', 'b', 'leaf', 'existing']);
    const returned = reparentNodes(moved, ['a', 'b'], 'source')!;
    sameWorld(nodes, returned, ['a', 'b', 'leaf']);
    expect(reparentNodes(nodes, ['source'], 'leaf')).toBeNull();
    expect(reparentNodes(nodes, ['a'], 'source')).toBeNull();
    expect(reparentNodes(nodes, ['a'], 'missing')).toBeNull();
    expect(reparentNodes(nodes, ['a'], 'b')).toBeNull();
  });

  it('rejects coordinate overflow instead of shifting a reparented or ungrouped layer', () => {
    const nodes = [layer('a', { x: -20000 }), layer('far', { x: 20000 }, [], 'group')];
    expect(reparentNodes(nodes, ['a'], 'far')).toBeNull();
    const grouped = [layer('parent', { x: 20000 }, [layer('child', { x: 100 })], 'group')];
    expect(ungroupNodes(grouped, ['parent'])).toEqual(grouped);
  });

  it('aligns rotated world bounds and distributes equal visible gaps across different parents', () => {
    const nodes = [
      layer('parent', { x: 80, y: 50, rotation: 90 }, [layer('a', { rotation: 20 })], 'group'),
      layer('b', { x: 260, y: 230, width: 70, rotation: -45 }),
      layer('c', { x: 700, y: 400, width: 40 }),
    ];
    const aligned = alignNodes(nodes, ['a', 'b', 'c'], 'top');
    const tops = ['a', 'b', 'c'].map((id) => worldBounds(aligned, id)!.y);
    expect(tops[0]).toBeCloseTo(tops[1], 7);
    expect(tops[1]).toBeCloseTo(tops[2], 7);
    const distributed = distributeNodes(nodes, ['a', 'b', 'c'], 'horizontal');
    const [a, b, c] = ['a', 'b', 'c'].map((id) => worldBounds(distributed, id)!);
    expect(b.x - a.x - a.width).toBeCloseTo(c.x - b.x - b.width, 7);
    sameWorld(nodes, distributed, ['a', 'c']);
  });

  it('keeps selected sibling order when moving forward, back or to an edge', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => layer(id));
    const order = (direction: Parameters<typeof reorderNodes>[2]) =>
      reorderNodes(nodes, ['b', 'c'], direction).map((node) => node.id);
    expect(order('forward')).toEqual(['a', 'd', 'b', 'c', 'e']);
    expect(order('backward')).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(order('front')).toEqual(['a', 'd', 'e', 'b', 'c']);
    expect(order('back')).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('persists layout positions using rotated bounds, gap and cross-axis alignment', () => {
    const parent = layer(
      'parent',
      { width: 500, height: 300, rotation: 35 },
      [
        layer('a', { x: 70, y: 90, width: 100, height: 40, rotation: 90 }),
        layer('b', { x: 170, y: 190, width: 80, height: 60 }),
        { ...layer('hidden'), hidden: true },
      ],
      'group',
    );
    parent.layout = 'row';
    parent.style = { padding: 20, gap: 12, align: 'center' };
    const nodes = [parent],
      flowed = reflowContainer(nodes, 'parent');
    const [a, b, hidden] = flowed[0].children;
    const ab = rotatedBounds(a.frame!),
      bb = rotatedBounds(b.frame!);
    pointClose(ab, { x: 20, y: 100 });
    pointClose(bb, { x: 72, y: 120 });
    expect(hidden).toEqual(parent.children[2]);
    expect(a.frame!.rotation).toBe(90);
    expect(sceneIndex(flowed).get('a')!.layoutControlled).toBe(true);
    expect(rootSelection(flowed, ['a'])).toEqual(['a']);
    expect(rootSelection(flowed, ['a'], { movable: true })).toEqual([]);
    expect(moveNodes(flowed, ['a'], 10, 20)).toBe(flowed);
    expect(resizeNode(flowed, 'a', { width: 120 })[0].children[0].frame!.width).toBe(120);
    sameWorld(flowed, reflowAutoLayouts(flowed), ['a', 'b']);
  });

  it('reflows nested automatic layouts after resize and ordering while respecting locks', () => {
    const inner = {
      ...layer('inner', { width: 300, height: 100 }, [layer('a'), layer('b')], 'group'),
      layout: 'row' as const,
      style: { padding: 10, gap: 5 },
    };
    const outer = {
      ...layer('outer', { width: 600, height: 500 }, [inner, layer('c')], 'group'),
      layout: 'column' as const,
      style: { padding: 20, gap: 15 },
    };
    const initial = reflowAutoLayouts([outer]);
    const edited = resizeNode(initial, 'a', { width: 150 });
    const result = reflowAutoLayouts(edited);
    expect(sceneIndex(result).get('b')!.node.frame!.x).toBe(165);
    expect(sceneIndex(result).get('c')!.node.frame!.y).toBe(135);
    const reordered = reflowAutoLayouts(reorderNodes(result, ['a'], 'front'));
    expect(sceneIndex(reordered).get('b')!.node.frame!.x).toBe(10);
    expect(sceneIndex(reordered).get('a')!.node.frame!.x).toBe(115);
    const locked = [{ ...outer, locked: true }];
    expect(reflowAutoLayouts(locked)).toEqual(locked);
    const free = [
      { ...outer, layout: 'free' as const, children: [layer('still', { x: -50, y: 100 })] },
    ];
    expect(reflowAutoLayouts(free)).toEqual(free);
  });
});
