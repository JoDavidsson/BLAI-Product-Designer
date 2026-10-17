import { describe, expect, it } from 'vitest';
import { register, render } from 'pele/core';
import flowchart from 'pele/diagrams/flowchart';
import mindmap from 'pele/diagrams/mindmap';
import { createNode, createProject, PLAN_FIELDS, type Project, type Screen } from '../shared/model';
import { createSampleProject } from '../shared/seed';
import {
  buildProductOverview,
  MAX_OVERVIEW_EDGES,
  MAX_OVERVIEW_SOURCE_LENGTH,
  overviewMermaid,
  type OverviewGraph,
} from '../shared/overview';

register(flowchart, mindmap);

function graph(project: Project, id: OverviewGraph['id']) {
  return buildProductOverview(project).graphs.find((item) => item.id === id)!;
}
function screen(id: string, name = id): Screen {
  return { id, name, description: '', platform: 'desktop', state: 'default', nodes: [] };
}
function entries(project: Project) {
  return graph(project, 'product').nodes.flatMap((item) => item.entries);
}

describe('Automatic product overview', () => {
  it('is deterministic, does not mutate the project, and preserves the original plan', () => {
    const project = createSampleProject();
    const original = structuredClone(project);
    const first = buildProductOverview(project);
    expect(buildProductOverview(project)).toEqual(first);
    expect(project).toEqual(original);
    for (const [key] of PLAN_FIELDS)
      expect(entries(project)).toContainEqual(
        expect.objectContaining({
          body: project.plan[key],
          source: { kind: 'plan', key },
        }),
      );
    expect(first.stats).toEqual({
      planSections: 11,
      screens: 3,
      requirements: 1,
      comments: 1,
      assets: 0,
      messages: 0,
    });
    expect(first.graphs[0].nodes.length).toBeLessThanOrEqual(14);
    expect(first.graphs[0].nodes.find((node) => node.id === 'plan_purpose')!.label).toContain(
      'Planning a short trip',
    );
  });

  it('connects only explicit component actions, including nested actions and self-links', () => {
    const project = createProject();
    project.screens = [
      screen('first', 'Checkout'),
      screen('second', 'Payment'),
      screen('third', 'Done'),
    ];
    project.screens[1].state = 'error';
    const nested = createNode('button', 'Try payment again');
    nested.action = { screenId: 'second' };
    project.screens[0].nodes = [{ ...createNode('section'), children: [nested] }];
    const self = createNode('button', 'Reload payment');
    self.action = { screenId: 'second' };
    project.screens[1].nodes = [self];
    project.screens[2].description = 'Return to Checkout and then open Payment.';
    const result = graph(project, 'screens');
    expect(result.edges).toEqual([
      { from: 'screen_0', to: 'screen_1', label: 'Try payment again', kind: 'navigation' },
      { from: 'screen_1', to: 'screen_1', label: 'Reload payment', kind: 'navigation' },
    ]);
    expect(result.nodes[1].label).toContain('error');
    expect(result.nodes[0].entries).toContainEqual(
      expect.objectContaining({
        source: { kind: 'screen', screenId: 'first', nodeId: nested.id },
        body: expect.stringContaining('Opens: Payment (second)'),
      }),
    );
    expect(result.edges.some((edge) => edge.to === 'screen_2')).toBe(false);
  });

  it('reports missing targets without treating every unlinked button as a product error', () => {
    const project = createProject();
    project.screens = [screen('first'), screen('second')];
    const broken = createNode('button', 'Old destination');
    broken.action = { screenId: 'removed' };
    const unlinked = createNode('button', 'Save on current screen');
    project.screens[0].nodes = [broken, unlinked];
    const result = buildProductOverview(project);
    expect(result.gaps.filter((gap) => gap.id.startsWith('unknown_navigation'))).toEqual([
      expect.objectContaining({
        source: { kind: 'screen', screenId: 'first', nodeId: broken.id },
        detail: expect.stringContaining('removed'),
      }),
    ]);
    expect(result.gaps.find((gap) => gap.id === 'no_navigation')!.detail).toContain(
      'may intentionally stay on its current screen',
    );
    expect(JSON.stringify(result.gaps)).not.toContain(unlinked.id);
    expect(graph(project, 'screens').edges).toEqual([]);
  });

  it('shows written order while preserving separate numbered lists and original context', () => {
    const project = createProject();
    project.plan.journeys =
      'New user\n1. Choose a place\n2. Save the place\n\nReturning user\n1) Open saved places\n2) Remove a place';
    const result = graph(project, 'journey');
    expect(result.edges).toEqual([
      { from: 'journey_0_0', to: 'journey_0_1', label: 'written order', kind: 'sequence' },
      { from: 'journey_1_0', to: 'journey_1_1', label: 'written order', kind: 'sequence' },
    ]);
    expect(result.nodes[0].title).toBe('List 1 · item 1');
    expect(result.nodes.find((node) => node.id === 'journey_context')!.entries[0].body).toBe(
      project.plan.journeys,
    );
    expect(result.nodes.flatMap((node) => node.entries).map((entry) => entry.body)).toContain(
      'Save the place',
    );
  });

  it('labels independent numbered journeys as written order without implying navigation', () => {
    const project = createProject();
    project.plan.journeys = '1. Sign up for a new account.\n2. Reset a forgotten password.';
    const result = graph(project, 'journey');
    expect(result.nodes.slice(0, 2).map((node) => node.title)).toEqual(['Item 1', 'Item 2']);
    expect(result.nodes.slice(0, 2).map((node) => node.entries[0].body)).toEqual([
      'Sign up for a new account.',
      'Reset a forgotten password.',
    ]);
    expect(result.edges).toEqual([
      { from: 'journey_0_0', to: 'journey_0_1', label: 'written order', kind: 'sequence' },
    ]);
    expect(result.edges.some((edge) => edge.kind === 'navigation')).toBe(false);
    expect(result.description).toContain('do not establish navigation or transitions');
    expect(result.notes.join(' ')).toContain('independent journeys');
    expect(overviewMermaid(result)).toContain('|"written order"|');
  });

  it.each([
    'People can save places. They might choose a place after searching.',
    '- Open the product\n- Save a place',
    '1. Open the product\n3. Save a place',
    '2. Open the product\n3. Save a place',
    '1. Open the product\nUnspecified next action\n2. Save a place',
  ])('does not invent sequencing from prose or incomplete lists: %s', (journeys) => {
    const project = createProject();
    project.plan.journeys = journeys;
    const result = graph(project, 'journey');
    expect(result.edges).toEqual([]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].entries[0].body).toBe(journeys);
  });

  it('retains every source in large groups and distinguishes acceptance from discussion', () => {
    const project = createSampleProject();
    project.assets = Array.from({ length: 100 }, (_, i) => ({
      id: `asset_${i}`,
      title: `Reference ${i}`,
      note: `Reference note ${i}`,
      kind: 'reference',
      imageUrl: `https://example.org/image-${i}.png`,
      sourceUrl: `https://example.org/${i}`,
      createdAt: project.createdAt,
    }));
    project.requirements = Array.from({ length: 500 }, (_, i) => ({
      id: `requirement_${i}`,
      text: `Original requirement ${i}`,
      status: i % 2 ? 'accepted' : 'proposed',
    }));
    project.comments = Array.from({ length: 500 }, (_, i) => ({
      id: `comment_${i}`,
      body: `Original annotation ${i}`,
      status: (['accepted', 'open', 'resolved'] as const)[i % 3],
      target: { kind: 'project', x: 0.5, y: 0.5 },
      createdAt: project.createdAt,
      replies: [{ id: `reply_${i}`, body: `Original reply ${i}`, createdAt: project.createdAt }],
    }));
    project.chat = Array.from({ length: 200 }, (_, i) => ({
      id: `message_${i}`,
      role: i % 2 ? 'assistant' : 'user',
      text: `Original discussion ${i}`,
      createdAt: project.createdAt,
    }));
    const result = graph(project, 'product');
    const all = result.nodes.flatMap((node) => node.entries);
    expect(result.nodes.length).toBeLessThanOrEqual(14);
    for (const requirement of project.requirements)
      expect(all).toContainEqual(
        expect.objectContaining({ body: requirement.text, status: requirement.status }),
      );
    for (const comment of project.comments) {
      expect(all).toContainEqual(
        expect.objectContaining({ body: comment.body, status: comment.status }),
      );
      expect(all).toContainEqual(
        expect.objectContaining({ body: comment.replies[0].body, status: comment.status }),
      );
    }
    for (const asset of project.assets)
      expect(all).toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining(asset.note),
          source: { kind: 'asset', assetId: asset.id },
        }),
      );
    for (const message of project.chat)
      expect(all).toContainEqual(
        expect.objectContaining({ body: message.text, status: `${message.role} discussion` }),
      );
    expect(
      result.nodes
        .find((node) => node.id === 'requirements_accepted')!
        .entries.every((entry) => entry.status === 'accepted'),
    ).toBe(true);
    expect(
      result.nodes
        .find((node) => node.id === 'requirements_proposed')!
        .entries.every((entry) => entry.status === 'proposed'),
    ).toBe(true);
    expect(result.nodes.find((node) => node.id === 'discussion')!.kind).toBe('discussion');
  });

  it('bounds rendered navigation without dropping screens or action details', () => {
    const project = createProject();
    project.screens = Array.from({ length: 30 }, (_, i) => screen(`screen_${i}`));
    project.screens[0].nodes = Array.from({ length: 200 }, (_, i) => ({
      ...createNode('button', `${'"#<>%'.repeat(20)} ${i}`),
      action: { screenId: `screen_${i % 30}` },
    }));
    const result = graph(project, 'screens');
    expect(result.nodes).toHaveLength(30);
    expect(result.edges).toHaveLength(MAX_OVERVIEW_EDGES);
    expect(result.nodes[0].entries).toHaveLength(201);
    expect(result.notes.join(' ')).toContain('first 150 of 200');
    expect(overviewMermaid(result).length).toBeLessThan(MAX_OVERVIEW_SOURCE_LENGTH);
  });

  it('groups long numbered journeys while retaining every step and the complete original', () => {
    const project = createProject();
    project.plan.journeys = Array.from(
      { length: 100 },
      (_, i) => `${i + 1}. Original step ${i + 1}`,
    ).join('\n');
    const result = graph(project, 'journey');
    expect(result.nodes.length).toBeLessThanOrEqual(25);
    const all = result.nodes.flatMap((node) => node.entries);
    for (let i = 1; i <= 100; i++)
      expect(all.some((entry) => entry.body === `Original step ${i}`)).toBe(true);
    expect(all.some((entry) => entry.body === project.plan.journeys)).toBe(true);
    expect(result.notes.join(' ')).toContain('22 of 100');
  });

  it('encodes hostile content and renders the generated overview through Pele', () => {
    const project = createProject('" ] --> INJECTED["evil <script>alert(1)</script>');
    project.summary = '`markdown` & #quot; %%{init:{securityLevel:loose}}%% 🧭 東京 café ﬂ°°34¶ß';
    project.plan.problem =
      'click product "https://example.org"\nA@{img:"https://example.org/x.png"}';
    project.plan.journeys = '1. <img src=x onerror=alert(1)>\n2. " ] --> BAD[evil';
    project.screens = [screen('" ] --> BAD[evil', '<svg onload=alert(1)>'), screen('safe')];
    project.screens[0].nodes = [
      {
        ...createNode('button', '"| BAD --> INJECTED["evil] <script>alert(1)</script>'),
        action: { screenId: 'safe' },
      },
    ];
    for (const item of buildProductOverview(project).graphs) {
      const source = overviewMermaid(item);
      const rendered = render(source, {
        links: false,
        images: false,
        autoDirection: false,
        limit: MAX_OVERVIEW_SOURCE_LENGTH,
        maxEdges: MAX_OVERVIEW_EDGES,
      });
      expect(rendered.type).toBe(item.id === 'product' ? 'mindmap' : 'flowchart');
      expect(rendered.svg).not.toMatch(/<script\b|<image\b|<a\b|<[^>]+\sonload=/);
      expect(rendered.svg).not.toContain('data-id="INJECTED"');
      expect(rendered.svg).not.toContain('data-id="BAD"');
      expect(source).not.toContain('<script>');
      expect(rendered.width).toBeGreaterThan(0);
      for (const node of item.nodes) expect(rendered.svg).toContain(`data-id="${node.id}"`);
    }
  });

  it('preserves Unicode and literal Mermaid entity placeholders in the product mindmap', () => {
    const project = createProject('🧭 東京 café ﬂ°°34¶ß');
    const product = graph(project, 'product');
    const source = overviewMermaid(product);
    const rendered = render(source, { links: false, images: false, autoDirection: false });
    expect(source.startsWith('mindmap\n')).toBe(true);
    expect(rendered.type).toBe('mindmap');
    expect(rendered.svg).toContain('🧭 東京 café ﬂ°°34¶ß');
    for (const node of product.nodes) expect(rendered.svg).toContain(`data-id="${node.id}"`);
  });

  it('identifies unknown annotation and requirement references while preserving their content', () => {
    const project = createSampleProject();
    project.comments[0].target.nodeId = 'missing_node';
    project.requirements[0].screenId = 'missing_screen';
    const result = buildProductOverview(project);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ id: `unknown_comment_${project.comments[0].id}` }),
    );
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ id: `unknown_requirement_${project.requirements[0].id}` }),
    );
    expect(entries(project)).toContainEqual(
      expect.objectContaining({ body: project.requirements[0].text }),
    );
  });

  it('does not use legacy authored diagrams as authoritative product information', () => {
    const project = createSampleProject();
    const before = buildProductOverview(project);
    project.diagrams = [
      {
        id: 'old',
        title: 'Invented payment flow',
        kind: 'flowchart',
        source: 'flowchart TD\n A[Charge money] --> B[Ship order]',
      },
    ];
    expect(buildProductOverview(project)).toEqual(before);
    expect(project.diagrams).toHaveLength(1);
  });

  it('shows honest empty states and no invented product nodes or transitions', () => {
    const project = createProject();
    const result = buildProductOverview(project);
    expect(result.gaps.map((gap) => gap.id)).toEqual(['empty_plan_sections', 'no_screens']);
    expect(graph(project, 'screens').edges).toEqual([]);
    expect(graph(project, 'journey').edges).toEqual([]);
    expect(entries(project).some((entry) => entry.source.kind === 'screen')).toBe(false);
    expect(entries(project).some((entry) => entry.source.kind === 'requirement')).toBe(false);
  });
});
