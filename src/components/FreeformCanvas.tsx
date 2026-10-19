import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { Image as ImageIcon } from 'lucide-react';
import {
  createNode,
  findNode,
  type Annotation,
  type AnnotationTarget,
  type BoardAsset,
  type DesignTokens,
  type NodeFrame,
  type Screen,
  type WireNode,
} from '../../shared/model';
import {
  frameFor,
  invertMatrix,
  moveNodes,
  normalizeFrame,
  reflowAutoLayouts,
  resizeFrame,
  resizeNode,
  rootSelection,
  rotateNodes,
  sceneIndex,
  selectionBounds,
  transformPoint,
  worldBounds,
  type Affine,
  type Bounds,
  type Point,
} from '../lib/freeform-geometry';
import { WireframeCommentPins } from './WireframeComments';
import './freeform-canvas.css';

export type CanvasTool =
  'select' | 'hand' | 'rectangle' | 'ellipse' | 'line' | 'path' | 'text' | 'comment';
type Handle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export interface FreeformCanvasProps {
  screen: Screen;
  design: DesignTokens;
  assets: BoardAsset[];
  selectedIds: string[];
  tool: CanvasTool;
  zoom: number;
  onSelection: (ids: string[]) => void;
  onCommit: (nodes: WireNode[]) => void;
  onToolChange?: (tool: CanvasTool) => void;
  viewportRef?: RefObject<HTMLDivElement | null>;
  artboardRef?: RefObject<HTMLDivElement | null>;
  onZoomChange?: (zoom: number) => void;
  comments?: Annotation[];
  selectedCommentId?: string;
  onCommentSelect?: (comment: Annotation) => void;
  onComment?: (target: AnnotationTarget) => void;
  preview?: boolean;
  onNavigate?: (screenId: string) => void;
  onUnlinked?: () => void;
}

type BaseGesture = {
  pointerId: number;
  start: Point;
  baseline: WireNode[];
  originalSelection: string[];
  changed: boolean;
  screenId: string;
  canvasWidth: number;
  canvasHeight: number;
};
type Gesture = BaseGesture &
  (
    | { kind: 'move'; ids: string[] }
    | { kind: 'resize'; ids: string[]; handle: Handle; frame: NodeFrame; parentInverse?: Affine }
    | { kind: 'rotate'; ids: string[]; pivot: Point; angle: number }
    | { kind: 'marquee'; additive: boolean }
    | { kind: 'draw'; node: WireNode; points: Point[] }
    | { kind: 'pan'; client: Point; scroll: Point }
  );
const handles: { key: Handle; x: number; y: number }[] = [
  { key: 'nw', x: 0, y: 0 },
  { key: 'n', x: 0.5, y: 0 },
  { key: 'ne', x: 1, y: 0 },
  { key: 'e', x: 1, y: 0.5 },
  { key: 'se', x: 1, y: 1 },
  { key: 's', x: 0.5, y: 1 },
  { key: 'sw', x: 0, y: 1 },
  { key: 'w', x: 0, y: 0.5 },
];
const editableText = new Set(['heading', 'text', 'button', 'input', 'badge', 'nav']);
const containers = new Set(['group', 'section', 'row', 'column', 'card']);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const boxBetween = (a: Point, b: Point): Bounds => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const angle = (point: Point, pivot: Point) =>
  (Math.atan2(point.y - pivot.y, point.x - pivot.x) * 180) / Math.PI;
const mapNodes = (
  nodes: WireNode[],
  id: string,
  update: (node: WireNode) => WireNode,
): WireNode[] =>
  nodes.map((node) =>
    node.id === id ? update(node) : { ...node, children: mapNodes(node.children, id, update) },
  );
const safeImage = (asset?: BoardAsset) =>
  asset &&
  (/^\/api\/assets\/[a-zA-Z0-9_-]+$/.test(asset.imageUrl) ||
    /^\/sample\/[a-zA-Z0-9_.-]+$/.test(asset.imageUrl))
    ? asset.imageUrl
    : undefined;
const corners = (width: number, height: number, matrix: Affine) =>
  [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((point) => transformPoint(matrix, point));
const pointsString = (points: Point[]) => points.map((point) => `${point.x},${point.y}`).join(' ');

// A successful save returns fresh, schema-ordered JSON. Metadata-only readbacks
// must not interrupt a pointer gesture; actual scene changes still cancel it.
function sameSceneData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, i) => sameSceneData(value, right[i]))
    );
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameSceneData(a[key], b[key]))
  );
}

function Visual({
  node,
  design,
  assets,
  preview,
  onNavigate,
  onUnlinked,
}: Pick<FreeformCanvasProps, 'design' | 'assets' | 'preview' | 'onNavigate' | 'onUnlinked'> & {
  node: WireNode;
}) {
  const frame = frameFor(node);
  const shape = ['rectangle', 'ellipse', 'line', 'path'].includes(node.type);
  if (shape) {
    const fill =
      node.type === 'line' || node.type === 'path'
        ? 'none'
        : node.style.background || design.accent;
    const stroke =
      node.style.stroke || (node.type === 'line' || node.type === 'path' ? design.text : 'none');
    const strokeWidth =
      node.style.strokeWidth ?? (node.type === 'line' || node.type === 'path' ? 2 : 1);
    return (
      <svg
        className="fc-shape"
        width="100%"
        height="100%"
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        aria-hidden="true"
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      >
        {node.type === 'rectangle' && (
          <rect width={frame.width} height={frame.height} rx={node.style.radius ?? 0} />
        )}
        {node.type === 'ellipse' && (
          <ellipse
            cx={frame.width / 2}
            cy={frame.height / 2}
            rx={frame.width / 2}
            ry={frame.height / 2}
          />
        )}
        {node.type === 'line' && (
          <line x1={0} y1={0} x2={frame.width} y2={frame.height} strokeLinecap="round" />
        )}
        {node.type === 'path' && (
          <polyline
            points={pointsString(
              (node.points || []).map((point) => ({
                x: point.x * frame.width,
                y: point.y * frame.height,
              })),
            )}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    );
  }
  if (node.type === 'image') {
    const src = safeImage(assets.find((asset) => asset.id === node.image?.assetId));
    return src ? (
      <img
        className="fc-image"
        src={src}
        alt={node.text || node.name}
        draggable={false}
        style={{ objectFit: node.image?.fit || 'cover', borderRadius: node.style.radius ?? 0 }}
      />
    ) : (
      <div className="fc-image-placeholder">
        <ImageIcon size={24} />
        <span>{node.text || 'Image'}</span>
      </div>
    );
  }
  if (node.type === 'divider')
    return (
      <div
        className="fc-divider"
        style={{
          background: node.style.stroke || node.style.background || '#dce0e6',
          height: node.style.strokeWidth ?? 1,
        }}
      />
    );
  if (containers.has(node.type)) return null;
  if (node.type === 'button')
    return (
      <button
        className="fc-text-content fc-button"
        tabIndex={preview ? 0 : -1}
        onClick={
          preview
            ? () => (node.action?.screenId ? onNavigate?.(node.action.screenId) : onUnlinked?.())
            : undefined
        }
      >
        {node.text}
      </button>
    );
  if (node.type === 'input' && preview)
    return (
      <input
        className="fc-text-content fc-input"
        placeholder={node.text || node.name}
        aria-label={node.text || node.name}
      />
    );
  return <div className={`fc-text-content fc-${node.type}`}>{node.text}</div>;
}

function textStyles(node: WireNode, design: DesignTokens): CSSProperties {
  const fontSize =
    node.style.fontSize ??
    (node.type === 'heading'
      ? 32
      : node.type === 'badge'
        ? 12
        : ['button', 'input', 'nav'].includes(node.type)
          ? 14
          : 16);
  const background =
    node.style.background ??
    (node.type === 'button'
      ? design.accent
      : node.type === 'input' || node.type === 'card'
        ? design.surface
        : node.type === 'badge' || node.type === 'image'
          ? '#eef0f4'
          : undefined);
  return {
    color: node.style.color ?? (node.type === 'button' ? '#ffffff' : design.text),
    background: ['rectangle', 'ellipse', 'line', 'path'].includes(node.type)
      ? undefined
      : background,
    borderRadius:
      node.style.radius ??
      (['button', 'input', 'card', 'badge'].includes(node.type) ? design.radius : 0),
    boxShadow: ['rectangle', 'ellipse', 'line', 'path'].includes(node.type)
      ? undefined
      : node.style.stroke
        ? `inset 0 0 0 ${node.style.strokeWidth ?? 1}px ${node.style.stroke}`
        : ['input', 'card'].includes(node.type)
          ? 'inset 0 0 0 1px #dce0e6'
          : undefined,
    fontSize,
    fontWeight: node.style.fontWeight ?? (node.type === 'heading' ? 700 : 400),
    lineHeight: node.type === 'heading' ? 1.2 : 1.5,
    textAlign:
      node.style.align === 'center'
        ? 'center'
        : node.style.align === 'end'
          ? 'right'
          : node.style.align === 'start'
            ? 'left'
            : ['button', 'badge'].includes(node.type)
              ? 'center'
              : 'left',
    '--fc-text-padding': `${node.style.padding ?? (node.type === 'badge' ? 8 : ['input', 'button'].includes(node.type) ? 12 : 0)}px`,
  } as CSSProperties;
}

export default function FreeformCanvas(props: FreeformCanvasProps) {
  const {
    screen,
    selectedIds,
    tool,
    zoom,
    onSelection,
    onCommit,
    onToolChange,
    viewportRef,
    artboardRef,
    design,
    assets,
    comments = [],
    preview = false,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerHitNode = useRef<string | undefined>(undefined);
  const gesture = useRef<Gesture | null>(null);
  const lastDraft = useRef<WireNode[] | null>(null);
  const [draft, setDraft] = useState<WireNode[] | null>(null);
  const [marquee, setMarquee] = useState<Bounds | null>(null);
  const [space, setSpace] = useState(false);
  const [enteredGroup, setEnteredGroup] = useState('');
  const [editing, setEditing] = useState<string>();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editedText = useRef('');
  const textCancelled = useRef(false);
  const nodes = draft || screen.nodes;
  const index = sceneIndex(nodes);
  const selected = rootSelection(nodes, selectedIds, { editable: true });
  const selectedBounds = selectionBounds(nodes, selected);
  const one = selected.length === 1 ? index.get(selected[0]) : undefined;
  const editingNode = editing ? findNode(nodes, editing) : undefined;
  const editingBounds = editing ? worldBounds(nodes, editing) : undefined;
  const width = screen.canvas?.width ?? (screen.platform === 'mobile' ? 375 : 900);
  const height = screen.canvas?.height ?? 720;

  function previewNodes(next: WireNode[] | null) {
    const arranged = next ? reflowAutoLayouts(next) : null;
    lastDraft.current = arranged;
    setDraft(arranged);
  }
  function point(client: { clientX: number; clientY: number }): Point {
    const bounds = rootRef.current?.getBoundingClientRect();
    return bounds
      ? {
          x: (client.clientX - bounds.left) / (bounds.width / width),
          y: (client.clientY - bounds.top) / (bounds.height / height),
        }
      : { x: 0, y: 0 };
  }
  function cancelGesture() {
    const active = gesture.current;
    gesture.current = null;
    if (active?.kind === 'marquee') onSelection(active.originalSelection);
    if (active?.kind === 'pan' && viewportRef?.current) {
      viewportRef.current.scrollLeft = active.scroll.x;
      viewportRef.current.scrollTop = active.scroll.y;
    }
    if (active && rootRef.current?.hasPointerCapture(active.pointerId))
      rootRef.current.releasePointerCapture(active.pointerId);
    previewNodes(null);
    setMarquee(null);
  }
  useEffect(() => {
    const active = gesture.current;
    if (
      active &&
      (active.screenId !== screen.id ||
        active.canvasWidth !== width ||
        active.canvasHeight !== height ||
        !sameSceneData(active.baseline, screen.nodes))
    )
      cancelGesture();
    if (editing && !findNode(screen.nodes, editing)) setEditing(undefined);
  }, [screen.id, screen.nodes, width, height]);
  useEffect(() => {
    const original = editing ? findNode(screen.nodes, editing) : undefined;
    if (!original) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      if (textCancelled.current || editedText.current === original.text) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [editing, screen.nodes]);
  useEffect(() => {
    const release = (event: Event) => {
      if (event.type === 'blur' || (event as KeyboardEvent).code === 'Space') setSpace(false);
    };
    window.addEventListener('keyup', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', release);
    };
  }, []);
  useEffect(() => {
    const viewport = viewportRef?.current;
    if (!viewport || preview) return;
    const previousCursor = viewport.style.cursor;
    if (tool === 'hand' || space) viewport.style.cursor = 'grab';
    let pan: { pointerId: number; x: number; y: number; left: number; top: number } | null = null;
    const stop = (cancelled = false) => {
      const previous = pan;
      pan = null;
      if (!previous) return;
      if (cancelled) {
        viewport.scrollLeft = previous.left;
        viewport.scrollTop = previous.top;
      }
      if (viewport.hasPointerCapture(previous.pointerId))
        viewport.releasePointerCapture(previous.pointerId);
    };
    const down = (event: PointerEvent) => {
      if (pan || gesture.current || editing || rootRef.current?.contains(event.target as Node))
        return;
      if (tool !== 'hand' && !space && event.button !== 1) return;
      if (event.button !== 0 && event.button !== 1) return;
      if ((event.target as Element).closest('button, input, textarea, a, [data-comment-card]'))
        return;
      pan = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
      };
      viewport.setPointerCapture(event.pointerId);
      viewport.focus({ preventScroll: true });
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (!pan || pan.pointerId !== event.pointerId) return;
      viewport.scrollLeft = pan.left - (event.clientX - pan.x);
      viewport.scrollTop = pan.top - (event.clientY - pan.y);
      event.preventDefault();
    };
    const up = (event: PointerEvent) => {
      if (pan?.pointerId === event.pointerId) stop();
    };
    const cancel = () => stop(true);
    const key = (event: KeyboardEvent) => {
      if ((event.target as Element).closest('input, textarea, [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        setSpace(true);
        event.preventDefault();
      }
      if (pan && event.key === 'Escape') {
        stop(true);
        event.preventDefault();
        event.stopPropagation();
      }
    };
    viewport.addEventListener('pointerdown', down);
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', up);
    viewport.addEventListener('pointercancel', cancel);
    viewport.addEventListener('lostpointercapture', cancel);
    viewport.addEventListener('keydown', key);
    window.addEventListener('blur', cancel);
    return () => {
      stop();
      viewport.style.cursor = previousCursor;
      viewport.removeEventListener('pointerdown', down);
      viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', up);
      viewport.removeEventListener('pointercancel', cancel);
      viewport.removeEventListener('lostpointercapture', cancel);
      viewport.removeEventListener('keydown', key);
      window.removeEventListener('blur', cancel);
    };
  }, [viewportRef, tool, space, preview, editing]);
  useEffect(() => {
    if (!editing || !editorRef.current) return;
    editorRef.current.focus();
    editorRef.current.select();
  }, [editing]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !props.onZoomChange) return;
    const wheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || editing || gesture.current) return;
      event.preventDefault();
      const next = clamp(zoom * Math.exp(-event.deltaY * 0.005), 0.05, 4);
      const viewport = viewportRef?.current;
      const before = root.getBoundingClientRect();
      const ratio = next / zoom;
      const anchor = { x: event.clientX - before.left, y: event.clientY - before.top };
      props.onZoomChange?.(next);
      requestAnimationFrame(() => {
        if (!viewport) return;
        const after = root.getBoundingClientRect();
        viewport.scrollLeft += after.left + anchor.x * ratio - event.clientX;
        viewport.scrollTop += after.top + anchor.y * ratio - event.clientY;
      });
    };
    root.addEventListener('wheel', wheel, { passive: false });
    return () => root.removeEventListener('wheel', wheel);
  }, [zoom, editing, props.onZoomChange, viewportRef]);

  function pickNode(id: string, deep = false): string | undefined {
    const entry = index.get(id);
    if (!entry || entry.hidden || entry.locked) return;
    if (deep) return id;
    let result = id;
    let parent = entry.parentId && index.get(entry.parentId);
    while (parent) {
      if (parent.node.id === enteredGroup) break;
      if (parent.node.type === 'group') result = parent.node.id;
      parent = parent.parentId && index.get(parent.parentId);
    }
    return result;
  }
  function startGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (preview || editing || gesture.current || (event.button !== 0 && event.button !== 1)) return;
    const target = event.target instanceof Element ? event.target : null;
    pointerHitNode.current =
      target?.closest('[data-node-id]')?.getAttribute('data-node-id') || undefined;
    if (target?.closest('[data-comment-id], textarea, input')) return;
    const start = point(event);
    const base: BaseGesture = {
      pointerId: event.pointerId,
      start,
      baseline: screen.nodes,
      originalSelection: selectedIds,
      changed: false,
      screenId: screen.id,
      canvasWidth: width,
      canvasHeight: height,
    };
    if (tool === 'hand' || space || event.button === 1) {
      gesture.current = {
        ...base,
        kind: 'pan',
        client: { x: event.clientX, y: event.clientY },
        scroll: {
          x: viewportRef?.current?.scrollLeft || 0,
          y: viewportRef?.current?.scrollTop || 0,
        },
      };
    } else if (tool === 'select' && target?.closest('[data-rotate-handle]') && selectedBounds) {
      const pivot = {
        x: selectedBounds.x + selectedBounds.width / 2,
        y: selectedBounds.y + selectedBounds.height / 2,
      };
      gesture.current = {
        ...base,
        kind: 'rotate',
        ids: selected,
        pivot,
        angle: angle(start, pivot),
      };
    } else if (tool === 'select' && target?.closest('[data-resize-handle]') && selectedBounds) {
      const handle = target
        .closest('[data-resize-handle]')!
        .getAttribute('data-resize-handle') as Handle;
      gesture.current = {
        ...base,
        kind: 'resize',
        ids: selected,
        handle,
        frame: one ? frameFor(one.node) : { ...selectedBounds, rotation: 0 },
        parentInverse: one ? invertMatrix(one.parentMatrix) : undefined,
      };
    } else if (tool === 'comment') {
      const id = target?.closest('[data-node-id]')?.getAttribute('data-node-id');
      const entry = id ? index.get(id) : undefined;
      const local = entry ? transformPoint(invertMatrix(entry.worldMatrix), start) : start;
      const frame = entry ? frameFor(entry.node) : { width, height };
      props.onComment?.({
        kind: entry ? 'node' : 'screen',
        screenId: screen.id,
        ...(entry ? { nodeId: entry.node.id } : {}),
        x: clamp(local.x / frame.width, 0, 1),
        y: clamp(local.y / frame.height, 0, 1),
      });
      event.preventDefault();
      event.stopPropagation();
      return;
    } else if (tool !== 'select') {
      const node = createNode(tool, tool === 'text' ? 'Text' : undefined);
      node.frame = { x: start.x, y: start.y, width: 1, height: 1, rotation: 0 };
      if (tool === 'path')
        node.points = [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ];
      gesture.current = { ...base, kind: 'draw', node, points: [start] };
      previewNodes([...screen.nodes, node]);
    } else {
      const targetId = target?.closest('[data-node-id]')?.getAttribute('data-node-id');
      const id = targetId ? pickNode(targetId, event.ctrlKey || event.metaKey) : undefined;
      if (
        enteredGroup &&
        (!targetId ||
          (targetId !== enteredGroup &&
            !findNode(index.get(enteredGroup)?.node.children || [], targetId)))
      )
        setEnteredGroup('');
      if (id) {
        const next = event.shiftKey
          ? selectedIds.includes(id)
            ? selectedIds.filter((item) => item !== id)
            : [...selectedIds, id]
          : selectedIds.includes(id)
            ? selectedIds
            : [id];
        onSelection(next);
        const movable = rootSelection(screen.nodes, next, { editable: true, movable: true });
        if (movable.length && next.includes(id))
          gesture.current = { ...base, kind: 'move', ids: movable };
      } else {
        if (!event.shiftKey) onSelection([]);
        gesture.current = { ...base, kind: 'marquee', additive: event.shiftKey };
        setMarquee({ ...start, width: 0, height: 0 });
      }
    }
    if (gesture.current) {
      event.preventDefault();
      event.stopPropagation();
      rootRef.current?.focus({ preventScroll: true });
      rootRef.current?.setPointerCapture(event.pointerId);
    }
  }

  function drawNode(
    active: Extract<Gesture, { kind: 'draw' }>,
    current: Point,
    constrain: boolean,
  ) {
    let frame: NodeFrame = { ...boxBetween(active.start, current), rotation: 0 };
    frame.width = Math.max(1, frame.width);
    frame.height = Math.max(1, frame.height);
    if (constrain && (active.node.type === 'rectangle' || active.node.type === 'ellipse')) {
      const size = Math.max(frame.width, frame.height);
      frame = {
        x: current.x < active.start.x ? active.start.x - size : active.start.x,
        y: current.y < active.start.y ? active.start.y - size : active.start.y,
        width: size,
        height: size,
        rotation: 0,
      };
    }
    if (active.node.type === 'line') {
      const length = Math.max(1, distance(active.start, current));
      const direction = constrain
        ? Math.round(angle(current, active.start) / 15) * 15
        : angle(current, active.start);
      const end = {
        x: active.start.x + Math.cos((direction * Math.PI) / 180) * length,
        y: active.start.y + Math.sin((direction * Math.PI) / 180) * length,
      };
      frame = {
        x: (active.start.x + end.x) / 2 - length / 2,
        y: (active.start.y + end.y) / 2 - 0.5,
        width: length,
        height: 1,
        rotation: direction - (Math.atan2(1, length) * 180) / Math.PI,
      };
    }
    if (active.node.type === 'path') {
      const points = active.points;
      const minX = Math.min(...points.map((p) => p.x)),
        minY = Math.min(...points.map((p) => p.y));
      frame = {
        x: minX,
        y: minY,
        width: Math.max(1, Math.max(...points.map((p) => p.x)) - minX),
        height: Math.max(1, Math.max(...points.map((p) => p.y)) - minY),
        rotation: 0,
      };
      const sampled =
        points.length <= 256
          ? points
          : points.filter(
              (_, i) => i % Math.ceil(points.length / 255) === 0 || i === points.length - 1,
            );
      return {
        ...active.node,
        frame: normalizeFrame(frame),
        points: (sampled.length > 1 ? sampled : [sampled[0], sampled[0]]).map((p) => ({
          x: clamp((p.x - frame.x) / frame.width, 0, 1),
          y: clamp((p.y - frame.y) / frame.height, 0, 1),
        })),
      };
    }
    return { ...active.node, frame: normalizeFrame(frame) };
  }
  function updateGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const current = point(event);
    active.changed ||= distance(active.start, current) * zoom > 2;
    if (active.kind === 'pan') {
      if (viewportRef?.current) {
        viewportRef.current.scrollLeft = active.scroll.x - (event.clientX - active.client.x);
        viewportRef.current.scrollTop = active.scroll.y - (event.clientY - active.client.y);
      }
    } else if (active.kind === 'move') {
      let dx = current.x - active.start.x,
        dy = current.y - active.start.y;
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      previewNodes(moveNodes(active.baseline, active.ids, dx, dy));
    } else if (active.kind === 'resize') {
      const local = active.parentInverse ? transformPoint(active.parentInverse, current) : current;
      const start = active.parentInverse
        ? transformPoint(active.parentInverse, active.start)
        : active.start;
      const next = resizeFrame(
        active.frame,
        active.handle,
        local.x - start.x,
        local.y - start.y,
        event.shiftKey ||
          active.ids.length > 1 ||
          findNode(active.baseline, active.ids[0])?.type === 'group',
      );
      if (active.ids.length === 1) previewNodes(resizeNode(active.baseline, active.ids[0], next));
      else {
        const scale = next.width / active.frame.width;
        const snapshot = sceneIndex(active.baseline);
        let result = active.baseline;
        for (const id of active.ids) {
          const entry = snapshot.get(id);
          if (!entry) continue;
          const frame = frameFor(entry.node);
          const center = transformPoint(entry.worldMatrix, {
            x: frame.width / 2,
            y: frame.height / 2,
          });
          const moved = {
            x: next.x + (center.x - active.frame.x) * scale,
            y: next.y + (center.y - active.frame.y) * scale,
          };
          const localCenter = transformPoint(invertMatrix(entry.parentMatrix), moved);
          result = resizeNode(result, id, {
            ...frame,
            x: localCenter.x - (frame.width * scale) / 2,
            y: localCenter.y - (frame.height * scale) / 2,
            width: frame.width * scale,
            height: frame.height * scale,
          });
        }
        previewNodes(result);
      }
    } else if (active.kind === 'rotate') {
      let degrees = angle(current, active.pivot) - active.angle;
      if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
      previewNodes(rotateNodes(active.baseline, active.ids, degrees, active.pivot));
    } else if (active.kind === 'marquee') {
      const box = boxBetween(active.start, current);
      setMarquee(box);
      const selected = [...sceneIndex(active.baseline).values()]
        .filter((entry) => {
          if (entry.hidden || entry.locked) return false;
          const bounds = worldBounds(active.baseline, entry.node.id);
          if (
            bounds &&
            containers.has(entry.node.type) &&
            entry.node.type !== 'group' &&
            entry.node.children.length
          )
            return (
              bounds.x >= box.x &&
              bounds.y >= box.y &&
              bounds.x + bounds.width <= box.x + box.width &&
              bounds.y + bounds.height <= box.y + box.height
            );
          return (
            bounds &&
            bounds.x < box.x + box.width &&
            bounds.x + bounds.width > box.x &&
            bounds.y < box.y + box.height &&
            bounds.y + bounds.height > box.y
          );
        })
        .map((entry) => pickNode(entry.node.id))
        .filter((id): id is string => Boolean(id));
      onSelection([
        ...new Set([...(active.additive ? active.originalSelection : []), ...selected]),
      ]);
    } else if (active.kind === 'draw') {
      if (active.node.type === 'path' && distance(active.points.at(-1)!, current) * zoom >= 2) {
        active.points.push(current);
        if (active.points.length > 4096)
          active.points = active.points.filter(
            (_, i) => i % 2 === 0 || i === active.points.length - 1,
          );
      }
      previewNodes([...active.baseline, drawNode(active, current, event.shiftKey)]);
    }
    event.preventDefault();
    event.stopPropagation();
  }
  function finishGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    updateGesture(event);
    gesture.current = null;
    if (rootRef.current?.hasPointerCapture(event.pointerId))
      rootRef.current.releasePointerCapture(event.pointerId);
    let next = lastDraft.current;
    if (active.kind === 'draw') {
      if (!active.changed) {
        const node = {
          ...active.node,
          frame: {
            x: active.start.x,
            y: active.start.y,
            width: active.node.type === 'text' ? 240 : 160,
            height: active.node.type === 'text' ? 40 : active.node.type === 'line' ? 1 : 120,
            rotation: 0,
          },
        };
        next = [...active.baseline, node];
      }
      if (next) {
        onCommit(next);
        onSelection([active.node.id]);
        onToolChange?.('select');
        if (active.node.type === 'text') beginText(active.node.id, 'Text');
      }
    } else if (
      active.changed &&
      next &&
      (active.kind === 'move' || active.kind === 'resize' || active.kind === 'rotate')
    )
      onCommit(next);
    previewNodes(null);
    setMarquee(null);
    event.preventDefault();
    event.stopPropagation();
  }

  function beginText(id: string, text: string) {
    textCancelled.current = false;
    editedText.current = text;
    setEditing(id);
  }
  function finishText() {
    if (!editing) return;
    const id = editing;
    setEditing(undefined);
    const original = findNode(screen.nodes, id);
    if (!textCancelled.current && original && original.text !== editedText.current)
      onCommit(
        mapNodes(screen.nodes, id, (node) => ({
          ...node,
          text: editedText.current.slice(0, 4000),
        })),
      );
    requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }));
  }
  function renderNodes(items: WireNode[]): React.ReactNode {
    return items.map((node) => {
      const entry = index.get(node.id);
      if (!entry || entry.hidden) return null;
      const frame = frameFor(node);
      const nodeComments = comments.filter(
        (comment) =>
          comment.target.kind === 'node' &&
          comment.target.nodeId === node.id &&
          comment.status !== 'resolved',
      );
      const worldRotation = (Math.atan2(entry.worldMatrix.b, entry.worldMatrix.a) * 180) / Math.PI;
      return (
        <div
          key={node.id}
          data-node-id={node.id}
          data-layer-type={node.type}
          data-locked={entry.locked || undefined}
          className={`fc-layer fc-layer-${node.type}${entry.locked ? ' is-locked' : ''}`}
          role={preview ? undefined : 'button'}
          aria-label={`${node.name} layer`}
          aria-pressed={preview ? undefined : selectedIds.includes(node.id)}
          tabIndex={preview ? undefined : selectedIds.includes(node.id) ? 0 : -1}
          style={
            {
              ...textStyles(node, design),
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
              transform: `rotate(${frame.rotation}deg)`,
              opacity: node.style.opacity ?? 1,
              '--fc-world-angle': `${worldRotation}deg`,
            } as CSSProperties
          }
        >
          {editing === node.id ? (
            <textarea
              ref={editorRef}
              className="fc-inline-editor"
              aria-label={`Edit ${node.name} text`}
              defaultValue={node.text}
              maxLength={4000}
              onChange={(event) => {
                editedText.current = event.target.value;
              }}
              onBlur={finishText}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                  event.preventDefault();
                  textCancelled.current = true;
                  finishText();
                } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  finishText();
                }
              }}
            />
          ) : (
            <Visual
              node={node}
              design={design}
              assets={assets}
              preview={preview}
              onNavigate={props.onNavigate}
              onUnlinked={props.onUnlinked}
            />
          )}
          {renderNodes(node.children)}
          {!preview && nodeComments.length > 0 && (
            <WireframeCommentPins
              comments={nodeComments}
              allComments={comments}
              selectedId={props.selectedCommentId}
              onSelect={(comment) => props.onCommentSelect?.(comment)}
            />
          )}
        </div>
      );
    });
  }
  const overlayMatrix = one?.worldMatrix;
  const overlayFrame = one
    ? frameFor(one.node)
    : selectedBounds
      ? { ...selectedBounds, rotation: 0 }
      : undefined;
  const overlayPoint = (x: number, y: number) =>
    overlayMatrix
      ? transformPoint(overlayMatrix, { x, y })
      : { x: (selectedBounds?.x || 0) + x, y: (selectedBounds?.y || 0) + y };
  const rotationAnchor = overlayFrame
    ? overlayPoint(overlayFrame.width / 2, -28 / zoom)
    : undefined;
  const rotationBase = overlayFrame ? overlayPoint(overlayFrame.width / 2, 0) : undefined;

  return (
    <div
      ref={(element) => {
        rootRef.current = element;
        if (artboardRef) artboardRef.current = element;
      }}
      className={`freeform-canvas tool-${tool}${space ? ' is-panning' : ''}${preview ? ' is-preview' : ''}`}
      aria-label={`${screen.name} design frame`}
      tabIndex={0}
      data-canvas-screen={screen.id}
      style={
        {
          width,
          height,
          zoom,
          background: design.surface,
          color: design.text,
          fontFamily: design.font === 'serif' ? 'Georgia, serif' : undefined,
          '--wf-zoom': zoom,
        } as CSSProperties
      }
      onPointerDown={startGesture}
      onPointerMove={updateGesture}
      onPointerUp={finishGesture}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={() => {
        if (gesture.current) cancelGesture();
      }}
      onDoubleClick={(event) => {
        if (preview || tool !== 'select' || editing) return;
        // Capture can retarget the synthesized double-click to the artboard.
        // Keep the actual layer hit from pointer-down for text and group editing.
        const id =
          (event.target as Element).closest('[data-node-id]')?.getAttribute('data-node-id') ||
          pointerHitNode.current;
        if (!id) return;
        const entry = index.get(id);
        if (!entry || entry.hidden || entry.locked) return;
        const grouped = pickNode(id);
        if (grouped && grouped !== id) {
          setEnteredGroup(grouped);
          onSelection([id]);
        }
        if (editableText.has(entry.node.type)) {
          onSelection([id]);
          beginText(id, entry.node.text);
        } else if (entry.node.type === 'group') {
          setEnteredGroup(id);
          onSelection(entry.node.children[0] ? [entry.node.children[0].id] : [id]);
        }
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          (event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')
        )
          return;
        if (event.key === 'Escape') {
          if (gesture.current) cancelGesture();
          else {
            onSelection([]);
            setEnteredGroup('');
          }
          onToolChange?.('select');
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.code === 'Space' && !preview) {
          setSpace(true);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          !preview &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) &&
          selected.length
        ) {
          const amount = event.shiftKey ? 10 : 1;
          onCommit(
            moveNodes(
              screen.nodes,
              selected,
              event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0,
              event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0,
            ),
          );
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {renderNodes(nodes)}
      {editingNode && editingBounds && (
        <div
          className="fc-text-edit-hint"
          role="status"
          style={{
            left: editingBounds.x,
            top: editingBounds.y - 8 / zoom,
            fontSize: 10 / zoom,
            padding: `${4 / zoom}px ${7 / zoom}px`,
            borderRadius: 4 / zoom,
          }}
        >
          Text draft · Click outside or Ctrl/⌘ Enter to save · Esc to cancel
        </div>
      )}
      {!preview && (
        <WireframeCommentPins
          comments={comments.filter(
            (comment) => comment.target.kind === 'screen' && comment.status !== 'resolved',
          )}
          allComments={comments}
          selectedId={props.selectedCommentId}
          onSelect={(comment) => props.onCommentSelect?.(comment)}
        />
      )}
      {!preview && !editingNode && (
        <svg
          className="fc-selection-overlay"
          width={width}
          height={height}
          aria-label="Canvas selection"
        >
          {selected.map((id) => {
            const entry = index.get(id);
            if (!entry) return null;
            const frame = frameFor(entry.node);
            return (
              <polygon
                key={id}
                points={pointsString(corners(frame.width, frame.height, entry.worldMatrix))}
                fill="none"
                stroke="#7b61df"
                strokeWidth={1 / zoom}
              />
            );
          })}
          {selected.length > 1 && selectedBounds && (
            <rect
              {...selectedBounds}
              fill="none"
              stroke="#7b61df"
              strokeWidth={1 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            />
          )}
          {tool === 'select' &&
            overlayFrame &&
            handles.map((handle) => {
              const p = overlayPoint(handle.x * overlayFrame.width, handle.y * overlayFrame.height);
              return (
                <g
                  key={handle.key}
                  data-resize-handle={handle.key}
                  className={`fc-resize-handle handle-${handle.key}`}
                  aria-label={`Resize ${handle.key}`}
                >
                  <rect
                    x={p.x - 9 / zoom}
                    y={p.y - 9 / zoom}
                    width={18 / zoom}
                    height={18 / zoom}
                    fill="transparent"
                  />
                  <rect
                    x={p.x - 3.5 / zoom}
                    y={p.y - 3.5 / zoom}
                    width={7 / zoom}
                    height={7 / zoom}
                    fill="white"
                    stroke="#7b61df"
                    strokeWidth={1 / zoom}
                  />
                </g>
              );
            })}
          {tool === 'select' && rotationAnchor && rotationBase && (
            <g data-rotate-handle="true" className="fc-rotate-handle" aria-label="Rotate selection">
              <line
                x1={rotationBase.x}
                y1={rotationBase.y}
                x2={rotationAnchor.x}
                y2={rotationAnchor.y}
                stroke="#7b61df"
                strokeWidth={1 / zoom}
              />
              <circle cx={rotationAnchor.x} cy={rotationAnchor.y} r={9 / zoom} fill="transparent" />
              <circle
                cx={rotationAnchor.x}
                cy={rotationAnchor.y}
                r={4 / zoom}
                fill="white"
                stroke="#7b61df"
                strokeWidth={1 / zoom}
              />
            </g>
          )}
          {marquee && (
            <rect {...marquee} fill="#8a74e61a" stroke="#7b61df" strokeWidth={1 / zoom} />
          )}
        </svg>
      )}
    </div>
  );
}
