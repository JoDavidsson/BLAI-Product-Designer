import { createNode, type NodeFrame, type NodeType, type WireNode } from '../../shared/model';

export type Frame = NodeFrame;
export interface Point {
  x: number;
  y: number;
}
export interface Bounds extends Point {
  width: number;
  height: number;
}
/** The same six coefficients and composition order as DOMMatrix / SVG. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
export interface SceneEntry {
  node: WireNode;
  parentId: string;
  parentMatrix: Affine;
  worldMatrix: Affine;
  /** Includes inherited state from every ancestor. */
  locked: boolean;
  hidden: boolean;
  /** A row/column parent controls this layer's position, but it is still selectable. */
  layoutControlled: boolean;
}
export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type LayerOrder = 'front' | 'back' | 'forward' | 'backward';
export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const POSITION_LIMIT = 20000;
const EPSILON = 1e-7;
const containers: ReadonlySet<NodeType> = new Set(['group', 'section', 'row', 'column', 'card']);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);

export function normalizeRotation(degrees: number): number {
  const angle = ((((finite(degrees) + 180) % 360) + 360) % 360) - 180;
  return Object.is(angle, -0) ? 0 : angle;
}

/** UI edits are bounded here; persisted input still goes through strict validation. */
export function normalizeFrame(frame: Frame): Frame {
  return {
    x: clamp(finite(frame.x), -POSITION_LIMIT, POSITION_LIMIT),
    y: clamp(finite(frame.y), -POSITION_LIMIT, POSITION_LIMIT),
    width: clamp(finite(frame.width, 1), 1, POSITION_LIMIT),
    height: clamp(finite(frame.height, 1), 1, POSITION_LIMIT),
    rotation: normalizeRotation(frame.rotation),
  };
}

export function defaultFrame(type: NodeType, x = 0, y = 0): Frame {
  let width = 240,
    height = 160;
  if (type === 'heading') {
    width = 360;
    height = 56;
  } else if (type === 'text') {
    width = 320;
    height = 80;
  } else if (type === 'button') {
    width = 160;
    height = 48;
  } else if (type === 'input') {
    width = 280;
    height = 48;
  } else if (type === 'badge') {
    width = 80;
    height = 28;
  } else if (type === 'line' || type === 'divider') {
    width = 240;
    height = 2;
  } else if (type === 'nav') {
    width = 400;
    height = 48;
  } else if (type === 'ellipse') {
    width = 160;
    height = 160;
  } else if (containers.has(type)) {
    width = 400;
    height = 280;
  }
  return normalizeFrame({ x, y, width, height, rotation: 0 });
}

export function frameFor(node: WireNode): Frame {
  return node.frame ? normalizeFrame(node.frame) : defaultFrame(node.type);
}

export function multiplyMatrices(left: Affine, right: Affine): Affine {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function invertMatrix(matrix: Affine): Affine {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    throw new RangeError('Cannot invert a singular transform.');
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

export function transformPoint(matrix: Affine, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

export function transformVector(matrix: Affine, vector: Point): Point {
  return {
    x: matrix.a * vector.x + matrix.c * vector.y,
    y: matrix.b * vector.x + matrix.d * vector.y,
  };
}

/** Local coordinates start at (0, 0); rotation is about the frame centre. */
export function frameMatrix(frame: Frame): Affine {
  const angle = (frame.rotation * Math.PI) / 180;
  const a = Math.cos(angle),
    b = Math.sin(angle),
    cx = frame.width / 2,
    cy = frame.height / 2;
  return {
    a,
    b,
    c: -b,
    d: a,
    e: frame.x + cx - a * cx + b * cy,
    f: frame.y + cy - b * cx - a * cy,
  };
}

/** Only rigid transforms are stored. Refuse changes that cannot preserve bounded geometry. */
function matrixFrame(matrix: Affine, width: number, height: number): Frame | null {
  const centre = transformPoint(matrix, { x: width / 2, y: height / 2 });
  const frame = {
    x: centre.x - width / 2,
    y: centre.y - height / 2,
    width,
    height,
    rotation: normalizeRotation((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI),
  };
  if (
    !Object.values(frame).every(Number.isFinite) ||
    Math.abs(frame.x) > POSITION_LIMIT + EPSILON ||
    Math.abs(frame.y) > POSITION_LIMIT + EPSILON ||
    width < 1 ||
    height < 1 ||
    width > POSITION_LIMIT ||
    height > POSITION_LIMIT
  )
    return null;
  return normalizeFrame(frame);
}

export function sceneIndex(nodes: WireNode[]): Map<string, SceneEntry> {
  const result = new Map<string, SceneEntry>();
  function visit(
    items: WireNode[],
    parentId: string,
    parentMatrix: Affine,
    locked: boolean,
    hidden: boolean,
    layoutControlled: boolean,
  ) {
    for (const node of items) {
      const entry: SceneEntry = {
        node,
        parentId,
        parentMatrix,
        worldMatrix: multiplyMatrices(parentMatrix, frameMatrix(frameFor(node))),
        locked: locked || !!node.locked,
        hidden: hidden || !!node.hidden,
        layoutControlled,
      };
      result.set(node.id, entry);
      visit(
        node.children,
        node.id,
        entry.worldMatrix,
        entry.locked,
        entry.hidden,
        node.layout === 'row' || node.layout === 'column',
      );
    }
  }
  visit(nodes, '', IDENTITY, false, false, false);
  return result;
}

export function frameCorners(frame: Frame, parentMatrix: Affine = IDENTITY): Point[] {
  const matrix = multiplyMatrices(parentMatrix, frameMatrix(frame));
  return [
    { x: 0, y: 0 },
    { x: frame.width, y: 0 },
    { x: frame.width, y: frame.height },
    { x: 0, y: frame.height },
  ].map((point) => transformPoint(matrix, point));
}

export function boundsForPoints(points: Point[]): Bounds | null {
  if (!points.length) return null;
  const xs = points.map((point) => point.x),
    ys = points.map((point) => point.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function rotatedBounds(frame: Frame, parentMatrix: Affine = IDENTITY): Bounds {
  return boundsForPoints(frameCorners(frame, parentMatrix))!;
}

export function worldBounds(nodes: WireNode[], id: string): Bounds | null {
  const entry = sceneIndex(nodes).get(id);
  return entry ? rotatedBounds(frameFor(entry.node), entry.parentMatrix) : null;
}

/** Keep each selected subtree once, in paint order. Hidden/locked ancestry is respected. */
export function rootSelection(
  nodes: WireNode[],
  ids: Iterable<string>,
  options: { editable?: boolean; movable?: boolean } = {},
): string[] {
  const wanted = new Set(ids),
    index = sceneIndex(nodes);
  return [...index.values()]
    .filter((entry) => {
      if (
        !wanted.has(entry.node.id) ||
        (options.editable !== false && (entry.locked || entry.hidden))
      )
        return false;
      if (options.movable && entry.layoutControlled) return false;
      let parentId = entry.parentId;
      while (parentId) {
        if (wanted.has(parentId)) return false;
        parentId = index.get(parentId)?.parentId ?? '';
      }
      return true;
    })
    .map((entry) => entry.node.id);
}

export function selectionBounds(nodes: WireNode[], ids: Iterable<string>): Bounds | null {
  const index = sceneIndex(nodes);
  return boundsForPoints(
    rootSelection(nodes, ids, { editable: false }).flatMap((id) => {
      const entry = index.get(id)!;
      return frameCorners(frameFor(entry.node), entry.parentMatrix);
    }),
  );
}

function replaceFrames(nodes: WireNode[], frames: Map<string, Frame>): WireNode[] {
  if (!frames.size) return nodes;
  return nodes.map((node) => ({
    ...node,
    ...(frames.has(node.id) ? { frame: frames.get(node.id)! } : {}),
    children: node.children.length ? replaceFrames(node.children, frames) : node.children,
  }));
}

/** dx/dy are canvas pixels, independent of viewport zoom and ancestor rotation. */
export function moveNodes(
  nodes: WireNode[],
  ids: Iterable<string>,
  dx: number,
  dy: number,
): WireNode[] {
  const index = sceneIndex(nodes),
    deltas = new Map<string, Point>();
  const input = { x: finite(dx), y: finite(dy) };
  // Reduce enormous finite deltas proportionally before matrix arithmetic can
  // overflow. A larger movement cannot fit within the local position bounds.
  const inputScale = Math.min(
    1,
    (POSITION_LIMIT * 4) / Math.max(Math.abs(input.x), Math.abs(input.y)),
  );
  const requested = { x: input.x * inputScale, y: input.y * inputScale };
  let fraction = 1;
  for (const id of rootSelection(nodes, ids, { movable: true })) {
    const entry = index.get(id)!,
      frame = frameFor(entry.node);
    const delta = transformVector(invertMatrix(entry.parentMatrix), requested);
    deltas.set(id, delta);
    for (const axis of ['x', 'y'] as const) {
      if (delta[axis] > 0)
        fraction = Math.min(fraction, (POSITION_LIMIT - frame[axis]) / delta[axis]);
      if (delta[axis] < 0)
        fraction = Math.min(fraction, (-POSITION_LIMIT - frame[axis]) / delta[axis]);
    }
  }
  const frames = new Map<string, Frame>();
  for (const [id, delta] of deltas) {
    const frame = frameFor(index.get(id)!.node);
    frames.set(
      id,
      normalizeFrame({
        ...frame,
        x: frame.x + delta.x * fraction,
        y: frame.y + delta.y * fraction,
      }),
    );
  }
  return replaceFrames(nodes, frames);
}

/** Parent-local frame patch, suitable for numeric inspector edits. */
export function resizeNode(nodes: WireNode[], id: string, patch: Partial<Frame>): WireNode[] {
  const entry = sceneIndex(nodes).get(id);
  if (!entry || entry.locked || entry.hidden) return nodes;
  const current = frameFor(entry.node);
  const safePatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => Number.isFinite(value)),
  );
  const next = normalizeFrame({ ...current, ...safePatch });
  if (
    entry.node.type !== 'group' ||
    (next.width === current.width && next.height === current.height)
  )
    return replaceFrames(nodes, new Map([[id, next]]));
  // Anisotropic scaling of rotated descendants requires skew, which this scene
  // deliberately does not store. Group resizing therefore retains its aspect.
  const scale =
    next.width !== current.width ? next.width / current.width : next.height / current.height;
  const scaled = { ...next, width: current.width * scale, height: current.height * scale };
  const frames = new Map<string, Frame>([[id, scaled]]);
  let valid =
    scaled.width >= 1 &&
    scaled.height >= 1 &&
    scaled.width <= POSITION_LIMIT &&
    scaled.height <= POSITION_LIMIT;
  function scaleChildren(items: WireNode[]) {
    for (const child of items) {
      const original = frameFor(child);
      const frame = {
        ...original,
        x: original.x * scale,
        y: original.y * scale,
        width: original.width * scale,
        height: original.height * scale,
      };
      if (
        Math.abs(frame.x) > POSITION_LIMIT ||
        Math.abs(frame.y) > POSITION_LIMIT ||
        frame.width < 1 ||
        frame.height < 1 ||
        frame.width > POSITION_LIMIT ||
        frame.height > POSITION_LIMIT
      )
        valid = false;
      frames.set(child.id, frame);
      scaleChildren(child.children);
    }
  }
  scaleChildren(entry.node.children);
  return valid ? replaceFrames(nodes, frames) : nodes;
}

/** Resize using parent-local pointer deltas, keeping the opposite anchor fixed even when rotated. */
export function resizeFrame(
  frame: Frame,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  lockAspect = false,
): Frame {
  const base = normalizeFrame(frame);
  const local = transformVector(invertMatrix(frameMatrix(base)), { x: finite(dx), y: finite(dy) });
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  let width = clamp(base.width + sx * local.x, 1, POSITION_LIMIT);
  let height = clamp(base.height + sy * local.y, 1, POSITION_LIMIT);
  if (lockAspect) {
    let scale =
      sx && sy
        ? Math.abs(width / base.width - 1) >= Math.abs(height / base.height - 1)
          ? width / base.width
          : height / base.height
        : sx
          ? width / base.width
          : height / base.height;
    scale = clamp(
      scale,
      Math.max(1 / base.width, 1 / base.height),
      Math.min(POSITION_LIMIT / base.width, POSITION_LIMIT / base.height),
    );
    width = base.width * scale;
    height = base.height * scale;
  }
  const shift = transformVector(frameMatrix(base), {
    x: (sx * (width - base.width)) / 2,
    y: (sy * (height - base.height)) / 2,
  });
  const resized = {
    ...base,
    x: base.x + (base.width - width) / 2 + shift.x,
    y: base.y + (base.height - height) / 2 + shift.y,
    width,
    height,
  };
  // At position limits reject this resize, rather than moving its fixed anchor.
  return Math.abs(resized.x) > POSITION_LIMIT || Math.abs(resized.y) > POSITION_LIMIT
    ? base
    : resized;
}

/** Rotate every selected root in world space about the shared selection centre. */
export function rotateNodes(
  nodes: WireNode[],
  ids: Iterable<string>,
  degrees: number,
  pivot?: Point,
): WireNode[] {
  const roots = rootSelection(nodes, ids),
    index = sceneIndex(nodes),
    bounds = selectionBounds(nodes, roots);
  if (!bounds || !Number.isFinite(degrees)) return nodes;
  const centre = pivot ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) return nodes;
  const angle = (normalizeRotation(degrees) * Math.PI) / 180,
    a = Math.cos(angle),
    b = Math.sin(angle);
  const rotation = {
    a,
    b,
    c: -b,
    d: a,
    e: centre.x - a * centre.x + b * centre.y,
    f: centre.y - b * centre.x - a * centre.y,
  };
  const frames = new Map<string, Frame>();
  for (const id of roots) {
    const entry = index.get(id)!,
      frame = frameFor(entry.node);
    const local = multiplyMatrices(
      invertMatrix(entry.parentMatrix),
      multiplyMatrices(rotation, entry.worldMatrix),
    );
    const next = matrixFrame(local, frame.width, frame.height);
    if (!next) return nodes;
    frames.set(id, next);
  }
  return replaceFrames(nodes, frames);
}

function removeNodes(nodes: WireNode[], ids: Set<string>): WireNode[] {
  return nodes
    .filter((node) => !ids.has(node.id))
    .map((node) => ({ ...node, children: removeNodes(node.children, ids) }));
}

function insertChildren(
  nodes: WireNode[],
  parentId: string,
  children: WireNode[],
  at?: number,
): WireNode[] {
  if (!parentId) {
    const next = [...nodes];
    next.splice(
      at === undefined ? next.length : clamp(Math.trunc(finite(at)), 0, next.length),
      0,
      ...children,
    );
    return next;
  }
  return nodes.map((node) => ({
    ...node,
    children:
      node.id === parentId
        ? insertChildren(node.children, '', children, at)
        : insertChildren(node.children, parentId, children, at),
  }));
}

/** Reparent stable subtrees, preserving every world-space point and sibling order. */
export function reparentNodes(
  nodes: WireNode[],
  ids: Iterable<string>,
  parentId: string,
  at?: number,
): WireNode[] | null {
  const roots = rootSelection(nodes, ids),
    index = sceneIndex(nodes),
    parent = parentId ? index.get(parentId) : undefined;
  if (
    !roots.length ||
    (parentId && (!parent || !containers.has(parent.node.type) || parent.locked || parent.hidden))
  )
    return null;
  let ancestor = parentId;
  while (ancestor) {
    if (roots.includes(ancestor)) return null;
    ancestor = index.get(ancestor)?.parentId ?? '';
  }
  if (at === undefined && roots.every((id) => index.get(id)!.parentId === parentId)) return null;
  const inverse = invertMatrix(parent?.worldMatrix ?? IDENTITY),
    moved: WireNode[] = [];
  for (const id of roots) {
    const entry = index.get(id)!,
      frame = frameFor(entry.node);
    const nextFrame = matrixFrame(
      multiplyMatrices(inverse, entry.worldMatrix),
      frame.width,
      frame.height,
    );
    if (!nextFrame) return null;
    moved.push({ ...entry.node, frame: nextFrame });
  }
  return insertChildren(removeNodes(nodes, new Set(roots)), parentId, moved, at);
}

/** Groups share a parent; rejecting mixed parents avoids surprising paint-order changes. */
export function groupNodes(
  nodes: WireNode[],
  ids: Iterable<string>,
  groupId?: string,
): { nodes: WireNode[]; groupId: string } | null {
  const roots = rootSelection(nodes, ids),
    index = sceneIndex(nodes);
  if (!roots.length || (groupId && index.has(groupId))) return null;
  const parentId = index.get(roots[0])!.parentId;
  if (roots.some((id) => index.get(id)!.parentId !== parentId)) return null;
  const selected = roots.map((id) => index.get(id)!.node);
  const bounds = boundsForPoints(selected.flatMap((node) => frameCorners(frameFor(node))))!;
  if (
    Math.abs(bounds.x) > POSITION_LIMIT ||
    Math.abs(bounds.y) > POSITION_LIMIT ||
    bounds.width > POSITION_LIMIT ||
    bounds.height > POSITION_LIMIT
  )
    return null;
  const children: WireNode[] = [];
  for (const node of selected) {
    const frame = frameFor(node),
      x = frame.x - bounds.x,
      y = frame.y - bounds.y;
    if (Math.abs(x) > POSITION_LIMIT || Math.abs(y) > POSITION_LIMIT) return null;
    children.push({ ...node, frame: { ...frame, x, y } });
  }
  const group: WireNode = {
    ...createNode('group'),
    ...(groupId ? { id: groupId } : {}),
    layout: 'free',
    frame: {
      ...bounds,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
      rotation: 0,
    },
    children,
  };
  const siblings = parentId ? index.get(parentId)!.node.children : nodes;
  const at = siblings.findIndex((node) => node.id === roots[0]);
  return {
    nodes: insertChildren(removeNodes(nodes, new Set(roots)), parentId, [group], at),
    groupId: group.id,
  };
}

/** Replace groups in place, composing their rotation into their direct children. */
export function ungroupNodes(nodes: WireNode[], ids: Iterable<string>): WireNode[] {
  const roots = new Set(rootSelection(nodes, ids));
  function visit(items: WireNode[]): WireNode[] {
    return items.flatMap((node) => {
      if (!roots.has(node.id) || node.type !== 'group')
        return [{ ...node, children: visit(node.children) }];
      const matrix = frameMatrix(frameFor(node)),
        children: WireNode[] = [];
      for (const child of node.children) {
        const frame = frameFor(child),
          nextFrame = matrixFrame(
            multiplyMatrices(matrix, frameMatrix(frame)),
            frame.width,
            frame.height,
          );
        if (!nextFrame) return [node];
        children.push({ ...child, frame: nextFrame });
      }
      return children;
    });
  }
  return visit(nodes);
}

export function alignNodes(
  nodes: WireNode[],
  ids: Iterable<string>,
  alignment: Alignment,
): WireNode[] {
  const roots = rootSelection(nodes, ids),
    bounds = selectionBounds(nodes, roots);
  if (!bounds || roots.length < 2) return nodes;
  let next = nodes;
  for (const id of roots) {
    const box = worldBounds(nodes, id)!;
    const dx =
      alignment === 'left'
        ? bounds.x - box.x
        : alignment === 'right'
          ? bounds.x + bounds.width - box.x - box.width
          : alignment === 'center'
            ? bounds.x + bounds.width / 2 - box.x - box.width / 2
            : 0;
    const dy =
      alignment === 'top'
        ? bounds.y - box.y
        : alignment === 'bottom'
          ? bounds.y + bounds.height - box.y - box.height
          : alignment === 'middle'
            ? bounds.y + bounds.height / 2 - box.y - box.height / 2
            : 0;
    next = moveNodes(next, [id], dx, dy);
  }
  return next;
}

/** Equal visible-edge gaps, leaving the outside layers fixed. */
export function distributeNodes(
  nodes: WireNode[],
  ids: Iterable<string>,
  direction: 'horizontal' | 'vertical',
): WireNode[] {
  const axis = direction === 'horizontal' ? 'x' : 'y',
    dimension = direction === 'horizontal' ? 'width' : 'height';
  const entries = rootSelection(nodes, ids)
    .map((id) => ({ id, bounds: worldBounds(nodes, id)! }))
    .sort((left, right) => left.bounds[axis] - right.bounds[axis]);
  if (entries.length < 3) return nodes;
  const first = entries[0].bounds,
    last = entries[entries.length - 1].bounds;
  const gap =
    (last[axis] +
      last[dimension] -
      first[axis] -
      entries.reduce((sum, entry) => sum + entry.bounds[dimension], 0)) /
    (entries.length - 1);
  let next = nodes,
    cursor = first[axis] + first[dimension] + gap;
  for (const entry of entries.slice(1, -1)) {
    const delta = cursor - entry.bounds[axis];
    next = moveNodes(next, [entry.id], axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
    cursor += entry.bounds[dimension] + gap;
  }
  return next;
}

export function reorderNodes(
  nodes: WireNode[],
  ids: Iterable<string>,
  order: LayerOrder,
): WireNode[] {
  const selected = new Set(rootSelection(nodes, ids));
  function visit(items: WireNode[]): WireNode[] {
    const next = items.map((node) => ({ ...node, children: visit(node.children) }));
    if (order === 'front' || order === 'back') {
      const picked = next.filter((node) => selected.has(node.id)),
        rest = next.filter((node) => !selected.has(node.id));
      return order === 'front' ? [...rest, ...picked] : [...picked, ...rest];
    }
    if (order === 'forward') {
      for (let i = next.length - 2; i >= 0; i--)
        if (selected.has(next[i].id) && !selected.has(next[i + 1].id))
          [next[i], next[i + 1]] = [next[i + 1], next[i]];
    } else {
      for (let i = 1; i < next.length; i++)
        if (selected.has(next[i].id) && !selected.has(next[i - 1].id))
          [next[i], next[i - 1]] = [next[i - 1], next[i]];
    }
    return next;
  }
  return visit(nodes);
}

/** Child dimensions and rotations are retained; only their parent-local position changes. */
export function reflowContainer(nodes: WireNode[], id: string): WireNode[] {
  const entry = sceneIndex(nodes).get(id);
  if (
    !entry ||
    entry.hidden ||
    entry.locked ||
    !containers.has(entry.node.type) ||
    (entry.node.layout !== 'row' && entry.node.layout !== 'column')
  )
    return nodes;
  const node = entry.node,
    horizontal = node.layout === 'row',
    frame = frameFor(node);
  const padding = clamp(finite(node.style.padding ?? 16), 0, POSITION_LIMIT);
  const gap = clamp(finite(node.style.gap ?? 16), 0, POSITION_LIMIT);
  const frames = new Map<string, Frame>();
  let cursor = padding;
  for (const child of node.children) {
    if (child.hidden) continue;
    const childFrame = frameFor(child),
      bounds = rotatedBounds(childFrame);
    const crossSize = horizontal ? bounds.height : bounds.width;
    const available = (horizontal ? frame.height : frame.width) - 2 * padding;
    const cross =
      padding +
      (node.style.align === 'center'
        ? (available - crossSize) / 2
        : node.style.align === 'end'
          ? available - crossSize
          : 0);
    if (child.locked) {
      cursor = Math.max(
        cursor,
        (horizontal ? bounds.x + bounds.width : bounds.y + bounds.height) + gap,
      );
      continue;
    }
    const x = childFrame.x + (horizontal ? cursor : cross) - bounds.x;
    const y = childFrame.y + (horizontal ? cross : cursor) - bounds.y;
    if (Math.abs(x) > POSITION_LIMIT || Math.abs(y) > POSITION_LIMIT) return nodes;
    frames.set(child.id, { ...childFrame, x, y });
    cursor += (horizontal ? bounds.width : bounds.height) + gap;
  }
  return replaceFrames(nodes, frames);
}

/** Apply persisted automatic layouts after edits, deepest containers first. */
export function reflowAutoLayouts(nodes: WireNode[]): WireNode[] {
  return nodes.map((node) => {
    if (node.locked || node.hidden) return node;
    const next = { ...node, children: reflowAutoLayouts(node.children) };
    return next.layout === 'row' || next.layout === 'column'
      ? reflowContainer([next], next.id)[0]
      : next;
  });
}
