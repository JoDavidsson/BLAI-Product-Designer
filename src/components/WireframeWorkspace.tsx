import {
  cloneElement,
  Fragment,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Circle,
  Hand,
  Pencil,
  Upload,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  GripVertical,
  Image as ImageIcon,
  LayoutGrid,
  LayoutPanelTop,
  Maximize2,
  MessageCircle,
  Minus,
  Monitor,
  MousePointer2,
  Play,
  ClipboardPaste,
  Plus,
  RectangleHorizontal,
  Rows3,
  Search,
  Smartphone,
  Sparkles,
  Square,
  TextCursorInput,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import {
  createNode,
  findNode,
  reconcileReferences,
  uid,
  type Annotation,
  type AnnotationTarget,
  type BoardAsset,
  type DesignTokens,
  type JobKind,
  type NodeType,
  type Project,
  type Screen,
  type ScreenState,
  type WireNode,
} from '../../shared/model';
import { projectSchema } from '../../shared/validation';
import AnnotationPanel from './AnnotationPanel';
import WireframeCommentMargin, {
  COMMENT_MARGIN_GAP,
  COMMENT_MARGIN_WIDTH,
  WireframeCommentPins,
} from './WireframeComments';
import {
  CONTAINERS,
  cloneWireNode,
  nodeParent,
  reparentNode,
  wireframeLimitError,
} from '../lib/wireframe-tree';
import FreeformCanvas, { type CanvasTool } from './FreeformCanvas';
import CanvasInspector from './CanvasInspector';
import CanvasLayers from './CanvasLayers';
import {
  defaultFrame,
  frameFor,
  sceneIndex,
  rootSelection,
  resizeNode,
  moveNodes,
  groupNodes,
  ungroupNodes,
  reparentNodes,
  alignNodes,
  distributeNodes,
  reorderNodes,
  reflowContainer,
  reflowAutoLayouts,
} from '../lib/freeform-geometry';
import './wireframe.css';
import './canvas-workspace.css';

interface Props {
  project: Project;
  onChange: (project: Project) => void;
  onToast: (message: string) => void;
  onGenerate: (kind: JobKind, instruction: string, screenId?: string) => void;
  helperOnline: boolean;
  editingEpoch?: number;
  onImageAdded?: (
    asset: BoardAsset,
    projectId: string,
    screenId: string,
    node: WireNode,
    expectedEpoch: number,
  ) => boolean;
  /** Open a source from the product overview without changing project content. */
  focusTarget?: { screenId: string; nodeId?: string; requestId: number };
}

const STATES: ScreenState[] = ['default', 'loading', 'empty', 'error', 'success'];
const COMPONENTS = [
  { type: 'heading', name: 'Heading', icon: Type, detail: 'Make a statement' },
  { type: 'text', name: 'Text', icon: Rows3, detail: 'Give it context' },
  { type: 'button', name: 'Button', icon: RectangleHorizontal, detail: 'A clear next step' },
  { type: 'input', name: 'Input', icon: TextCursorInput, detail: 'Collect information' },
  { type: 'image', name: 'Image', icon: ImageIcon, detail: 'Room for a visual' },
  { type: 'card', name: 'Card', icon: Square, detail: 'Group a little detail' },
  { type: 'row', name: 'Row', icon: Columns2, detail: 'Arrange side by side' },
  { type: 'column', name: 'Column', icon: Rows3, detail: 'Stack content' },
  { type: 'section', name: 'Section', icon: LayoutPanelTop, detail: 'Give ideas space' },
  { type: 'nav', name: 'Navigation', icon: LayoutGrid, detail: 'Find your way' },
  { type: 'badge', name: 'Badge', icon: RectangleHorizontal, detail: 'A small highlight' },
  { type: 'divider', name: 'Divider', icon: Minus, detail: 'A quiet separation' },
] satisfies { type: NodeType; name: string; icon: typeof Type; detail: string }[];

function removeNode(nodes: WireNode[], id: string): WireNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, children: removeNode(node.children, id) }));
}
function mapNode(nodes: WireNode[], id: string, update: (node: WireNode) => WireNode): WireNode[] {
  return nodes.map((node) =>
    node.id === id ? update(node) : { ...node, children: mapNode(node.children, id, update) },
  );
}
function containingList(nodes: WireNode[], id: string): WireNode[] | undefined {
  if (nodes.some((node) => node.id === id)) return nodes;
  for (const node of nodes) {
    const found = containingList(node.children, id);
    if (found) return found;
  }
}
function countNodes(nodes: WireNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

// A dragged component's center can be far from its handle. Hit-test the pointer
// against the smallest nested target so dropping on a child does not choose an
// adjacent column or its parent container instead.
const canvasCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args).filter((hit) => hit.id !== args.active.id);
  if (hits.length > 0)
    return hits.sort((left, right) => {
      const a = args.droppableRects.get(left.id),
        b = args.droppableRects.get(right.id);
      return (a ? a.width * a.height : Infinity) - (b ? b.width * b.height : Infinity);
    });
  return closestCenter(args);
};

function starterNodes(name: string): WireNode[] {
  const nav = createNode('nav', 'Your product     Overview     Explore');
  const badge = createNode('badge', 'A fresh start');
  const heading = createNode(
    'heading',
    name === 'Untitled screen' ? 'Make something meaningful.' : name,
  );
  const text = createNode(
    'text',
    'A thoughtful space for your next big idea. Start with the essentials and make it your own.',
  );
  const button = createNode('button', 'Get started');
  const section = createNode('section');
  section.children = [badge, heading, text, button];
  section.style = { padding: 32, gap: 20 };
  return [nav, section];
}

function templateNodes(template: 'hero' | 'cards' | 'form'): WireNode {
  if (template === 'hero') {
    const node = createNode('section');
    node.name = 'Hero section';
    node.style = { padding: 32, gap: 16 };
    node.children = [
      createNode('badge', 'Introducing your next idea'),
      createNode('heading', 'A little less friction. A lot more possibility.'),
      createNode(
        'text',
        'Explain what makes your product useful in one clear, compelling sentence.',
      ),
      createNode('button', 'Start exploring'),
    ];
    return node;
  }
  if (template === 'form') {
    const node = createNode('card');
    node.name = 'Sign-up form';
    node.children = [
      createNode('heading', 'Welcome aboard'),
      createNode('text', 'A few details and you’re ready to go.'),
      createNode('input', 'Your name'),
      createNode('input', 'Email address'),
      createNode('button', 'Create account'),
    ];
    return node;
  }
  const row = createNode('row');
  row.name = 'Feature cards';
  row.children = ['Thoughtful by design', 'Everything in one place', 'Ready when you are'].map(
    (title, index) => {
      const card = createNode('card');
      card.children = [
        createNode('badge', `0${index + 1}`),
        createNode('heading', title),
        createNode('text', 'A small detail that makes a big difference.'),
      ];
      return card;
    },
  );
  return row;
}

interface RenderProps {
  nodes: WireNode[];
  design: DesignTokens;
  preview?: boolean;
  onNavigate?: (screenId: string) => void;
  onUnlinked?: () => void;
  selectedId?: string;
  onSelect?: (node: WireNode, event: MouseEvent<HTMLDivElement>) => void;
  comments?: Annotation[];
  selectedCommentId?: string;
  onCommentSelect?: (comment: Annotation) => void;
  commentMode?: boolean;
}

/** The same structured renderer is used for editing and the clickable prototype. */
export function WireframeRenderer(props: RenderProps) {
  if (props.preview)
    return (
      <>
        {props.nodes.map((node) => (
          <div
            key={node.id}
            className={`wf-node wf-node-${node.type}`}
            data-node-id={node.id}
            style={nodeStyle(node, props.design)}
          >
            <NodeContent node={node} {...props} />
          </div>
        ))}
      </>
    );
  return (
    <SortableContext
      items={props.nodes.map((node) => node.id)}
      strategy={verticalListSortingStrategy}
    >
      {props.nodes.map((node) => (
        <EditableNode key={node.id} node={node} {...props} />
      ))}
    </SortableContext>
  );
}

function nodeStyle(node: WireNode, design: DesignTokens): CSSProperties {
  return {
    background: node.style.background,
    color: node.style.color,
    fontSize: node.style.fontSize ? `${node.style.fontSize}px` : undefined,
    padding: node.style.padding !== undefined ? `${node.style.padding}px` : undefined,
    gap: node.style.gap !== undefined ? `${node.style.gap}px` : undefined,
    borderRadius: node.style.radius !== undefined ? `${node.style.radius}px` : undefined,
    textAlign:
      node.style.align === 'start'
        ? 'left'
        : node.style.align === 'end'
          ? 'right'
          : node.style.align,
    '--wf-accent': design.accent,
    '--wf-radius': `${design.radius}px`,
  } as CSSProperties;
}

function EditableNode({ node, ...props }: RenderProps & { node: WireNode }) {
  const sortable = useSortable({ id: node.id, disabled: props.commentMode });
  const selected = props.selectedId === node.id;
  const comments =
    props.comments?.filter(
      (comment) =>
        comment.target.kind === 'node' &&
        comment.target.nodeId === node.id &&
        comment.status !== 'resolved',
    ) ?? [];
  return (
    <div
      ref={sortable.setNodeRef}
      className={`wf-node wf-node-${node.type}${selected ? ' is-selected' : ''}${sortable.isDragging ? ' is-dragging' : ''}${props.commentMode ? ' is-commenting' : ''}`}
      data-node-id={node.id}
      tabIndex={selected ? 0 : -1}
      aria-label={`${node.name} component`}
      style={{
        ...nodeStyle(node, props.design),
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      onClick={(event) => {
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        props.onSelect?.(node, event);
      }}
    >
      <NodeContent node={node} {...props} />
      {selected && !props.commentMode && (
        <div className="wf-selection-label">
          <button
            type="button"
            aria-label={`Drag ${node.name}`}
            className="wf-drag-handle"
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical size={12} />
          </button>
          <span>{node.name}</span>
        </div>
      )}
      {comments.length > 0 && (
        <WireframeCommentPins
          comments={comments}
          allComments={props.comments ?? []}
          selectedId={props.selectedCommentId}
          onSelect={(comment) => props.onCommentSelect?.(comment)}
        />
      )}
    </div>
  );
}

function NodeContent({ node, ...props }: RenderProps & { node: WireNode }) {
  const children =
    node.children.length > 0 ? <WireframeRenderer {...props} nodes={node.children} /> : null;
  if (CONTAINERS.includes(node.type))
    return (
      <>{children || <span className="wf-empty-container">{node.name} · add a component</span>}</>
    );
  switch (node.type) {
    case 'heading':
      return (
        <>
          <h2>{node.text}</h2>
          {children}
        </>
      );
    case 'text':
      return (
        <>
          <p>{node.text}</p>
          {children}
        </>
      );
    case 'button':
      return (
        <button
          type="button"
          tabIndex={props.preview ? 0 : -1}
          onClick={
            props.preview
              ? () =>
                  node.action?.screenId
                    ? props.onNavigate?.(node.action.screenId)
                    : props.onUnlinked?.()
              : undefined
          }
        >
          {node.text}
          <ArrowRight size={15} />
        </button>
      );
    case 'input':
      return props.preview ? (
        <input aria-label={node.text || node.name} placeholder={node.text} />
      ) : (
        <div className="wf-fake-input">
          <span>{node.text || 'Input field'}</span>
        </div>
      );
    case 'image':
      return (
        <div className="wf-image-placeholder">
          <div className="wf-image-shape">
            <ImageIcon size={28} strokeWidth={1.2} />
          </div>
          <span>{node.text || 'Image placeholder'}</span>
        </div>
      );
    case 'nav':
      return (
        <div className="wf-nav-content">
          <div className="wf-brand-mark">
            <Square size={15} />
          </div>
          <span>{node.text}</span>
          <div className="wf-avatar-dot">J</div>
        </div>
      );
    case 'badge':
      return <span className="wf-badge-content">{node.text}</span>;
    case 'divider':
      return <hr />;
    default:
      return (
        <>
          {node.text}
          {children}
        </>
      );
  }
}

export default function WireframeWorkspace({
  project,
  onChange,
  onToast,
  onGenerate,
  helperOnline,
  focusTarget,
  editingEpoch = 0,
  onImageAdded,
}: Props) {
  const [screenId, setScreenId] = useState(project.screens[0]?.id ?? '');
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tool, setTool] = useState<CanvasTool>('select');
  const [canvasClipboard, setCanvasClipboard] = useState<WireNode[]>([]);
  const [imagesOpen, setImagesOpen] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageDialog = useRef<HTMLDialogElement>(null);
  const projectRef = useRef(project);
  const epochRef = useRef(editingEpoch);
  const mounted = useRef(true);
  const uploadController = useRef<AbortController | null>(null);
  projectRef.current = project;
  epochRef.current = editingEpoch;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    uploadController.current?.abort();
    setImagesOpen(false);
    setImageBusy(false);
  }, [project.id]);
  useEffect(() => {
    if (imagesOpen) imageDialog.current?.showModal();
    else imageDialog.current?.close();
  }, [imagesOpen]);
  const [library, setLibrary] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [preview, setPreview] = useState(false);
  const [zoom, setZoom] = useState(0.8);
  const [fitRequest, setFitRequest] = useState(0);
  const [commentMode, setCommentMode] = useState(false);
  const [inspector, setInspector] = useState<'properties' | 'comments'>('properties');
  const [commentTarget, setCommentTarget] = useState<AnnotationTarget>();
  const [selectedComment, setSelectedComment] = useState<Annotation>();
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiMode, setAiMode] = useState<'generate' | 'refine'>('generate');
  const [newState, setNewState] = useState<ScreenState>('empty');
  const [clipboard, setClipboard] = useState<WireNode>();
  const [screenName, setScreenName] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const commentFrame = useRef<HTMLDivElement>(null);
  const artboard = useRef<HTMLDivElement>(null);
  const aiDialog = useRef<HTMLElement>(null);
  const aiReturnFocus = useRef<HTMLElement | null>(null);
  const handledFocusRequest = useRef<number | undefined>(undefined);
  const pendingNodeFocus = useRef<string | undefined>(undefined);
  const previousScreenId = useRef(screenId);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 7 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const screen = project.screens.find((item) => item.id === screenId) ?? project.screens[0];
  const selected = screen && selectedId ? findNode(screen.nodes, selectedId) : undefined;
  const parentId = selected && screen ? (nodeParent(screen.nodes, selected.id) ?? '') : '';
  const freeform = !!screen?.canvas;
  const frameWidth = screen?.canvas?.width ?? (screen?.platform === 'mobile' ? 375 : 900);
  const screenComments = project.comments.filter(
    (comment) => comment.target.screenId === screen?.id,
  );
  const openCommentCount = screenComments.filter((comment) => comment.status === 'open').length;
  const visibleComments = screenComments.filter((comment) => comment.status !== 'resolved');
  const commentSpace =
    !preview && visibleComments.length > 0 ? COMMENT_MARGIN_GAP + COMMENT_MARGIN_WIDTH : 0;

  useEffect(() => {
    if (screen && screen.id !== screenId) setScreenId(screen.id);
  }, [screen?.id, screenId]);
  useEffect(() => {
    setScreenName(screen?.name ?? '');
  }, [screen?.id, screen?.name]);
  useEffect(() => {
    if (previousScreenId.current === screenId) return;
    previousScreenId.current = screenId;
    setSelectedId(undefined);
    setSelectedIds([]);
    setTool('select');
    setCommentTarget(undefined);
    setSelectedComment(undefined);
  }, [screenId]);
  useEffect(() => {
    if (!focusTarget || handledFocusRequest.current === focusTarget.requestId) return;
    const destination = project.screens.find((item) => item.id === focusTarget.screenId);
    if (!destination) {
      handledFocusRequest.current = focusTarget.requestId;
      return;
    }
    setPreview(false);
    setLibrary(false);
    setCommentMode(false);
    setInspector('properties');
    setCommentTarget(undefined);
    setSelectedComment(undefined);
    setAiOpen(false);
    if (screenId !== destination.id) {
      setScreenId(destination.id);
      return;
    }
    // Apply the node after the screen change clears its previous selection.
    handledFocusRequest.current = focusTarget.requestId;
    const nodeId =
      focusTarget.nodeId && findNode(destination.nodes, focusTarget.nodeId)
        ? focusTarget.nodeId
        : undefined;
    pendingNodeFocus.current = nodeId;
    setSelectedId(nodeId);
    setSelectedIds(nodeId ? [nodeId] : []);
    if (!nodeId) viewport.current?.scrollTo({ top: 0, left: 0 });
  }, [focusTarget, project.screens, screenId]);
  useEffect(() => {
    if (!pendingNodeFocus.current || pendingNodeFocus.current !== selectedId || preview) return;
    const element = [
      ...(viewport.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? []),
    ].find((item) => item.dataset.nodeId === selectedId);
    if (!element) return;
    pendingNodeFocus.current = undefined;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.focus({ preventScroll: true });
  }, [screenId, selectedId, preview, focusTarget?.requestId]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => fitCanvas());
    observer.observe(element);
    return () => observer.disconnect();
  }, [frameWidth, preview, commentSpace, freeform, screen?.id]);
  useEffect(() => {
    if (!freeform || !fitRequest) return;
    const task = requestAnimationFrame(() => {
      const container = viewport.current;
      const frame = artboard.current;
      if (!container || !frame) return;
      // Source links focus their target layer; automatic fitting must keep that target visible.
      const focusedLayer =
        document.activeElement instanceof HTMLElement &&
        document.activeElement.dataset.nodeId &&
        frame.contains(document.activeElement)
          ? document.activeElement
          : undefined;
      const viewportBounds = container.getBoundingClientRect();
      const frameBounds = frame.getBoundingClientRect();
      const fittedComments = container.clientWidth >= 720 ? commentSpace : 0;
      const left = Math.max(24, (container.clientWidth - frameBounds.width - fittedComments) / 2);
      container.scrollTo({
        left: container.scrollLeft + frameBounds.left - viewportBounds.left - left,
        top: container.scrollTop + frameBounds.top - viewportBounds.top - 48,
      });
      focusedLayer?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(task);
  }, [fitRequest]);
  useEffect(() => {
    if (!aiOpen) return;
    aiDialog.current?.querySelector('textarea')?.focus();
    return () => aiReturnFocus.current?.focus({ preventScroll: true });
  }, [aiOpen]);

  function openDesigner(mode: 'generate' | 'refine') {
    aiReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAiMode(mode);
    setAiOpen(true);
  }

  function handleKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (aiOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setAiOpen(false);
      }
      if (event.key === 'Tab') {
        const controls = [
          ...(aiDialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea, input, select, [tabindex="0"]',
          ) ?? []),
        ];
        const index = controls.indexOf(target);
        if (index === -1 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
          event.preventDefault();
          controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
        }
      }
      return;
    }
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === 'Escape') {
      setSelectedIds([]);
      setTool('select');
      setSelectedId(undefined);
      setCommentMode(false);
      return;
    }
    if (preview || !target.closest('.wf-canvas-scroll, .wf-layer-list')) return;
    if (
      screen?.canvas &&
      target.closest('.wf-layer-list') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      event.preventDefault();
      const distance = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0;
      const dy = event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0;
      if (rootSelection(screen.nodes, selectedIds, { movable: true }).length)
        updateScreen({ nodes: moveNodes(screen.nodes, selectedIds, dx, dy) });
      return;
    }
    if (
      freeform &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key.toLowerCase() === 'g'
    ) {
      event.preventDefault();
      if (event.shiftKey) ungroupCanvas();
      else groupCanvas();
      return;
    }
    if (freeform && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectCanvas(
        [...sceneIndex(screen!.nodes).values()]
          .filter((entry) => !entry.locked && !entry.hidden)
          .map((entry) => entry.node.id),
      );
      return;
    }
    const command = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (command && event.key.toLowerCase() === 'd' && selected) {
      event.preventDefault();
      duplicateSelected();
    } else if (
      command &&
      event.key.toLowerCase() === 'c' &&
      selected &&
      !window.getSelection()?.toString()
    ) {
      event.preventDefault();
      copySelected();
    } else if (
      command &&
      event.key.toLowerCase() === 'v' &&
      (clipboard || canvasClipboard.length)
    ) {
      event.preventDefault();
      pasteComponent();
    } else if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      selected &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      deleteSelected();
    }
  }

  function changeScreens(screens: Screen[]): boolean {
    const error = wireframeLimitError(screens);
    if (error) {
      onToast(error);
      return false;
    }
    const candidate = { ...project, screens };
    const validation = projectSchema.safeParse(candidate);
    if (!validation.success) {
      const issue = validation.error.issues[0];
      onToast(
        `This edit could not be applied: ${issue.message}. Check the layer's size, position, and image selection.`,
      );
      return false;
    }
    onChange(candidate);
    return true;
  }

  function updateScreen(changes: Partial<Screen>) {
    if (!screen) return false;
    if ((screen.canvas || changes.canvas) && changes.nodes)
      changes = { ...changes, nodes: reflowAutoLayouts(changes.nodes) };
    return changeScreens(
      project.screens.map((item) => (item.id === screen.id ? { ...item, ...changes } : item)),
    );
  }
  function updateNode(changes: Partial<WireNode>) {
    if (screen && selected)
      updateScreen({
        nodes: mapNode(screen.nodes, selected.id, (node) => ({ ...node, ...changes })),
      });
  }
  function selectScreen(id: string) {
    setSelectedIds([]);
    setScreenId(id);
    setSelectedId(undefined);
    setCommentTarget(undefined);
  }
  function addScreen(
    platform: 'desktop' | 'mobile' = project.platform === 'mobile' ? 'mobile' : 'desktop',
  ) {
    const next: Screen = {
      id: uid('screen'),
      name: `Untitled screen ${project.screens.length + 1}`,
      platform,
      state: 'default',
      description: '',
      nodes: [],
      canvas: {
        width: platform === 'mobile' ? 375 : 900,
        height: platform === 'mobile' ? 812 : 640,
      },
    };
    if (!changeScreens([...project.screens, next])) return;
    selectScreen(next.id);
    setLibrary(false);
    setPreview(false);
  }
  function duplicateScreen(state?: ScreenState) {
    if (!screen) return;
    const nextId = uid('screen');
    const suffix = ` · ${state || 'copy'}`;
    const next: Screen = {
      ...structuredClone(screen),
      id: nextId,
      name: `${screen.name.slice(0, 160 - suffix.length)}${suffix}`,
      state: state || screen.state,
      nodes: screen.nodes.map((node) => cloneWireNode(node, { from: screen.id, to: nextId })),
    };
    if (state && state !== 'default') {
      const labels = {
        loading: ['Loading your content', 'Please wait while everything comes together.'],
        empty: [
          'A little room for possibility',
          'There’s nothing here yet. Create your first item to get started.',
        ],
        error: [
          'Something didn’t go as planned',
          'We couldn’t load this content. Give it another try.',
        ],
        success: ['You’re all set', 'Your changes are saved. You’re ready for what’s next.'],
      };
      const stateCard = createNode('section');
      stateCard.name = `${state[0].toUpperCase()}${state.slice(1)} state`;
      stateCard.style = { padding: 40, align: 'center', gap: 20 };
      stateCard.children = [
        createNode('badge', state.toUpperCase()),
        createNode('heading', labels[state][0]),
        createNode('text', labels[state][1]),
      ];
      if (state !== 'loading')
        stateCard.children.push(
          createNode(
            'button',
            state === 'error'
              ? 'Try again'
              : state === 'empty'
                ? 'Create your first item'
                : 'Continue',
          ),
        );
      if (next.canvas) {
        prepareCanvasNode(stateCard, 24, 100);
        stateCard.frame!.width = Math.max(100, next.canvas.width - 48);
      }
      next.nodes = [...next.nodes.filter((node) => node.type === 'nav'), stateCard];
      if (next.canvas) next.nodes = reflowAutoLayouts(next.nodes);
    }
    if (!changeScreens([...project.screens, next])) return;
    selectScreen(next.id);
    onToast(state ? `Created an editable ${state} state` : 'Screen duplicated');
  }
  function deleteScreen() {
    if (!screen) return;
    onChange(
      reconcileReferences(
        {
          ...project,
          screens: project.screens
            .filter((item) => item.id !== screen.id)
            .map((item) => ({ ...item, nodes: clearActions(item.nodes, screen.id) })),
        },
        project,
      ),
    );
    setSelectedId(undefined);
    onToast('Screen deleted');
  }
  function insertNode(node: WireNode) {
    if (screen?.canvas) {
      prepareCanvasNode(node, 40 + selectedIds.length * 12, 40 + selectedIds.length * 12);
      if (updateScreen({ nodes: [...screen.nodes, node] })) selectCanvas([node.id]);
      return;
    }
    if (!screen) {
      onToast('Add a screen first');
      return;
    }
    const updated =
      selected && CONTAINERS.includes(selected.type)
        ? updateScreen({
            nodes: mapNode(screen.nodes, selected.id, (target) => ({
              ...target,
              children: [...target.children, node],
            })),
          })
        : updateScreen({ nodes: [...screen.nodes, node] });
    if (!updated) return;
    setSelectedId(node.id);
    setInspector('properties');
  }
  function addComponent(type: NodeType) {
    if (freeform && type === 'image') {
      setImagesOpen(true);
      return;
    }
    const node = createNode(type);
    if (type === 'card')
      node.children = [
        createNode('heading', 'A thoughtful detail'),
        createNode('text', 'Add a little context about what makes this useful.'),
      ];
    insertNode(node);
  }
  function deleteSelected() {
    if (screen?.canvas) {
      const ids = rootSelection(screen.nodes, selectedIds, { editable: true });
      if (!ids.length) return;
      const nodes = reflowAutoLayouts(
        ids.reduce((nodes, id) => removeNode(nodes, id), screen.nodes),
      );
      onChange(
        reconcileReferences(
          {
            ...project,
            screens: project.screens.map((item) =>
              item.id === screen.id ? { ...item, nodes } : item,
            ),
          },
          project,
        ),
      );
      selectCanvas([]);
      return;
    }
    if (!screen || !selected) return;
    const remaining = removeNode(screen.nodes, selected.id);
    onChange(
      reconcileReferences(
        {
          ...project,
          screens: project.screens.map((item) =>
            item.id === screen.id ? { ...item, nodes: remaining } : item,
          ),
        },
        project,
      ),
    );
    setSelectedId(undefined);
    onToast('Component deleted');
  }
  function duplicateSelected() {
    if (screen?.canvas) {
      const nodes = structuredClone(screen.nodes);
      const ids: string[] = [];
      for (const id of rootSelection(screen.nodes, selectedIds, { editable: true })) {
        const source = findNode(nodes, id),
          list = containingList(nodes, id);
        if (!source || !list) continue;
        const copy = cloneWireNode(source);
        copy.frame = { ...frameFor(copy), x: frameFor(copy).x + 24, y: frameFor(copy).y + 24 };
        list.splice(list.findIndex((node) => node.id === id) + 1, 0, copy);
        ids.push(copy.id);
      }
      if (ids.length && updateScreen({ nodes })) selectCanvas(ids);
      return;
    }
    if (!screen || !selected) return;
    const nodes = structuredClone(screen.nodes);
    const list = containingList(nodes, selected.id);
    if (!list) return;
    const copy = cloneWireNode(selected);
    list.splice(list.findIndex((node) => node.id === selected.id) + 1, 0, copy);
    if (!updateScreen({ nodes })) return;
    setSelectedId(copy.id);
  }
  function copySelected() {
    if (screen?.canvas) {
      // Flatten only selection roots to the screen, preserving their world transforms.
      const ids = rootSelection(screen.nodes, selectedIds);
      if (!ids.length) return;
      const index = sceneIndex(screen.nodes);
      const flattened = ids.some((id) => index.get(id)?.parentId)
        ? reparentNodes(screen.nodes, ids, '')
        : screen.nodes;
      if (!flattened) {
        onToast(
          'These layers are too far outside the canvas to copy at their current positions. Move them closer to the frame first.',
        );
        return;
      }
      setCanvasClipboard(
        ids.flatMap((id) => {
          const node = findNode(flattened, id);
          return node ? [structuredClone(node)] : [];
        }),
      );
      onToast('Layers copied. Paste into a freeform screen.');
      return;
    }
    if (!selected) return;
    setClipboard(structuredClone(selected));
    onToast(`Copied “${selected.name}”. Paste it into this screen or another screen.`);
  }
  function pasteComponent() {
    if (screen?.canvas && canvasClipboard.length) {
      const copies = canvasClipboard.map((node) => {
        const copy = cloneWireNode(node);
        copy.frame = { ...frameFor(copy), x: frameFor(copy).x + 24, y: frameFor(copy).y + 24 };
        return copy;
      });
      if (updateScreen({ nodes: [...screen.nodes, ...copies] }))
        selectCanvas(copies.map((node) => node.id));
      return;
    }
    if (clipboard) insertNode(cloneWireNode(clipboard));
  }
  function changeParent(nextParent: string) {
    if (!screen || !selected) return;
    const nodes = reparentNode(screen.nodes, selected.id, nextParent);
    if (nodes) updateScreen({ nodes });
  }
  function moveSelected(direction: -1 | 1) {
    if (!screen || !selected) return;
    const nodes = structuredClone(screen.nodes);
    const list = containingList(nodes, selected.id);
    if (!list) return;
    const index = list.findIndex((node) => node.id === selected.id);
    const next = index + direction;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    updateScreen({ nodes });
  }
  function dragEnd(event: DragEndEvent) {
    if (!screen || !event.over || event.active.id === event.over.id) return;
    const nodes = structuredClone(screen.nodes);
    const source = findNode(nodes, String(event.active.id));
    if (!source || findNode(source.children, String(event.over.id))) return;
    const sourceList = containingList(nodes, source.id);
    const targetList = containingList(nodes, String(event.over.id));
    if (!sourceList || !targetList) return;
    const targetIndex = targetList.findIndex((node) => node.id === event.over?.id);
    sourceList.splice(
      sourceList.findIndex((node) => node.id === source.id),
      1,
    );
    const target = findNode(nodes, String(event.over.id));
    if (target && CONTAINERS.includes(target.type) && target.children.length === 0)
      target.children.push(source);
    else targetList.splice(targetIndex, 0, source);
    updateScreen({ nodes });
  }
  function commentAt(node: WireNode | undefined, event: MouseEvent<HTMLDivElement>) {
    if (!screen) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setCommentTarget({
      kind: node ? 'node' : 'screen',
      screenId: screen.id,
      ...(node ? { nodeId: node.id } : {}),
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    });
    setSelectedComment(undefined);
    setInspector('comments');
    setCommentMode(false);
  }
  function selectComment(comment: Annotation) {
    setSelectedComment(comment);
    setSelectedId(comment.target.nodeId);
    setSelectedIds(comment.target.nodeId ? [comment.target.nodeId] : []);
    setCommentTarget(undefined);
    setInspector('comments');
  }
  function fitCanvas() {
    const width = viewport.current?.clientWidth ?? 1000;
    const fittedComments = freeform && width < 720 ? 0 : commentSpace;
    setZoom(
      Math.min(1, Math.max(freeform ? 0.05 : 0.25, (width - 96 - fittedComments) / frameWidth)),
    );
    if (freeform) setFitRequest((value) => value + 1);
  }
  function navigate(id: string) {
    if (project.screens.some((item) => item.id === id)) selectScreen(id);
    else onToast('This destination screen is no longer available.');
  }

  function selectCanvas(ids: string[]) {
    setSelectedIds(ids);
    setSelectedId(ids[0]);
    setInspector('properties');
  }
  function prepareCanvasNode(node: WireNode, x = 0, y = 0) {
    node.frame ??= defaultFrame(node.type, x, y);
    if (node.children.length) {
      node.layout ??= node.type === 'row' ? 'row' : 'column';
      node.children.forEach((child, index) => prepareCanvasNode(child, 16, 16 + index * 96));
    }
  }
  function changeCanvasNode(id: string, changes: Partial<WireNode>) {
    if (!screen) return;
    updateScreen({ nodes: mapNode(screen.nodes, id, (node) => ({ ...node, ...changes })) });
  }
  function groupCanvas() {
    if (!screen) return;
    const result = groupNodes(screen.nodes, selectedIds);
    if (!result) {
      onToast('Select at least two unlocked layers with the same parent to group.');
      return;
    }
    if (updateScreen({ nodes: result.nodes })) selectCanvas([result.groupId]);
  }
  function ungroupCanvas() {
    if (!screen) return;
    const ids = selectedIds.flatMap(
      (id) => findNode(screen.nodes, id)?.children.map((child) => child.id) ?? [],
    );
    if (updateScreen({ nodes: ungroupNodes(screen.nodes, selectedIds) })) selectCanvas(ids);
  }
  function convertToCanvas() {
    if (!screen || screen.canvas || !artboard.current) return;
    const rootRect = artboard.current.getBoundingClientRect();
    const elements = new Map(
      [...artboard.current.querySelectorAll<HTMLElement>('[data-node-id]')].map((element) => [
        element.dataset.nodeId!,
        element,
      ]),
    );
    let missing = false;
    const convert = (nodes: WireNode[], parentRect: DOMRect): WireNode[] =>
      nodes.map((node) => {
        const element = elements.get(node.id);
        const rect = element?.getBoundingClientRect();
        if (!rect || !element) {
          missing = true;
          return node;
        }
        const computed = getComputedStyle(element);
        const visual = element.querySelector<HTMLElement>(
          ':scope > h2, :scope > p, :scope > button:not(.wf-comment-pin), :scope > .wf-fake-input, :scope > .wf-badge-content',
        );
        const textStyle = visual ? getComputedStyle(visual) : computed;
        const color = (value: string): string | undefined => {
          const match = value.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[, /]+([.\d]+))?\)$/);
          if (!match || (match[4] !== undefined && Number(match[4]) === 0)) return undefined;
          return (
            '#' +
            match
              .slice(1, 4)
              .map((part) => Number(part).toString(16).padStart(2, '0'))
              .join('')
          );
        };
        const background = color(computed.backgroundColor) ?? color(textStyle.backgroundColor);
        const borderStyle = parseFloat(computed.borderWidth) > 0 ? computed : textStyle;
        const stroke =
          parseFloat(borderStyle.borderWidth) > 0 ? color(borderStyle.borderColor) : undefined;
        const weight = Number(textStyle.fontWeight) || 400;
        const fontWeight = [400, 500, 600, 700].reduce((closest, candidate) =>
          Math.abs(candidate - weight) < Math.abs(closest - weight) ? candidate : closest,
        ) as 400 | 500 | 600 | 700;
        return {
          ...node,
          style: {
            ...node.style,
            color: color(textStyle.color) ?? node.style.color,
            fontSize: Math.max(8, Math.min(96, parseFloat(textStyle.fontSize) || 14)),
            fontWeight,
            ...(background ? { background } : {}),
            ...(stroke
              ? { stroke, strokeWidth: Math.min(32, parseFloat(borderStyle.borderWidth)) }
              : {}),
            radius: Math.min(
              64,
              parseFloat(computed.borderRadius) || parseFloat(textStyle.borderRadius) || 0,
            ),
            ...(!['group', 'section', 'row', 'column', 'card'].includes(node.type)
              ? {
                  padding: Math.min(
                    100,
                    (parseFloat(computed.paddingTop) || 0) +
                      (visual ? parseFloat(textStyle.paddingTop) || 0 : 0),
                  ),
                }
              : {}),
            ...(visual && Number(textStyle.opacity) < 1
              ? { opacity: Number(textStyle.opacity) }
              : {}),
          },
          ...(['group', 'section', 'row', 'column', 'card'].includes(node.type)
            ? { layout: 'free' as const }
            : {}),
          frame: {
            x: (rect.left - parentRect.left) / zoom,
            y: (rect.top - parentRect.top) / zoom,
            width: Math.max(1, rect.width / zoom),
            height: Math.max(1, rect.height / zoom),
            rotation: 0,
          },
          children: convert(node.children, rect),
        };
      });
    const nodes = convert(screen.nodes, rootRect);
    if (missing || rootRect.height / zoom > 10000) {
      onToast(
        'This screen cannot be converted at its current size. Split it into smaller screens first.',
      );
      return;
    }
    if (
      updateScreen({
        canvas: { width: frameWidth, height: Math.max(100, Math.ceil(rootRect.height / zoom)) },
        nodes,
      })
    ) {
      selectCanvas(selectedId ? [selectedId] : []);
      setTool('select');
      onToast('Free positioning enabled. Undo returns this screen to its previous layout.');
    }
  }
  function imageNode(asset: BoardAsset) {
    const node = createNode('image', asset.title);
    node.name = asset.title.slice(0, 160) || 'Image';
    node.frame = defaultFrame('image', 40, 40);
    node.image = { assetId: asset.id, fit: 'contain' };
    return node;
  }
  async function uploadImage(file?: File) {
    if (!file || imageBusy || !screen?.canvas) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      onToast('Choose a PNG, JPEG, WebP, or GIF image.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      onToast('Images must be 10 MB or less.');
      return;
    }
    if (project.assets.length >= 100) {
      onToast('This project already has 100 images. Remove an unused image first.');
      return;
    }
    const projectId = project.id,
      destinationId = screen.id,
      epoch = editingEpoch;
    const controller = new AbortController();
    uploadController.current = controller;
    setImageBusy(true);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('kind', 'reference');
      form.set('title', file.name.replace(/\.[^.]+$/, '').slice(0, 160));
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/assets`, {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
        signal: controller.signal,
      });
      const data = (await response.json()) as { asset?: BoardAsset; error?: string };
      if (!response.ok || !data.asset)
        throw new Error(data.error || 'The image could not be uploaded.');
      if (
        !mounted.current ||
        controller.signal.aborted ||
        projectRef.current.id !== projectId ||
        epochRef.current !== epoch
      )
        return;
      const node = imageNode(data.asset);
      if (!onImageAdded?.(data.asset, projectId, destinationId, node, epoch)) {
        onToast('The screen changed during upload. Please add the image again.');
        return;
      }
      selectCanvas([node.id]);
      setImagesOpen(false);
      setTool('select');
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        onToast(error instanceof Error ? error.message : 'The image could not be uploaded.');
    } finally {
      if (mounted.current && uploadController.current === controller) setImageBusy(false);
    }
  }

  return (
    <div className={`wireframe-workspace${preview ? ' is-preview' : ''}`} onKeyDown={handleKey}>
      <div className="wf-topbar" inert={aiOpen}>
        <div className="wf-workspace-title">
          <span className="wf-eyebrow">DESIGN THE EXPERIENCE</span>
          <h1>
            Wireframes
            <span className="wf-title-dot" />
          </h1>
          <p>Give your product a little shape.</p>
        </div>
        <div className="wf-top-actions">
          <button
            className={`wf-button ${preview ? 'is-active' : ''}`}
            onClick={() => {
              setPreview(!preview);
              setCommentMode(false);
            }}
            disabled={!screen}
          >
            {preview ? <ArrowLeft size={15} /> : <Play size={15} />}
            <span>{preview ? 'Back to editor' : 'Preview flow'}</span>
          </button>
          <button
            className="wf-button wf-primary"
            onClick={() => openDesigner(project.screens.length ? 'refine' : 'generate')}
          >
            <Sparkles size={15} />
            <span>{project.screens.length ? 'Design with AI' : 'Generate from plan'}</span>
          </button>
        </div>
      </div>
      <div className="wf-editor" inert={aiOpen}>
        <aside className="wf-sidebar">
          <div className="wf-sidebar-tabs">
            <button className={!library ? 'active' : ''} onClick={() => setLibrary(false)}>
              Screens <span>{project.screens.length}</span>
            </button>
            <button className={library ? 'active' : ''} onClick={() => setLibrary(true)}>
              Components
            </button>
          </div>
          {library ? (
            <>
              <label className="wf-search">
                <Search size={14} />
                <input
                  value={librarySearch}
                  onChange={(event) => setLibrarySearch(event.target.value)}
                  placeholder="Find a component…"
                  aria-label="Find a component"
                />
              </label>
              <div className="wf-library-scroll">
                <div className="wf-section-label">THE BUILDING BLOCKS</div>
                <div className="wf-component-grid">
                  {COMPONENTS.filter((item) =>
                    `${item.name} ${item.detail}`
                      .toLowerCase()
                      .includes(librarySearch.toLowerCase()),
                  ).map((item) => (
                    <button
                      key={item.type}
                      className="wf-component-button"
                      title={item.detail}
                      onClick={() => addComponent(item.type)}
                      disabled={!screen || preview}
                    >
                      <item.icon size={22} strokeWidth={1.3} />
                      <span>{item.name}</span>
                    </button>
                  ))}
                </div>
                {!librarySearch && (
                  <>
                    <div className="wf-section-label wf-template-label">A HEAD START</div>
                    {(['hero', 'cards', 'form'] as const).map((template) => (
                      <button
                        key={template}
                        className="wf-template-button"
                        onClick={() => insertNode(templateNodes(template))}
                        disabled={!screen || preview}
                      >
                        <LayoutPanelTop size={17} />
                        <span>
                          {template === 'hero'
                            ? 'Hero section'
                            : template === 'cards'
                              ? 'Feature cards'
                              : 'Sign-up form'}
                        </span>
                        <Plus size={13} />
                      </button>
                    ))}
                  </>
                )}
              </div>
              <div className="wf-sidebar-tip">
                <MousePointer2 size={15} />
                <p>
                  {freeform
                    ? 'Add a component to the canvas. Use Parent layer to place it inside a container.'
                    : selected && CONTAINERS.includes(selected.type)
                      ? `New components go inside “${selected.name}”.`
                      : 'Click a component to add it. Select a container to add inside it.'}
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="wf-screen-list">
                <div className="wf-section-label">
                  YOUR SCREENS{' '}
                  <button
                    className="wf-icon-button"
                    onClick={() => addScreen()}
                    aria-label="Add screen"
                  >
                    <Plus size={15} />
                  </button>
                </div>
                {project.screens.map((item, index) => (
                  <button
                    key={item.id}
                    className={`wf-screen-item${screen?.id === item.id ? ' active' : ''}`}
                    onClick={() => selectScreen(item.id)}
                  >
                    <span className="wf-screen-icon">
                      {item.platform === 'mobile' ? (
                        <Smartphone size={16} />
                      ) : (
                        <Monitor size={16} />
                      )}
                    </span>
                    <span className="wf-screen-item-text">
                      <strong>{item.name}</strong>
                      <small>
                        {item.state === 'default'
                          ? `${item.platform === 'mobile' ? 'Mobile' : 'Desktop'} · ${countNodes(item.nodes)} elements`
                          : `${item.state[0].toUpperCase()}${item.state.slice(1)} state`}
                      </small>
                    </span>
                    <span className="wf-screen-number">{String(index + 1).padStart(2, '0')}</span>
                  </button>
                ))}
                <button className="wf-add-screen" onClick={() => addScreen()}>
                  <Plus size={14} /> Add a screen
                </button>
                {screen && (
                  <>
                    <div className="wf-section-label wf-layer-label">
                      LAYERS <span>{countNodes(screen.nodes)}</span>
                    </div>
                    <div className="wf-layer-list">
                      {screen.canvas ? (
                        <CanvasLayers
                          nodes={screen.nodes}
                          selectedIds={selectedIds}
                          onSelect={(ids) => {
                            selectCanvas(ids);
                            setPreview(false);
                          }}
                          onChange={changeCanvasNode}
                        />
                      ) : (
                        <LayerList
                          nodes={screen.nodes}
                          selectedId={selectedId}
                          onSelect={(id) => {
                            setSelectedId(id);
                            setInspector('properties');
                            setPreview(false);
                          }}
                        />
                      )}
                    </div>
                  </>
                )}
              </div>
              <div className="wf-sidebar-tip">
                <Sparkles size={15} />
                <p>Your plan is the starting point. Your edits make it yours.</p>
              </div>
            </>
          )}
        </aside>

        <main className="wf-canvas-area">
          <div className="wf-canvas-toolbar">
            <div className="wf-breadcrumb">
              <LayoutPanelTop size={14} />
              <span>{screen?.name || 'Your canvas'}</span>
              {screen && (
                <>
                  <ChevronRight size={12} />
                  <span className="wf-state-tag">{screen.state}</span>
                </>
              )}
            </div>
            <div className="wf-canvas-tools">
              {!preview && (
                <>
                  <button
                    className="wf-icon-button"
                    onClick={pasteComponent}
                    disabled={!(clipboard || canvasClipboard.length) || !screen}
                    title={
                      clipboard
                        ? `Paste “${clipboard.name}” (Ctrl/Cmd+V on canvas)`
                        : 'Copy a component to reuse it on any screen'
                    }
                    aria-label="Paste component"
                  >
                    <ClipboardPaste size={16} />
                  </button>
                  <button
                    className={`wf-icon-button${(freeform ? tool === 'select' : !commentMode) ? ' active' : ''}`}
                    onClick={() => {
                      setCommentMode(false);
                      setTool('select');
                    }}
                    title="Select elements"
                    aria-label="Select elements"
                  >
                    <MousePointer2 size={16} />
                  </button>
                  <button
                    className={`wf-icon-button${commentMode ? ' active' : ''}`}
                    onClick={() => {
                      setCommentMode(!commentMode);
                      setTool(commentMode ? 'select' : 'comment');
                      setInspector('comments');
                    }}
                    disabled={!screen}
                    title="Place a comment on the canvas"
                    aria-label="Place a comment"
                  >
                    <MessageCircle size={16} />
                  </button>
                  <span className="wf-tool-separator" />
                </>
              )}
              <button
                className="wf-icon-button"
                title="Fit canvas"
                aria-label="Fit canvas"
                onClick={fitCanvas}
              >
                <Maximize2 size={15} />
              </button>
            </div>
          </div>
          {!preview &&
            screen &&
            (screen.canvas ? (
              <div className="canvas-toolstrip" role="toolbar" aria-label="Canvas tools">
                {(
                  [
                    { id: 'select', label: 'Select', icon: MousePointer2 },
                    { id: 'hand', label: 'Pan', icon: Hand },
                    { id: 'rectangle', label: 'Rectangle', icon: Square },
                    { id: 'ellipse', label: 'Ellipse', icon: Circle },
                    { id: 'line', label: 'Line', icon: Minus },
                    { id: 'path', label: 'Freehand', icon: Pencil },
                    { id: 'text', label: 'Text', icon: Type },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    className={tool === item.id ? 'active' : ''}
                    aria-label={`${item.label} tool`}
                    aria-pressed={tool === item.id}
                    title={item.label}
                    onClick={() => {
                      setTool(item.id);
                      setCommentMode(false);
                    }}
                  >
                    <item.icon size={16} />
                    <span>{item.label}</span>
                  </button>
                ))}
                <button aria-label="Place image" onClick={() => setImagesOpen(true)}>
                  <ImageIcon size={16} />
                  <span>Image</span>
                </button>
                <span className="canvas-tool-label">
                  Shift-click to select multiple · Space to pan
                </span>
              </div>
            ) : (
              <div className="canvas-convert-banner">
                <span>This screen uses its original flow layout.</span>
                <button className="wf-button" onClick={convertToCanvas}>
                  Edit freely
                </button>
              </div>
            ))}
          {commentMode && (
            <div className="wf-mode-banner">
              <MessageCircle size={14} /> Click an element or a point on the screen to leave a note.
              <button
                onClick={() => {
                  setCommentMode(false);
                  setTool('select');
                }}
                aria-label="Cancel comment"
              >
                <X size={13} />
              </button>
            </div>
          )}
          {preview && (
            <div className="wf-mode-banner wf-preview-banner">
              <Play size={13} /> Click connected buttons to explore the flow.{' '}
              <span>Inputs are interactive.</span>
            </div>
          )}
          <div
            className="wf-canvas-scroll"
            ref={viewport}
            tabIndex={0}
            aria-label="Wireframe canvas"
          >
            {screen ? (
              <div
                className={`wf-canvas-stage${freeform ? ' canvas-spatial-stage' : ''}`}
                style={{
                  width: Math.max(frameWidth * zoom + (freeform ? 480 : 96) + commentSpace, 400),
                  ...(screen.canvas ? { minHeight: screen.canvas.height * zoom + 480 } : {}),
                }}
              >
                <div className="wf-frame-caption" style={{ width: frameWidth * zoom }}>
                  <span>
                    {screen.platform === 'mobile' ? (
                      <Smartphone size={12} />
                    ) : (
                      <Monitor size={12} />
                    )}
                    {screen.name}
                  </span>
                  <span>
                    {screen.canvas ? `${frameWidth} × ${screen.canvas.height}` : frameWidth} px
                  </span>
                </div>
                <div className="wf-frame-and-comments" ref={commentFrame}>
                  <div className="wf-frame-sizer" style={{ width: frameWidth * zoom }}>
                    {screen.canvas ? (
                      <FreeformCanvas
                        screen={screen}
                        design={project.design}
                        assets={project.assets}
                        selectedIds={selectedIds}
                        tool={tool}
                        zoom={zoom}
                        onSelection={selectCanvas}
                        onCommit={(nodes) => updateScreen({ nodes })}
                        onToolChange={(next) => {
                          setTool(next);
                          setCommentMode(next === 'comment');
                        }}
                        viewportRef={viewport}
                        artboardRef={artboard}
                        comments={visibleComments}
                        selectedCommentId={selectedComment?.id}
                        onCommentSelect={selectComment}
                        onComment={(target) => {
                          setCommentTarget(target);
                          setSelectedComment(undefined);
                          setInspector('comments');
                          setTool('select');
                          setCommentMode(false);
                        }}
                        preview={preview}
                        onNavigate={navigate}
                        onUnlinked={() =>
                          onToast('Connect this button to a screen in its properties.')
                        }
                        onZoomChange={setZoom}
                      />
                    ) : (
                      <div
                        ref={artboard}
                        className={`wf-artboard${screen.platform === 'mobile' ? ' wf-mobile-artboard' : ''}${commentMode ? ' is-commenting' : ''}`}
                        style={
                          {
                            width: frameWidth,
                            zoom,
                            background: project.design.surface,
                            color: project.design.text,
                            fontFamily:
                              project.design.font === 'serif' ? 'Georgia, serif' : undefined,
                            '--wf-accent': project.design.accent,
                            '--wf-zoom': zoom,
                            '--wf-radius': `${project.design.radius}px`,
                          } as CSSProperties
                        }
                        onClick={(event) =>
                          commentMode ? commentAt(undefined, event) : setSelectedId(undefined)
                        }
                      >
                        {screen.platform === 'mobile' && (
                          <div className="wf-phone-status">
                            <span>9:41</span>
                            <span className="wf-phone-island" />
                            <span>● ▰</span>
                          </div>
                        )}
                        {preview ? (
                          <WireframeRenderer
                            nodes={screen.nodes}
                            design={project.design}
                            preview
                            onNavigate={navigate}
                            onUnlinked={() =>
                              onToast(
                                'This button has no destination yet. Connect it in the editor’s Interaction settings.',
                              )
                            }
                          />
                        ) : (
                          <DndContext
                            sensors={sensors}
                            collisionDetection={canvasCollision}
                            onDragEnd={dragEnd}
                          >
                            <WireframeRenderer
                              nodes={screen.nodes}
                              design={project.design}
                              selectedId={selectedId}
                              onSelect={(node, event) => {
                                if (commentMode) commentAt(node, event);
                                else {
                                  setSelectedId(node.id);
                                  setInspector('properties');
                                }
                              }}
                              comments={visibleComments}
                              selectedCommentId={selectedComment?.id}
                              onCommentSelect={selectComment}
                              commentMode={commentMode}
                            />
                          </DndContext>
                        )}
                        {screen.nodes.length === 0 && (
                          <div className="wf-empty-artboard">
                            <LayoutPanelTop size={32} strokeWidth={1} />
                            <h3>A blank canvas. A good beginning.</h3>
                            <p>Add components from the left to give this screen a shape.</p>
                            <button
                              className="wf-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setLibrary(true);
                              }}
                            >
                              <Plus size={14} /> Browse components
                            </button>
                          </div>
                        )}
                        {!preview && (
                          <WireframeCommentPins
                            comments={visibleComments.filter(
                              (comment) => comment.target.kind === 'screen',
                            )}
                            allComments={visibleComments}
                            selectedId={selectedComment?.id}
                            onSelect={selectComment}
                          />
                        )}
                      </div>
                    )}
                  </div>
                  {!preview && visibleComments.length > 0 && (
                    <WireframeCommentMargin
                      comments={visibleComments}
                      selectedId={selectedComment?.id}
                      onSelect={selectComment}
                      onResolve={(comment) =>
                        onChange({
                          ...project,
                          comments: project.comments.map((item) =>
                            item.id === comment.id ? { ...item, status: 'resolved' } : item,
                          ),
                        })
                      }
                      frameRef={commentFrame}
                      artboardRef={artboard}
                      zoom={zoom}
                    />
                  )}
                </div>
                <div className="wf-artboard-footnote">
                  <span className="wf-footnote-dot" />
                  {preview
                    ? 'An interactive draft of your product'
                    : 'A living draft. Every detail is editable.'}
                </div>
              </div>
            ) : (
              <div className="wf-empty-workspace">
                <div className="wf-empty-illustration">
                  <div />
                  <div />
                  <LayoutPanelTop size={40} strokeWidth={1} />
                </div>
                <span className="wf-eyebrow">FROM WORDS TO WIREFRAMES</span>
                <h2>Your idea, taking shape.</h2>
                <p>
                  Let AI turn your product plan into an editable first draft, or start with a screen
                  of your own.
                </p>
                <button className="wf-button wf-primary" onClick={() => openDesigner('generate')}>
                  <Sparkles size={15} /> Generate from your plan
                </button>
                <button className="wf-text-button" onClick={() => addScreen()}>
                  Start with a blank screen <ArrowRight size={13} />
                </button>
              </div>
            )}
          </div>
          <div className="wf-canvas-bottom">
            <span>
              <span className="wf-status-dot" />
              {preview ? 'Prototype preview' : freeform ? 'Freeform canvas' : 'Layout canvas'}
            </span>
            <div className="wf-zoom-controls">
              <button
                aria-label="Zoom out"
                onClick={() =>
                  setZoom((value) =>
                    Math.max(freeform ? 0.05 : 0.25, Math.round((value - 0.1) * 100) / 100),
                  )
                }
              >
                <Minus size={14} />
              </button>
              <button className="wf-zoom-value" onClick={fitCanvas} title="Fit to viewport">
                {Math.round(zoom * 100)}%<ChevronDown size={10} />
              </button>
              <button
                aria-label="Zoom in"
                onClick={() =>
                  setZoom((value) =>
                    Math.min(freeform ? 4 : 1.5, Math.round((value + 0.1) * 100) / 100),
                  )
                }
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        </main>

        {!preview && (
          <aside className="wf-inspector">
            <div className="wf-inspector-tabs">
              <button
                className={inspector === 'properties' ? 'active' : ''}
                onClick={() => setInspector('properties')}
              >
                Properties
              </button>
              <button
                className={inspector === 'comments' ? 'active' : ''}
                onClick={() => setInspector('comments')}
              >
                Comments{openCommentCount > 0 && <span>{openCommentCount}</span>}
              </button>
            </div>
            {inspector === 'comments' ? (
              <AnnotationPanel
                project={project}
                onChange={onChange}
                target={commentTarget}
                onClose={() => {
                  setCommentTarget(undefined);
                  setInspector('properties');
                }}
                onToast={onToast}
                filter={screen ? { screenId: screen.id } : undefined}
                selectedId={selectedComment?.id}
              />
            ) : screen?.canvas ? (
              <CanvasInspector
                screen={screen}
                screens={project.screens}
                design={project.design}
                assets={project.assets.filter((asset) => !!asset.imageUrl)}
                selectedIds={selectedIds}
                onScreen={updateScreen}
                onNode={changeCanvasNode}
                onFrame={(id, changes) =>
                  updateScreen({ nodes: resizeNode(screen.nodes, id, changes) })
                }
                onArrange={(action) =>
                  updateScreen({ nodes: reorderNodes(screen.nodes, selectedIds, action) })
                }
                onAlign={(alignment) =>
                  updateScreen({ nodes: alignNodes(screen.nodes, selectedIds, alignment) })
                }
                onDistribute={(axis) =>
                  updateScreen({ nodes: distributeNodes(screen.nodes, selectedIds, axis) })
                }
                onGroup={groupCanvas}
                onUngroup={ungroupCanvas}
                onReparent={(parent) => {
                  const nodes = reparentNodes(screen.nodes, selectedIds, parent);
                  if (nodes) updateScreen({ nodes });
                }}
                onReflow={() =>
                  selected && updateScreen({ nodes: reflowContainer(screen.nodes, selected.id) })
                }
                onDuplicate={duplicateSelected}
                onDelete={deleteSelected}
                onDuplicateScreen={duplicateScreen}
                onDeleteScreen={deleteScreen}
              />
            ) : (
              <div className="wf-properties-scroll">
                {selected && screen ? (
                  <>
                    <div className="wf-property-heading">
                      <span className="wf-object-icon">
                        <LayoutGrid size={17} />
                      </span>
                      <div>
                        <strong>{selected.name}</strong>
                        <small>{selected.type} component</small>
                      </div>
                      <button
                        className="wf-icon-button"
                        onClick={() => setSelectedId(undefined)}
                        aria-label="Deselect component"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <PropertyField label="Layer name">
                      <input
                        value={selected.name}
                        maxLength={160}
                        onChange={(event) => updateNode({ name: event.target.value })}
                      />
                    </PropertyField>
                    {!CONTAINERS.includes(selected.type) && selected.type !== 'divider' && (
                      <PropertyField label="Content">
                        <textarea
                          rows={selected.type === 'text' ? 4 : 3}
                          value={selected.text}
                          maxLength={4000}
                          onChange={(event) => updateNode({ text: event.target.value })}
                        />
                      </PropertyField>
                    )}
                    <div className="wf-property-section">
                      <h3>Layout & appearance</h3>
                      {CONTAINERS.includes(selected.type) && (
                        <PropertyField label="Container layout">
                          <select
                            value={selected.type}
                            onChange={(event) =>
                              updateNode({ type: event.target.value as NodeType })
                            }
                          >
                            <option value="section">Section</option>
                            <option value="row">Row · side by side</option>
                            <option value="column">Column · stacked</option>
                            <option value="card">Card</option>
                          </select>
                        </PropertyField>
                      )}
                      <div className="wf-field-pair">
                        <PropertyField label="Padding">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            placeholder="Auto"
                            value={selected.style.padding ?? ''}
                            onChange={(event) =>
                              updateNode({
                                style: {
                                  ...selected.style,
                                  padding: numericValue(event.target.value, 100),
                                },
                              })
                            }
                          />
                        </PropertyField>
                        <PropertyField label="Gap">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            placeholder="Auto"
                            value={selected.style.gap ?? ''}
                            onChange={(event) =>
                              updateNode({
                                style: {
                                  ...selected.style,
                                  gap: numericValue(event.target.value, 100),
                                },
                              })
                            }
                          />
                        </PropertyField>
                      </div>
                      <div className="wf-field-pair">
                        <PropertyField label="Text size">
                          <input
                            type="number"
                            min="8"
                            max="96"
                            placeholder="Auto"
                            value={selected.style.fontSize ?? ''}
                            onChange={(event) =>
                              updateNode({
                                style: {
                                  ...selected.style,
                                  fontSize: numericValue(event.target.value, 96, 8),
                                },
                              })
                            }
                          />
                        </PropertyField>
                        <PropertyField label="Radius">
                          <input
                            type="number"
                            min="0"
                            max="64"
                            placeholder="Auto"
                            value={selected.style.radius ?? ''}
                            onChange={(event) =>
                              updateNode({
                                style: {
                                  ...selected.style,
                                  radius: numericValue(event.target.value, 64),
                                },
                              })
                            }
                          />
                        </PropertyField>
                      </div>
                      <PropertyField label="Alignment">
                        <select
                          value={selected.style.align || 'start'}
                          onChange={(event) =>
                            updateNode({
                              style: {
                                ...selected.style,
                                align: event.target.value as 'start' | 'center' | 'end',
                              },
                            })
                          }
                        >
                          <option value="start">Left</option>
                          <option value="center">Center</option>
                          <option value="end">Right</option>
                        </select>
                      </PropertyField>
                      <div className="wf-field-pair">
                        <PropertyField label="Text color">
                          <div className="wf-color-field">
                            <input
                              type="color"
                              value={validColor(selected.style.color, project.design.text)}
                              onChange={(event) =>
                                updateNode({
                                  style: { ...selected.style, color: event.target.value },
                                })
                              }
                            />
                            <span>{selected.style.color || 'Inherit'}</span>
                          </div>
                        </PropertyField>
                        <PropertyField label="Background">
                          <div className="wf-color-field">
                            <input
                              type="color"
                              value={validColor(selected.style.background, project.design.surface)}
                              onChange={(event) =>
                                updateNode({
                                  style: { ...selected.style, background: event.target.value },
                                })
                              }
                            />
                            <span>{selected.style.background || 'Inherit'}</span>
                          </div>
                        </PropertyField>
                      </div>
                      <button className="wf-text-button" onClick={() => updateNode({ style: {} })}>
                        Reset appearance
                      </button>
                    </div>
                    {selected.type === 'button' && (
                      <div className="wf-property-section">
                        <h3>
                          Interaction <span>ON CLICK</span>
                        </h3>
                        <PropertyField label="Navigate to">
                          <select
                            value={selected.action?.screenId || ''}
                            onChange={(event) =>
                              updateNode({
                                action: event.target.value
                                  ? { screenId: event.target.value }
                                  : undefined,
                              })
                            }
                          >
                            <option value="">No destination</option>
                            {project.screens.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name} · {item.state}
                              </option>
                            ))}
                          </select>
                        </PropertyField>
                        <p className="wf-field-help">
                          Connect a screen to make this button work in Preview.
                        </p>
                      </div>
                    )}
                    {CONTAINERS.includes(selected.type) && (
                      <button className="wf-button wf-full" onClick={() => setLibrary(true)}>
                        <Plus size={14} /> Add inside {selected.type}
                      </button>
                    )}
                    <div className="wf-property-section">
                      <h3>Arrange</h3>
                      <PropertyField label="Inside container">
                        <select
                          value={parentId}
                          onChange={(event) => changeParent(event.target.value)}
                        >
                          <option value="">Screen root</option>
                          <ContainerOptions nodes={screen.nodes} exclude={selected.id} />
                        </select>
                      </PropertyField>
                      <p className="wf-field-help">
                        Move this component with its contents and notes.
                      </p>
                      {parentId && (
                        <button
                          className="wf-text-button"
                          onClick={() => setSelectedId(parentId)}
                          aria-label="Select parent container"
                        >
                          <ArrowUp size={13} /> Select parent
                        </button>
                      )}
                      <div className="wf-arrange-buttons">
                        <button
                          title="Move up"
                          disabled={
                            containingList(screen.nodes, selected.id)?.[0]?.id === selected.id
                          }
                          onClick={() => moveSelected(-1)}
                        >
                          <ArrowUp size={15} /> Up
                        </button>
                        <button
                          title="Move down"
                          disabled={
                            containingList(screen.nodes, selected.id)?.at(-1)?.id === selected.id
                          }
                          onClick={() => moveSelected(1)}
                        >
                          <ArrowDown size={15} /> Down
                        </button>
                      </div>
                      <div className="wf-arrange-buttons">
                        <button
                          onClick={duplicateSelected}
                          title="Duplicate (Ctrl/Cmd+D on canvas)"
                        >
                          <Copy size={14} /> Duplicate
                        </button>
                        <button
                          className="wf-danger-text"
                          onClick={deleteSelected}
                          title="Delete (Delete or Backspace on canvas)"
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                      <button
                        className="wf-button wf-full wf-copy-component"
                        onClick={copySelected}
                        title="Copy (Ctrl/Cmd+C on canvas)"
                      >
                        <Copy size={14} /> Copy to another screen
                      </button>
                      <p className="wf-field-help">
                        On the canvas: Ctrl/Cmd+C, V, D to copy, paste, duplicate. Delete removes
                        the selection.
                      </p>
                    </div>
                    <button
                      className="wf-comment-element"
                      onClick={() => {
                        setCommentTarget({
                          kind: 'node',
                          screenId: screen?.id,
                          nodeId: selected.id,
                          x: 0.8,
                          y: 0.5,
                        });
                        setInspector('comments');
                      }}
                    >
                      <MessageCircle size={15} />
                      <span>Leave a note on this element</span>
                      <ArrowRight size={13} />
                    </button>
                  </>
                ) : screen ? (
                  <>
                    <div className="wf-property-heading">
                      <span className="wf-object-icon">
                        {screen.platform === 'mobile' ? (
                          <Smartphone size={17} />
                        ) : (
                          <Monitor size={17} />
                        )}
                      </span>
                      <div>
                        <strong>Screen settings</strong>
                        <small>{countNodes(screen.nodes)} editable elements</small>
                      </div>
                    </div>
                    <PropertyField label="Screen name">
                      <input
                        value={screenName}
                        maxLength={160}
                        onChange={(event) => setScreenName(event.target.value)}
                        onBlur={() => {
                          const name = screenName.trim();
                          if (name && name !== screen.name) updateScreen({ name });
                          else setScreenName(screen.name);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur();
                        }}
                      />
                    </PropertyField>
                    <PropertyField label="Purpose">
                      <textarea
                        rows={3}
                        placeholder="What should someone do on this screen?"
                        value={screen.description}
                        maxLength={4000}
                        onChange={(event) => updateScreen({ description: event.target.value })}
                      />
                    </PropertyField>
                    <div className="wf-property-section">
                      <h3>Frame</h3>
                      <div className="wf-device-options">
                        <button
                          className={screen.platform === 'desktop' ? 'active' : ''}
                          onClick={() => updateScreen({ platform: 'desktop' })}
                        >
                          <Monitor size={17} />
                          Desktop<span>900 px</span>
                        </button>
                        <button
                          className={screen.platform === 'mobile' ? 'active' : ''}
                          onClick={() => updateScreen({ platform: 'mobile' })}
                        >
                          <Smartphone size={17} />
                          Mobile<span>375 px</span>
                        </button>
                      </div>
                      <PropertyField label="Screen state">
                        <select
                          value={screen.state}
                          onChange={(event) =>
                            updateScreen({ state: event.target.value as ScreenState })
                          }
                        >
                          {STATES.map((state) => (
                            <option key={state} value={state}>
                              {state[0].toUpperCase() + state.slice(1)}
                            </option>
                          ))}
                        </select>
                      </PropertyField>
                    </div>
                    <div className="wf-property-section">
                      <h3>Design the in-between</h3>
                      <p className="wf-field-help">
                        Loading, empty, and error states deserve a little care too.
                      </p>
                      <div className="wf-variant-create">
                        <select
                          value={newState}
                          onChange={(event) => setNewState(event.target.value as ScreenState)}
                          aria-label="New state variant"
                        >
                          {STATES.filter((state) => state !== 'default').map((state) => (
                            <option key={state} value={state}>
                              {state[0].toUpperCase() + state.slice(1)} state
                            </option>
                          ))}
                        </select>
                        <button
                          className="wf-icon-button"
                          onClick={() => duplicateScreen(newState)}
                          aria-label="Create state variant"
                          title="Create state variant"
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                    </div>
                    <div className="wf-property-section">
                      <div className="wf-arrange-buttons">
                        <button onClick={() => duplicateScreen()}>
                          <Copy size={14} /> Duplicate
                        </button>
                        <button className="wf-danger-text" onClick={deleteScreen}>
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    </div>
                    <div className="wf-inspector-hint">
                      <MousePointer2 size={20} strokeWidth={1.4} />
                      <p>
                        Select an element on the canvas to edit its content, style, and behavior.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="wf-inspector-hint">
                    <LayoutPanelTop size={24} />
                    <p>Add your first screen to start shaping the experience.</p>
                  </div>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
      <dialog
        ref={imageDialog}
        className="canvas-image-dialog"
        aria-label="Place an image"
        onCancel={() => setImagesOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setImagesOpen(false);
        }}
      >
        <header>
          <h2>Place an image</h2>
          <button
            className="wf-icon-button"
            aria-label="Close image chooser"
            onClick={() => setImagesOpen(false)}
          >
            <X size={18} />
          </button>
        </header>
        <input
          ref={imageInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(event) => {
            void uploadImage(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <button
          className="wf-button"
          disabled={imageBusy || !onImageAdded}
          onClick={() => imageInput.current?.click()}
        >
          <Upload size={16} />
          {imageBusy ? 'Uploading…' : 'Upload an image'}
        </button>
        <p className="wf-field-help">
          PNG, JPEG, WebP, or GIF, up to 10 MB. Or choose an image already in this project.
        </p>
        <div className="canvas-asset-grid">
          {project.assets
            .filter((asset) => !!asset.imageUrl)
            .map((asset) => (
              <button
                key={asset.id}
                disabled={imageBusy}
                onClick={() => {
                  insertNode(imageNode(asset));
                  setImagesOpen(false);
                  setTool('select');
                }}
              >
                <img src={asset.imageUrl} alt="" />
                <span>{asset.title}</span>
              </button>
            ))}
        </div>
      </dialog>
      {aiOpen && (
        <div
          className="wf-modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setAiOpen(false);
          }}
        >
          <section
            ref={aiDialog}
            className="wf-ai-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wf-ai-title"
          >
            <button
              className="wf-dialog-close wf-icon-button"
              aria-label="Close AI designer"
              onClick={() => setAiOpen(false)}
            >
              <X size={18} />
            </button>
            <div className="wf-ai-symbol">
              <Sparkles size={24} />
            </div>
            <span className="wf-eyebrow">A LITTLE CREATIVE COLLABORATION</span>
            <h2 id="wf-ai-title">Let’s give your idea a shape.</h2>
            <p>
              Your product plan, visual direction, and accepted notes give the AI its context.
              You’ll review the proposal before applying it.
            </p>
            <div className="wf-ai-mode">
              <button
                className={aiMode === 'generate' ? 'active' : ''}
                onClick={() => setAiMode('generate')}
              >
                Generate screens
              </button>
              <button
                disabled={!screen}
                className={aiMode === 'refine' ? 'active' : ''}
                onClick={() => setAiMode('refine')}
              >
                Refine this screen
              </button>
            </div>
            <label className="wf-property-field">
              <span>
                {aiMode === 'refine'
                  ? `What should change on “${screen?.name}”?`
                  : 'Anything you’d like the first draft to focus on?'}
              </span>
              <textarea
                rows={4}
                value={aiInstruction}
                onChange={(event) => setAiInstruction(event.target.value)}
                placeholder={
                  aiMode === 'refine'
                    ? 'Make the primary action clearer, simplify the layout…'
                    : 'Focus on the core user journey. Keep it thoughtful and simple…'
                }
              />
            </label>
            {!helperOnline && (
              <div className="wf-helper-note">
                <span className="wf-offline-dot" />
                Your Codex Helper needs to be connected in Settings before you can generate a draft.
              </div>
            )}
            <div className="wf-dialog-actions">
              <button className="wf-button" onClick={() => setAiOpen(false)}>
                Keep editing
              </button>
              <button
                className="wf-button wf-primary"
                disabled={!helperOnline}
                onClick={() => {
                  onGenerate(
                    aiMode === 'refine' ? 'wireframe.refine' : 'wireframe.generate',
                    aiInstruction.trim() ||
                      (aiMode === 'refine'
                        ? 'Refine this screen using the product plan, visual direction, and accepted requirements. Preserve its purpose and improve the layout and clarity.'
                        : 'Create editable wireframes for the main product journey from the plan, with connected interactions and useful screen states. Follow the visual direction and accepted requirements.'),
                    aiMode === 'refine' ? screen?.id : undefined,
                  );
                  setAiOpen(false);
                  setAiInstruction('');
                }}
              >
                <Sparkles size={15} />
                {aiMode === 'refine' ? 'Propose refinements' : 'Create a first draft'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function clearActions(nodes: WireNode[], screenId: string): WireNode[] {
  return nodes.map((node) => ({
    ...node,
    action: node.action?.screenId === screenId ? undefined : node.action,
    children: clearActions(node.children, screenId),
  }));
}
function validColor(color: string | undefined, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color ?? '')
    ? color!
    : /^#[0-9a-fA-F]{6}$/.test(fallback)
      ? fallback
      : '#ffffff';
}
function numericValue(raw: string, max: number, min = 0): number | undefined {
  return raw === '' ? undefined : Math.max(min, Math.min(max, Number(raw) || 0));
}
function PropertyField({ label, children }: { label: string; children: React.ReactNode }) {
  const control =
    isValidElement(children) && ['input', 'textarea', 'select'].includes(String(children.type))
      ? cloneElement(children as ReactElement<{ 'aria-label'?: string }>, { 'aria-label': label })
      : children;
  return (
    <label className="wf-property-field">
      <span>{label}</span>
      {control}
    </label>
  );
}
function ContainerOptions({
  nodes,
  exclude,
  path = '',
}: {
  nodes: WireNode[];
  exclude: string;
  path?: string;
}) {
  return nodes
    .filter((node) => node.id !== exclude)
    .map((node) => {
      const label = path ? `${path} / ${node.name}` : node.name;
      return (
        <Fragment key={node.id}>
          {CONTAINERS.includes(node.type) && <option value={node.id}>{label}</option>}
          <ContainerOptions nodes={node.children} exclude={exclude} path={label} />
        </Fragment>
      );
    });
}
function LayerList({
  nodes,
  selectedId,
  onSelect,
  level = 0,
}: {
  nodes: WireNode[];
  selectedId?: string;
  onSelect: (id: string) => void;
  level?: number;
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.id}>
          <button
            className={`wf-layer-item${selectedId === node.id ? ' active' : ''}`}
            aria-pressed={selectedId === node.id}
            style={{ paddingLeft: 12 + level * 13 }}
            onClick={() => onSelect(node.id)}
          >
            {CONTAINERS.includes(node.type) ? (
              <LayoutPanelTop size={12} />
            ) : node.type === 'heading' || node.type === 'text' ? (
              <Type size={12} />
            ) : (
              <Square size={11} />
            )}
            <span>{node.name}</span>
          </button>
          {node.children.length > 0 && (
            <LayerList
              nodes={node.children}
              selectedId={selectedId}
              onSelect={onSelect}
              level={level + 1}
            />
          )}
        </div>
      ))}
    </>
  );
}
