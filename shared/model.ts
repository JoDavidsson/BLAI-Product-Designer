export const PLAN_FIELDS = [
  ['problem', 'Problem & opportunity', 'What problem are we solving, and why does it matter?'],
  ['audience', 'Who it is for', 'Describe the people, their context, and their needs.'],
  ['value', 'Product promise', 'What will the product help people achieve?'],
  ['goals', 'Goals & success', 'Define the outcomes and how to measure them.'],
  ['scope', 'First-version scope', 'List the essential features and priorities.'],
  ['outOfScope', 'Out of scope', 'Make the boundaries explicit.'],
  ['journeys', 'User journeys', 'Describe the steps users take to reach their goals.'],
  [
    'dataRules',
    'Data & behavior',
    'Describe stored information, permissions, validation, and business rules.',
  ],
  ['integrations', 'Integrations', 'Name external services, dependencies, and constraints.'],
  [
    'acceptance',
    'Acceptance criteria',
    'Describe observable behavior that proves the product works.',
  ],
  ['questions', 'Open questions', 'Capture decisions that still need an answer.'],
] as const;

export type PlanKey = (typeof PLAN_FIELDS)[number][0];
export type ProductPlan = Record<PlanKey, string>;
export type Platform = 'web' | 'mobile' | 'both';
export type ScreenState = 'default' | 'loading' | 'empty' | 'error' | 'success';
export const NODE_TYPES = [
  'section',
  'row',
  'column',
  'heading',
  'text',
  'button',
  'input',
  'image',
  'card',
  'nav',
  'divider',
  'badge',
  'group',
  'rectangle',
  'ellipse',
  'line',
  'path',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export interface NodeFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees about the layer's centre, in its parent's coordinate system. */
  rotation: number;
}
export interface NodePoint {
  x: number;
  y: number;
}
export interface ScreenCanvas {
  width: number;
  height: number;
}
export interface NodeStyle {
  background?: string;
  color?: string;
  fontSize?: number;
  padding?: number;
  gap?: number;
  radius?: number;
  align?: 'start' | 'center' | 'end';
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  fontWeight?: 400 | 500 | 600 | 700;
}
export interface WireNode {
  id: string;
  type: NodeType;
  name: string;
  text: string;
  children: WireNode[];
  style: NodeStyle;
  action?: { screenId: string };
  /** Optional additive scene data; absent fields retain legacy flow rendering. */
  frame?: NodeFrame;
  layout?: 'free' | 'row' | 'column';
  image?: { assetId: string; fit: 'cover' | 'contain' };
  points?: NodePoint[];
  locked?: boolean;
  hidden?: boolean;
}
export interface Screen {
  id: string;
  name: string;
  platform: 'desktop' | 'mobile';
  description: string;
  state: ScreenState;
  nodes: WireNode[];
  canvas?: ScreenCanvas;
}
export interface DesignTokens {
  accent: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  radius: number;
  font: 'sans' | 'serif';
}
export interface BoardAsset {
  id: string;
  title: string;
  kind: 'reference' | 'screenshot';
  imageUrl: string;
  sourceUrl: string;
  note: string;
  createdAt: string;
}
export interface AnnotationTarget {
  kind: 'screen' | 'node' | 'asset' | 'project';
  screenId?: string;
  nodeId?: string;
  assetId?: string;
  /** Normalized [0,1] coordinates within the target. */
  x: number;
  y: number;
}
export interface CommentReply {
  id: string;
  body: string;
  createdAt: string;
}
export interface Annotation {
  id: string;
  target: AnnotationTarget;
  body: string;
  status: 'open' | 'resolved' | 'accepted';
  replies: CommentReply[];
  createdAt: string;
  requirementId?: string;
  /** Original location retained when its screen, component, or image is removed. */
  previousLocation?: string;
}
export interface Requirement {
  id: string;
  text: string;
  sourceCommentId?: string;
  screenId?: string;
  status: 'proposed' | 'accepted';
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}
export const MAX_DIAGRAMS = 12;
export const MAX_DIAGRAM_SOURCE_LENGTH = 12000;
export interface ProductDiagram {
  id: string;
  title: string;
  kind: 'flowchart' | 'state';
  /** Portable Mermaid source; incomplete drafts are preserved for editing. */
  source: string;
}
export interface Project {
  id: string;
  title: string;
  summary: string;
  platform: Platform;
  createdAt: string;
  updatedAt: string;
  revision: number;
  plan: ProductPlan;
  design: DesignTokens;
  screens: Screen[];
  /** Optional so projects created before the diagram experiment remain readable. */
  diagrams?: ProductDiagram[];
  assets: BoardAsset[];
  comments: Annotation[];
  requirements: Requirement[];
  chat: ChatMessage[];
}
export interface ProjectSummary {
  id: string;
  title: string;
  summary: string;
  platform: Platform;
  updatedAt: string;
  revision: number;
  screenCount: number;
}
export const JOB_KINDS = [
  'plan.assist',
  'plan.review',
  'wireframe.generate',
  'wireframe.refine',
  'moodboard.direction',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export interface AIResult {
  title: string;
  summary: string;
  reply: string;
  plan: Partial<ProductPlan> | null;
  screens: Screen[] | null;
  design: DesignTokens | null;
  requirements: { text: string; screenId?: string }[];
}
export interface AIProposal {
  id: string;
  jobId: string;
  projectId: string;
  kind: JobKind;
  baseRevision: number;
  createdAt: string;
  status: 'pending' | 'applied' | 'dismissed';
  result: AIResult;
}
export const JOB_PROGRESS_STAGES = [
  'launching',
  'model-started',
  'response-received',
  'validating',
] as const;
export type JobProgressStage = (typeof JOB_PROGRESS_STAGES)[number];
/** Omitted counts are unknown; reported zeroes are meaningful. */
export interface AIUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}
export interface JobTelemetry {
  stage?: JobProgressStage;
  usage?: AIUsage;
}
export interface AIJob {
  id: string;
  projectId: string;
  kind: JobKind;
  baseRevision: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  instruction: string;
  screenId?: string;
  createdAt: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
  completedAt?: string;
  progressStage?: JobProgressStage;
  progressUpdatedAt?: string;
  usage?: AIUsage;
  helperVersion?: string;
  error?: string;
  proposalId?: string;
}
export interface HelperStatus {
  online: boolean;
  lastSeen: string | null;
  workerId: string | null;
  helperVersion?: string | null;
  protocolVersion: number;
  capabilities: string[];
  imageGeneration: false;
}
export interface ProjectVersion {
  id: string;
  revision: number;
  createdAt: string;
  label: string;
}
export const PROTOCOL_VERSION = 1;
export const DEFAULT_DESIGN: DesignTokens = {
  accent: '#7360df',
  background: '#f7f6f2',
  surface: '#ffffff',
  text: '#232833',
  muted: '#7b8190',
  radius: 16,
  font: 'sans',
};
export function uid(prefix = 'id'): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}
export function emptyPlan(): ProductPlan {
  return Object.fromEntries(PLAN_FIELDS.map(([key]) => [key, ''])) as ProductPlan;
}
export function createNode(type: NodeType, text?: string): WireNode {
  const labels: Record<NodeType, string> = {
    section: 'Section',
    row: 'Row',
    column: 'Column',
    heading: 'A clear heading',
    text: 'Add a short description that helps people take the next step.',
    button: 'Continue',
    input: 'Your email address',
    image: 'Image placeholder',
    card: 'Card',
    nav: 'Overview · Projects · Settings',
    divider: '',
    badge: 'New',
    group: '',
    rectangle: '',
    ellipse: '',
    line: '',
    path: '',
  };
  return {
    id: uid('node'),
    type,
    name: type[0].toUpperCase() + type.slice(1),
    text: text ?? labels[type],
    children: [],
    style: {},
  };
}
export function createProject(title = 'Untitled product'): Project {
  const now = new Date().toISOString();
  return {
    id: uid('project'),
    title,
    summary: '',
    platform: 'both',
    createdAt: now,
    updatedAt: now,
    revision: 1,
    plan: emptyPlan(),
    design: { ...DEFAULT_DESIGN },
    screens: [],
    diagrams: [],
    assets: [],
    comments: [],
    requirements: [],
    chat: [],
  };
}
export function walkNodes(nodes: WireNode[], visit: (node: WireNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walkNodes(node.children, visit);
  }
}
export function findNode(nodes: WireNode[], id: string): WireNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children, id);
    if (child) return child;
  }
}

/** Keep notes and approved behavior when their visual targets are replaced or removed. */
export function reconcileReferences(project: Project, previous?: Project): Project {
  const next = structuredClone(project);
  const prior = previous?.id === project.id ? previous : undefined;
  const screens = new Map(next.screens.map((screen) => [screen.id, screen]));
  const assets = new Map(next.assets.map((asset) => [asset.id, asset]));
  const nodes = new Map<string, { node: WireNode; screen: Screen }>();
  for (const screen of next.screens)
    walkNodes(screen.nodes, (node) => {
      nodes.set(node.id, { node, screen });
      if (node.action && !screens.has(node.action.screenId)) delete node.action;
    });
  function exists(target: AnnotationTarget): boolean {
    if (target.kind === 'project') return true;
    if (target.kind === 'screen') return !!target.screenId && screens.has(target.screenId);
    if (target.kind === 'node') return !!target.nodeId && nodes.has(target.nodeId);
    return !!target.assetId && assets.has(target.assetId);
  }
  function location(target: AnnotationTarget): string {
    const source = prior ?? project;
    const screen =
      source.screens.find((item) => item.id === target.screenId) ??
      source.screens.find((item) => target.nodeId && findNode(item.nodes, target.nodeId));
    const node = target.nodeId && screen ? findNode(screen.nodes, target.nodeId) : undefined;
    if (target.kind === 'asset') {
      const asset = source.assets.find((item) => item.id === target.assetId);
      return asset
        ? `${asset.kind === 'screenshot' ? 'Screenshot' : 'Reference'} “${asset.title}” (${asset.id})`
        : `Image ${target.assetId ?? 'unknown'}`;
    }
    const screenLabel = screen
      ? `Screen “${screen.name}” (${screen.id})`
      : `Screen ${target.screenId ?? 'unknown'}`;
    return target.kind === 'node'
      ? `${screenLabel} → ${node ? `Component “${node.name}” (${node.id})` : `Component ${target.nodeId ?? 'unknown'}`}`
      : screenLabel;
  }
  // Some editor operations also remove comments on deleted targets. Retain those
  // notes while still allowing an explicit comment deletion on an existing target.
  const commentIds = new Set(next.comments.map((comment) => comment.id));
  for (const comment of prior?.comments ?? []) {
    if (!commentIds.has(comment.id) && !exists(comment.target)) {
      next.comments.push(structuredClone(comment));
      commentIds.add(comment.id);
    }
  }
  const requirementIds = new Set(next.requirements.map((requirement) => requirement.id));
  const coordinate = (value: number) =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
  for (const comment of next.comments) {
    const target = comment.target;
    const x = coordinate(target.x),
      y = coordinate(target.y);
    if (!exists(target)) {
      comment.previousLocation ??= location(target);
      comment.target = { kind: 'project', x, y };
    } else if (target.kind === 'node') {
      comment.target = {
        kind: 'node',
        nodeId: target.nodeId,
        screenId: nodes.get(target.nodeId!)!.screen.id,
        x,
        y,
      };
    } else if (target.kind === 'screen')
      comment.target = { kind: 'screen', screenId: target.screenId, x, y };
    else if (target.kind === 'asset')
      comment.target = { kind: 'asset', assetId: target.assetId, x, y };
    else comment.target = { kind: 'project', x, y };
    if (comment.requirementId && !requirementIds.has(comment.requirementId))
      delete comment.requirementId;
  }
  for (const requirement of next.requirements) {
    if (requirement.screenId && !screens.has(requirement.screenId)) delete requirement.screenId;
    if (requirement.sourceCommentId && !commentIds.has(requirement.sourceCommentId))
      delete requirement.sourceCommentId;
  }
  return next;
}
export function planCompletion(plan: ProductPlan): number {
  const required = PLAN_FIELDS.filter(([key]) => key !== 'questions');
  return Math.round(
    (required.filter(([key]) => plan[key].trim().length > 15).length / required.length) * 100,
  );
}
