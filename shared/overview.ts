import { PLAN_FIELDS, type PlanKey, type Project, type Screen, walkNodes } from './model';

export type OverviewSource =
  | { kind: 'project' }
  | { kind: 'plan'; key: PlanKey }
  | { kind: 'screen'; screenId: string; nodeId?: string }
  | { kind: 'requirement'; requirementId: string }
  | { kind: 'comment'; commentId: string }
  | { kind: 'asset'; assetId: string }
  | { kind: 'chat'; messageId: string }
  | { kind: 'design' };

export interface OverviewEntry {
  id: string;
  title: string;
  body: string;
  status?: string;
  source: OverviewSource;
}
export interface OverviewNode {
  id: string;
  title: string;
  label: string;
  kind:
    | 'project'
    | 'plan'
    | 'screens'
    | 'decisions'
    | 'references'
    | 'discussion'
    | 'design'
    | 'screen'
    | 'journey'
    | 'gap';
  entries: OverviewEntry[];
}
export interface OverviewEdge {
  from: string;
  to: string;
  label?: string;
  kind: 'contains' | 'sequence' | 'navigation';
}
export interface OverviewGraph {
  id: 'product' | 'journey' | 'screens';
  title: string;
  description: string;
  nodes: OverviewNode[];
  edges: OverviewEdge[];
  notes: string[];
}
export interface ProductOverview {
  projectId: string;
  graphs: OverviewGraph[];
  stats: {
    planSections: number;
    screens: number;
    requirements: number;
    comments: number;
    assets: number;
    messages: number;
  };
  gaps: Array<{ id: string; title: string; detail: string; source?: OverviewSource }>;
}

export const MAX_OVERVIEW_SOURCE_LENGTH = 65_536;
export const MAX_OVERVIEW_EDGES = 150;
const MAX_JOURNEY_ITEMS = 22;

function excerpt(value: string, limit = 105): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function node(
  id: string,
  title: string,
  kind: OverviewNode['kind'],
  entries: OverviewEntry[],
  preview = entries[0]?.body ?? '',
): OverviewNode {
  return {
    id,
    title,
    kind,
    entries,
    label: excerpt(`${title}${preview ? ` · ${preview}` : ''}`, 145),
  };
}

function screenEntries(project: Project, screen: Screen): OverviewEntry[] {
  const result: OverviewEntry[] = [
    {
      id: `screen:${screen.id}`,
      title: screen.name,
      body: `${screen.description}${screen.description ? '\n\n' : ''}Platform: ${screen.platform}\nState: ${screen.state}`,
      status: screen.state,
      source: { kind: 'screen', screenId: screen.id },
    },
  ];
  walkNodes(screen.nodes, (component) => {
    const destination = component.action
      ? project.screens.find((candidate) => candidate.id === component.action!.screenId)
      : undefined;
    result.push({
      id: `component:${component.id}`,
      title: `${screen.name} · ${component.name}`,
      body: [
        `Component: ${component.type}`,
        component.text,
        ...(component.action
          ? [`Opens: ${destination?.name ?? 'Unknown screen'} (${component.action.screenId})`]
          : []),
        ...(Object.keys(component.style).length
          ? [`Appearance: ${JSON.stringify(component.style)}`]
          : []),
      ].join('\n'),
      source: { kind: 'screen', screenId: screen.id, nodeId: component.id },
    });
  });
  return result;
}

/** Derive a read-only snapshot. Nothing here changes the product or asks a model to invent links. */
export function buildProductOverview(project: Project): ProductOverview {
  const gaps: ProductOverview['gaps'] = [];
  const planEntries = PLAN_FIELDS.filter(([key]) => project.plan[key].trim()).map(
    ([key, title]): OverviewEntry => ({
      id: `plan:${key}`,
      title,
      body: project.plan[key],
      status: key === 'questions' ? 'open' : undefined,
      source: { kind: 'plan', key },
    }),
  );
  const missingSections = PLAN_FIELDS.filter(([key]) => !project.plan[key].trim());
  if (missingSections.length)
    gaps.push({
      id: 'empty_plan_sections',
      title: 'Plan sections without content',
      detail: missingSections.map(([, title]) => title).join(', '),
      source: { kind: 'plan', key: missingSections[0][0] },
    });
  if (project.plan.questions.trim())
    gaps.push({
      id: 'open_plan_questions',
      title: 'Open questions in the plan',
      detail: project.plan.questions,
      source: { kind: 'plan', key: 'questions' },
    });
  if (!project.screens.length)
    gaps.push({
      id: 'no_screens',
      title: 'No wireframe screens yet',
      detail: 'Screen relationships will appear when wireframes and navigation targets exist.',
      source: { kind: 'project' },
    });

  const screens: OverviewGraph = {
    id: 'screens',
    title: 'Screens & navigation',
    description:
      'Existing screens and their recorded states. Arrows show saved navigation targets.',
    nodes: project.screens.map((screen, index) =>
      node(
        `screen_${index}`,
        screen.name,
        'screen',
        screenEntries(project, screen),
        `${screen.state} · ${screen.platform}${screen.description ? ` · ${screen.description}` : ''}`,
      ),
    ),
    edges: [],
    notes: ['Screen states are shown as recorded; state transitions are not inferred.'],
  };
  const componentIds = new Map(
    project.screens.map((screen, index) => [
      screen.id,
      new Set(screens.nodes[index].entries.map((entry) => entry.id)),
    ]),
  );
  let navigationCount = 0;
  for (const [index, screen] of project.screens.entries()) {
    walkNodes(screen.nodes, (component) => {
      if (!component.action) return;
      const target = project.screens.findIndex((item) => item.id === component.action!.screenId);
      if (target === -1) {
        gaps.push({
          id: `unknown_navigation_${component.id}`,
          title: 'Navigation target is unavailable',
          detail: `${screen.name} · ${component.text || component.name} points to ${component.action.screenId}, which is absent from the current screens.`,
          source: { kind: 'screen', screenId: screen.id, nodeId: component.id },
        });
        return;
      }
      navigationCount++;
      if (screens.edges.length < MAX_OVERVIEW_EDGES)
        screens.edges.push({
          from: `screen_${index}`,
          to: `screen_${target}`,
          label: component.text || component.name,
          kind: 'navigation',
        });
    });
  }
  if (navigationCount > MAX_OVERVIEW_EDGES)
    screens.notes.push(
      `Showing the first ${MAX_OVERVIEW_EDGES} of ${navigationCount} navigation arrows. Every saved target is retained in the screen details.`,
    );
  if (project.screens.length > 1 && navigationCount === 0)
    gaps.push({
      id: 'no_navigation',
      title: 'No navigation targets recorded',
      detail:
        'These screens have no saved links to each other. This overview leaves them unconnected; an unlinked component may intentionally stay on its current screen.',
      source: { kind: 'screen', screenId: project.screens[0].id },
    });
  if (!screens.nodes.length)
    screens.nodes.push(
      node(
        'screens_empty',
        'No screens yet',
        'gap',
        [],
        'Add wireframes to see existing screen relationships.',
      ),
    );

  const requirements = project.requirements.map((item): OverviewEntry => ({
    id: `requirement:${item.id}`,
    title: item.status === 'accepted' ? 'Accepted requirement' : 'Proposed requirement',
    body: item.text,
    status: item.status,
    source: { kind: 'requirement', requirementId: item.id },
  }));
  const comments = project.comments.flatMap((comment): OverviewEntry[] => {
    const source: OverviewSource = { kind: 'comment', commentId: comment.id };
    const screen = project.screens.find((item) => item.id === comment.target.screenId);
    const asset = project.assets.find((item) => item.id === comment.target.assetId);
    const location = comment.previousLocation ?? screen?.name ?? asset?.title ?? 'Product';
    const componentExists =
      !comment.target.nodeId ||
      (screen && componentIds.get(screen.id)?.has(`component:${comment.target.nodeId}`));
    if (
      (comment.target.screenId && !screen) ||
      (comment.target.assetId && !asset) ||
      !componentExists
    )
      gaps.push({
        id: `unknown_comment_${comment.id}`,
        title: 'An annotation location is unavailable',
        detail: comment.body,
        source,
      });
    return [
      {
        id: `comment:${comment.id}`,
        title: `${location} · annotation`,
        body: comment.body,
        status: comment.status,
        source,
      },
      ...comment.replies.map((reply): OverviewEntry => ({
        id: `reply:${reply.id}`,
        title: `Reply · ${location}`,
        body: reply.body,
        status: comment.status,
        source,
      })),
    ];
  });
  for (const requirement of project.requirements) {
    if (
      (requirement.screenId &&
        !project.screens.some((screen) => screen.id === requirement.screenId)) ||
      (requirement.sourceCommentId &&
        !project.comments.some((comment) => comment.id === requirement.sourceCommentId))
    )
      gaps.push({
        id: `unknown_requirement_${requirement.id}`,
        title: 'A requirement reference is unavailable',
        detail: requirement.text,
        source: { kind: 'requirement', requirementId: requirement.id },
      });
  }
  const assets = project.assets.map((asset): OverviewEntry => ({
    id: `asset:${asset.id}`,
    title: asset.title,
    body: [asset.note, `Image: ${asset.imageUrl}`, `Source: ${asset.sourceUrl}`].join('\n'),
    status: asset.kind,
    source: { kind: 'asset', assetId: asset.id },
  }));
  const messages = project.chat.map((message): OverviewEntry => ({
    id: `chat:${message.id}`,
    title: message.role === 'user' ? 'Your message' : 'Assistant reply',
    body: message.text,
    status: `${message.role} discussion`,
    source: { kind: 'chat', messageId: message.id },
  }));

  const product: OverviewGraph = {
    id: 'product',
    title: 'Product overview',
    description:
      'A visual index of the product as it exists, with original context behind each item.',
    nodes: [
      node('product', project.title, 'project', [
        {
          id: 'project_summary',
          title: 'Product summary',
          body: project.summary,
          source: { kind: 'project' },
        },
        {
          id: 'project_platform',
          title: 'Platform',
          body: project.platform,
          source: { kind: 'project' },
        },
      ]),
    ],
    edges: [],
    notes: [
      'Connections in this view group related source material; they do not describe user navigation.',
      'Grouped items retain full source text in their details. Discussion and proposed requirements remain separate from accepted decisions.',
    ],
  };
  const planGroups: Array<[string, string, PlanKey[]]> = [
    ['purpose', 'Purpose & people', ['problem', 'audience', 'value', 'goals']],
    ['scope', 'Scope & boundaries', ['scope', 'outOfScope']],
    ['journeys', 'User journeys', ['journeys']],
    ['behavior', 'Rules & acceptance', ['dataRules', 'integrations', 'acceptance']],
    ['questions', 'Open questions', ['questions']],
  ];
  for (const [id, title, keys] of planGroups) {
    const entries = planEntries.filter(
      (entry) => entry.source.kind === 'plan' && keys.includes(entry.source.key),
    );
    if (entries.length) product.nodes.push(node(`plan_${id}`, title, 'plan', entries));
  }
  if (project.screens.length)
    product.nodes.push(
      node(
        'screens',
        'Wireframe screens',
        'screens',
        screens.nodes.flatMap((item) => item.entries),
        project.screens.map((screen) => `${screen.name} (${screen.state})`).join(' · '),
      ),
    );
  for (const status of ['accepted', 'proposed'] as const) {
    const entries = requirements.filter((item) => item.status === status);
    if (entries.length)
      product.nodes.push(
        node(
          `requirements_${status}`,
          status === 'accepted' ? 'Accepted requirements' : 'Proposed requirements',
          'decisions',
          entries,
        ),
      );
  }
  if (comments.length)
    product.nodes.push(
      node(
        'annotations',
        'Annotations & replies',
        'discussion',
        comments,
        comments.map((item) => `${item.status}: ${item.body}`).join(' · '),
      ),
    );
  if (assets.length)
    product.nodes.push(
      node(
        'references',
        'Visual references',
        'references',
        assets,
        project.assets
          .map((asset) => `${asset.title}${asset.note ? ` · ${asset.note}` : ''}`)
          .join(' · '),
      ),
    );
  if (messages.length)
    product.nodes.push(node('discussion', 'Product discussion', 'discussion', messages));
  product.nodes.push(
    node(
      'design',
      'Design direction',
      'design',
      [
        {
          id: 'design',
          title: 'Current design settings',
          body: Object.entries(project.design)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n'),
          source: { kind: 'design' },
        },
      ],
      `${project.design.font} type · ${project.design.accent} accent · ${project.design.radius}px corners`,
    ),
  );
  if (gaps.length)
    product.nodes.push(
      node(
        'gaps',
        'Gaps & unanswered questions',
        'gap',
        gaps.map((gap) => ({
          id: `gap:${gap.id}`,
          title: gap.title,
          body: gap.detail,
          status: 'open',
          source: gap.source ?? { kind: 'project' },
        })),
        gaps.map((gap) => gap.title).join(' · '),
      ),
    );
  product.edges = product.nodes
    .slice(1)
    .map((item) => ({ from: 'product', to: item.id, kind: 'contains' }));

  return {
    projectId: project.id,
    graphs: [product, journeyGraph(project.plan.journeys), screens],
    stats: {
      planSections: planEntries.length,
      screens: project.screens.length,
      requirements: project.requirements.length,
      comments: project.comments.length,
      assets: project.assets.length,
      messages: project.chat.length,
    },
    gaps,
  };
}

function journeyGraph(text: string): OverviewGraph {
  const source: OverviewSource = { kind: 'plan', key: 'journeys' };
  const graph: OverviewGraph = {
    id: 'journey',
    title: 'Written journeys',
    description:
      'Journeys from the plan. Arrows show written list order only; they do not establish navigation or transitions.',
    nodes: [],
    edges: [],
    notes: [],
  };
  const sequences: Array<Array<{ number: number; body: string }>> = [];
  let current: Array<{ number: number; body: string }> = [];
  const finish = () => {
    if (current.length >= 2 && current[0].number === 1) sequences.push(current);
    current = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)[.)]\s+(.+?)\s*$/.exec(line);
    if (!match) {
      finish();
      continue;
    }
    const number = Number(match[1]);
    if (current.length && number !== current[current.length - 1].number + 1) finish();
    current.push({ number, body: match[2] });
  }
  finish();
  const total = sequences.reduce((sum, sequence) => sum + sequence.length, 0);
  let visible = 0;
  const overflow: OverviewEntry[] = [];
  for (const [sequenceIndex, sequence] of sequences.entries()) {
    let previous: string | undefined;
    for (const [itemIndex, item] of sequence.entries()) {
      const entry: OverviewEntry = {
        id: `journey:${sequenceIndex}:${itemIndex}`,
        title: `List ${sequenceIndex + 1} · item ${item.number}`,
        body: item.body,
        source,
      };
      if (visible >= MAX_JOURNEY_ITEMS) {
        overflow.push(entry);
        continue;
      }
      const id = `journey_${sequenceIndex}_${itemIndex}`;
      graph.nodes.push(
        node(id, sequences.length > 1 ? entry.title : `Item ${item.number}`, 'journey', [entry]),
      );
      if (previous)
        graph.edges.push({ from: previous, to: id, label: 'written order', kind: 'sequence' });
      previous = id;
      visible++;
    }
  }
  if (overflow.length) {
    graph.nodes.push(node('journey_remaining', 'Additional written items', 'journey', overflow));
    graph.notes.push(
      `Showing ${visible} of ${total} items individually. The remaining ${overflow.length} items are grouped with their original written order in the details.`,
    );
  }
  if (text.trim()) {
    graph.nodes.push(
      node('journey_context', 'Original journey context', 'plan', [
        {
          id: 'plan:journeys',
          title: 'User journeys',
          body: text,
          source,
        },
      ]),
    );
    graph.notes.push(
      sequences.length
        ? 'Arrows show the written order of numbered items within each list. A list may describe independent journeys; this order does not establish navigation or state transitions. Other prose remains in the original context.'
        : 'The plan describes journeys in prose or without a complete numbered sequence. It is shown as context; no order or screen connections have been invented.',
    );
  } else {
    graph.nodes.push(
      node(
        'journey_empty',
        'No journey written yet',
        'gap',
        [],
        'Existing journeys will appear here when they are added to the plan.',
      ),
    );
    graph.notes.push('There is no written journey to visualize yet.');
  }
  return graph;
}

/** Mermaid is an internal rendering format. Quotes, entities and syntax are always encoded as text. */
function mermaidLabel(text: string, limit: number): string {
  return excerpt(text.replace(/[\u0000-\u001f\u007f]/g, ' '), limit).replace(
    /[&#<>"`\\[\]{}|%ﬂ°¶ß]/g,
    (character) => `#${character.codePointAt(0)!};`,
  );
}

export function overviewMermaid(graph: OverviewGraph): string {
  const ids = new Map(
    graph.nodes.map((item, index) => [
      item.id,
      /^[A-Za-z][A-Za-z0-9_]*$/.test(item.id) ? item.id : `overview_${index}`,
    ]),
  );
  const lines = [graph.id === 'product' ? 'mindmap' : 'flowchart TD'];
  for (const [index, item] of graph.nodes.entries()) {
    const indent = graph.id === 'product' && index > 0 ? '    ' : '  ';
    lines.push(`${indent}${ids.get(item.id)}["${mermaidLabel(item.label, 145)}"]`);
  }
  if (graph.id !== 'product') {
    for (const edge of graph.edges.slice(0, MAX_OVERVIEW_EDGES)) {
      const from = ids.get(edge.from),
        to = ids.get(edge.to);
      if (!from || !to) continue;
      const label = edge.label ? `|"${mermaidLabel(edge.label, 45)}"|` : '';
      lines.push(`  ${from} ${edge.kind === 'contains' ? '---' : '-->'}${label} ${to}`);
    }
  }
  const result = `${lines.join('\n')}\n`;
  if (result.length > MAX_OVERVIEW_SOURCE_LENGTH)
    throw new Error('The overview is too large to render. Full source details remain available.');
  return result;
}
