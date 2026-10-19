import { describe, expect, it } from 'vitest';
import {
  createNode,
  createProject,
  MAX_DIAGRAMS,
  MAX_DIAGRAM_SOURCE_LENGTH,
  reconcileReferences,
  type AIResult,
  type ProductDiagram,
  type Project,
  type WireNode,
} from '../shared/model';
import { createSampleProject } from '../shared/seed';
import { boundedJsonDepth, projectSchema, resultSchema } from '../shared/validation';
import { proposalToProject } from '../worker/projects';

function canvasProject(): Project {
  const project = createProject();
  const layer = createNode('rectangle');
  layer.frame = { x: -20, y: 30, width: 160, height: 90, rotation: 25 };
  layer.style = {
    background: '#ffffff',
    stroke: '#123',
    strokeWidth: 2,
    opacity: 0.8,
    fontWeight: 600,
  };
  project.screens = [
    {
      id: 'canvas_screen',
      name: 'Canvas',
      platform: 'desktop',
      state: 'default',
      description: '',
      canvas: { width: 1000, height: 800 },
      nodes: [layer],
    },
  ];
  return project;
}

const result = (): AIResult => ({
  title: 'Proposal',
  summary: 'A focused change',
  reply: 'Ready for review.',
  plan: { problem: 'Help people plan useful products.' },
  screens: null,
  design: null,
  requirements: [],
});
const diagram = (id = 'diagram_one'): ProductDiagram => ({
  id,
  title: 'Member journey',
  kind: 'flowchart',
  source: 'flowchart LR\n  Home --> Details',
});
describe('project and AI data safety', () => {
  it('rejects arbitrary component code, unsafe CSS, duplicate IDs and unknown properties', () => {
    const p = createProject();
    p.screens = [
      {
        id: 'screen_one',
        name: 'One',
        description: '',
        platform: 'desktop',
        state: 'default',
        nodes: [createNode('button')],
      },
    ];
    expect(projectSchema.safeParse(p).success).toBe(true);
    expect(projectSchema.safeParse({ ...p, html: '<script>' }).success).toBe(false);
    p.screens[0].nodes[0].style.background = 'url(https://example.com/pixel)';
    expect(projectSchema.safeParse(p).success).toBe(false);
    p.screens[0].nodes[0].style = {};
    p.screens[0].nodes.push(structuredClone(p.screens[0].nodes[0]));
    expect(projectSchema.safeParse(p).success).toBe(false);
  });
  it('allows ten component levels and rejects eleven before application', () => {
    function nested(levels: number): WireNode {
      const node = createNode('column');
      if (levels > 1) node.children = [nested(levels - 1)];
      return node;
    }
    const r = result();
    r.screens = [
      {
        id: 'screen',
        name: 'Example',
        description: '',
        platform: 'mobile',
        state: 'default',
        nodes: [nested(10)],
      },
    ];
    expect(resultSchema.safeParse(r).success).toBe(true);
    r.screens[0].nodes = [nested(11)];
    expect(resultSchema.safeParse(r).success).toBe(false);
    let huge: unknown = {};
    for (let i = 0; i < 40; i++) huge = { child: huge };
    expect(boundedJsonDepth(huge)).toBe(false);
  });
  it('refines only the requested screen and selectively applies plan fields', () => {
    const p = createProject();
    p.plan.scope = 'Keep this manual scope';
    p.screens = [
      {
        id: 'one',
        name: 'One',
        platform: 'desktop',
        state: 'default',
        description: 'Original',
        nodes: [],
      },
      {
        id: 'two',
        name: 'Two',
        platform: 'mobile',
        state: 'default',
        description: 'Manual screen',
        nodes: [],
      },
    ];
    const base = {
      id: 'proposal',
      jobId: 'job',
      projectId: p.id,
      baseRevision: 1,
      createdAt: new Date().toISOString(),
      status: 'pending' as const,
    };
    const refined = proposalToProject(
      p,
      {
        ...base,
        kind: 'wireframe.refine',
        result: { ...result(), screens: [{ ...p.screens[0], description: 'Improved' }] },
      },
      'Refine first',
      'one',
    );
    expect(refined.screens[1]).toEqual(p.screens[1]);
    expect(refined.plan).toEqual(p.plan);
    expect(() =>
      proposalToProject(
        p,
        { ...base, kind: 'wireframe.refine', result: { ...result(), screens: [p.screens[1]] } },
        'Refine',
        'one',
      ),
    ).toThrow(/requested screen/);
    const planned = proposalToProject(
      p,
      { ...base, kind: 'plan.assist', result: result() },
      'Help',
    );
    expect(planned.plan.scope).toBe('Keep this manual scope');
    expect(planned.plan.problem).toMatch(/Help people/);
  });
  it('appends only the accepted assistant reply without repeating the saved user message', () => {
    const p = createProject();
    p.chat = [
      {
        id: 'chat_user',
        role: 'user',
        text: 'Help me clarify the problem',
        createdAt: p.createdAt,
      },
    ];
    const next = proposalToProject(
      p,
      {
        kind: 'plan.assist',
        result: result(),
      },
      'Help me clarify the problem',
    );
    expect(next.chat.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(next.chat[0]).toEqual(p.chat[0]);
    expect(next.chat[1].text).toBe(result().reply);
  });
});

describe('additive freeform scenes', () => {
  it('preserves legacy documents exactly and round-trips complete scene geometry', () => {
    const legacy = createSampleProject();
    expect(projectSchema.parse(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
    const project = canvasProject();
    const group = createNode('group');
    group.frame = { x: 100, y: 80, width: 500, height: 400, rotation: -45 };
    group.layout = 'row';
    group.locked = true;
    group.hidden = false;
    group.children = project.screens[0].nodes;
    for (const type of ['ellipse', 'line', 'text', 'path'] as const) {
      const node = createNode(type, type === 'text' ? 'Editable text' : '');
      node.frame = { x: 20, y: 40, width: 60, height: 50, rotation: 0 };
      if (type === 'path')
        node.points = [
          { x: 0, y: 0 },
          { x: 0.4, y: 1 },
          { x: 1, y: 0 },
        ];
      group.children.push(node);
    }
    project.screens[0].nodes = [group];
    const encoded = JSON.stringify(project);
    expect(projectSchema.parse(JSON.parse(encoded))).toEqual(project);
    expect(resultSchema.parse({ ...result(), screens: project.screens }).screens).toEqual(
      project.screens,
    );
  });

  it('rejects non-finite, incomplete, oversized and executable-looking geometry and styles', () => {
    const original = canvasProject();
    for (const patch of [
      { x: Infinity },
      { y: NaN },
      { x: -20001 },
      { y: 20001 },
      { width: 0 },
      { height: 20001 },
      { rotation: 361 },
      { rotation: -361 },
      { width: undefined },
      { transform: 'rotate(20deg)' },
    ]) {
      const project = structuredClone(original);
      Object.assign(project.screens[0].nodes[0].frame!, patch);
      expect(projectSchema.safeParse(project).success, JSON.stringify(patch)).toBe(false);
    }
    for (const canvas of [
      { width: 99, height: 100 },
      { width: 100, height: 10001 },
      { width: NaN, height: 100 },
    ])
      expect(
        projectSchema.safeParse({ ...original, screens: [{ ...original.screens[0], canvas }] })
          .success,
      ).toBe(false);
    for (const patch of [
      { stroke: 'url(https://example.com/pixel)' },
      { strokeWidth: 33 },
      { strokeWidth: -1 },
      { opacity: 1.1 },
      { opacity: -0.1 },
      { fontWeight: 900 },
      { position: 'fixed' },
    ]) {
      const project = structuredClone(original);
      Object.assign(project.screens[0].nodes[0].style, patch);
      expect(projectSchema.safeParse(project).success).toBe(false);
    }
  });

  it('requires frames throughout canvas trees and disallows scene data on flow screens', () => {
    const project = canvasProject();
    const parent = createNode('group');
    parent.frame = { x: 0, y: 0, width: 300, height: 200, rotation: 0 };
    parent.children = [createNode('text')];
    project.screens[0].nodes = [parent];
    expect(projectSchema.safeParse(project).success).toBe(false);
    parent.children[0].frame = { x: 10, y: 10, width: 200, height: 30, rotation: 0 };
    expect(projectSchema.safeParse(project).success).toBe(true);
    delete project.screens[0].canvas;
    expect(projectSchema.safeParse(project).success).toBe(false);
    for (const type of ['group', 'rectangle', 'ellipse', 'line', 'path'] as const) {
      project.screens[0].nodes = [createNode(type)];
      if (type === 'path')
        project.screens[0].nodes[0].points = [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ];
      expect(projectSchema.safeParse(project).success).toBe(false);
    }
    project.screens[0].nodes = [createNode('text')];
    expect(projectSchema.safeParse(project).success).toBe(true);
    project.screens[0].nodes[0].hidden = true;
    expect(projectSchema.safeParse(project).success).toBe(false);
  });

  it('keeps layout, point and image data attached to the supported layer types', () => {
    const project = canvasProject();
    const node = project.screens[0].nodes[0];
    node.layout = 'row';
    expect(projectSchema.safeParse(project).success).toBe(false);
    node.type = 'group';
    expect(projectSchema.safeParse(project).success).toBe(true);
    delete node.layout;
    node.points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(projectSchema.safeParse(project).success).toBe(false);
    node.type = 'path';
    expect(projectSchema.safeParse(project).success).toBe(true);
    for (const points of [
      undefined,
      [],
      [{ x: 0, y: 0 }],
      [
        { x: -0.1, y: 0 },
        { x: 1, y: 1 },
      ],
      Array.from({ length: 257 }, () => ({ x: 0, y: 0 })),
    ]) {
      node.points = points;
      expect(projectSchema.safeParse(project).success).toBe(false);
    }
    delete node.points;
    node.type = 'rectangle';
    node.image = { assetId: 'image_one', fit: 'cover' };
    expect(projectSchema.safeParse(project).success).toBe(false);
  });

  it('accepts only image references available in this project, without embedded or remote URLs', () => {
    const project = canvasProject();
    const node = project.screens[0].nodes[0];
    node.type = 'image';
    node.image = { assetId: 'image_one', fit: 'contain' };
    expect(projectSchema.safeParse(project).success).toBe(false);
    project.assets = [
      {
        id: 'image_one',
        title: 'Owned upload',
        kind: 'reference',
        imageUrl: '/api/assets/owned_key',
        sourceUrl: '',
        note: '',
        createdAt: project.createdAt,
      },
    ];
    expect(projectSchema.safeParse(project).success).toBe(true);
    node.image.assetId = 'another_project_image';
    expect(projectSchema.safeParse(project).success).toBe(false);
    node.image.assetId = 'image_one';
    project.assets[0].imageUrl = '';
    expect(projectSchema.safeParse(project).success).toBe(false);
    project.assets[0].imageUrl = '/api/assets/owned_key';
    Object.assign(node.image, { url: 'https://example.com/pixel' });
    expect(projectSchema.safeParse(project).success).toBe(false);
  });

  it('keeps geometry and stable annotations through unrelated AI plan edits', () => {
    const project = canvasProject();
    const node = project.screens[0].nodes[0];
    project.comments = [
      {
        id: 'canvas_comment',
        target: { kind: 'node', screenId: 'canvas_screen', nodeId: node.id, x: 0.2, y: 0.8 },
        body: 'Keep this layer',
        status: 'open',
        replies: [],
        createdAt: project.createdAt,
      },
    ];
    const next = proposalToProject(
      project,
      { kind: 'plan.assist', result: result() },
      'Clarify the plan',
    );
    expect(next.screens).toEqual(project.screens);
    expect(next.comments).toEqual(project.comments);
    expect(projectSchema.safeParse(next).success).toBe(true);
  });
});

describe('portable diagram drafts', () => {
  it('accepts legacy projects and preserves incomplete Mermaid drafts without migration', () => {
    const legacy = createProject();
    delete legacy.diagrams;
    expect(projectSchema.parse(legacy)).toEqual(legacy);
    const draft = {
      ...legacy,
      diagrams: [diagram(), { ...diagram('diagram_states'), kind: 'state', source: '' }],
    };
    expect(projectSchema.parse(draft)).toEqual(draft);
  });

  it('bounds diagram count, source length, names, and the supported record shape', () => {
    const p = createProject();
    p.diagrams = Array.from({ length: MAX_DIAGRAMS }, (_, index) => diagram(`diagram_${index}`));
    p.diagrams[0].source = 'a'.repeat(MAX_DIAGRAM_SOURCE_LENGTH);
    p.diagrams[0].title = 'a'.repeat(120);
    expect(projectSchema.safeParse(p).success).toBe(true);
    expect(
      projectSchema.safeParse({ ...p, diagrams: [...p.diagrams, diagram('extra')] }).success,
    ).toBe(false);
    for (const invalid of [
      { source: 'a'.repeat(MAX_DIAGRAM_SOURCE_LENGTH + 1) },
      { title: '' },
      { title: 'a'.repeat(121) },
      { kind: 'sequence' },
      { html: '<svg />' },
    ])
      expect(
        projectSchema.safeParse({ ...p, diagrams: [{ ...diagram(), ...invalid }] }).success,
      ).toBe(false);
  });

  it('reserves diagram IDs across diagrams, wireframes, and other project objects', () => {
    const p = createSampleProject();
    p.assets = [
      {
        id: 'asset_one',
        title: 'Reference',
        kind: 'reference',
        imageUrl: '',
        sourceUrl: '',
        note: '',
        createdAt: p.createdAt,
      },
    ];
    for (const id of [p.screens[0].id, p.screens[0].nodes[0].id, p.assets[0].id, p.comments[0].id])
      expect(projectSchema.safeParse({ ...p, diagrams: [diagram(id)] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...p, diagrams: [diagram(), diagram()] }).success).toBe(false);
  });

  it('preserves diagram drafts when applying existing AI plan and screen proposals', () => {
    const p = createSampleProject();
    p.diagrams = [diagram()];
    for (const kind of ['plan.assist', 'wireframe.generate'] as const) {
      const next = proposalToProject(
        p,
        {
          kind,
          result: {
            ...result(),
            screens:
              kind === 'wireframe.generate'
                ? [{ ...p.screens[0], id: 'replacement_screen', nodes: [] }]
                : null,
          },
        },
        'Improve this draft',
      );
      expect(next.diagrams).toEqual(p.diagrams);
      expect(projectSchema.safeParse(next).success).toBe(true);
    }
    expect(resultSchema.safeParse({ ...result(), diagrams: p.diagrams }).success).toBe(false);
  });
});

describe('reference reconciliation', () => {
  it('preserves accepted notes and requirement text when AI replaces the screen draft', () => {
    const p = createSampleProject(),
      before = structuredClone(p),
      original = p.comments[0];
    const next = proposalToProject(
      p,
      {
        kind: 'wireframe.generate',
        result: {
          ...result(),
          plan: null,
          screens: [
            {
              id: 'new_screen',
              name: 'New draft',
              platform: 'desktop',
              state: 'default',
              description: '',
              nodes: [],
            },
          ],
        },
      },
      'Generate a new draft',
    );
    expect(next.comments[0]).toMatchObject({
      id: original.id,
      body: original.body,
      status: 'accepted',
      target: { kind: 'project' },
      requirementId: original.requirementId,
    });
    expect(next.comments[0].previousLocation).toContain('Trip overview');
    expect(next.comments[0].previousLocation).toContain('Button');
    expect(next.requirements[0]).toMatchObject({
      text: p.requirements[0].text,
      status: 'accepted',
      sourceCommentId: original.id,
    });
    expect(next.requirements[0].screenId).toBeUndefined();
    expect(projectSchema.safeParse(next).success).toBe(true);
    expect(p).toEqual(before);
    expect(reconcileReferences(next, p)).toEqual(next);
  });
  it('recovers comments filtered out by screen deletion and removes broken navigation', () => {
    const p = createSampleProject();
    const next = reconcileReferences({ ...p, screens: p.screens.slice(1), comments: [] }, p);
    expect(next.comments).toHaveLength(1);
    expect(next.comments[0].body).toBe(p.comments[0].body);
    expect(next.comments[0].target.kind).toBe('project');
    const linked = createSampleProject(),
      button = createNode('button');
    button.action = { screenId: linked.screens[0].id };
    linked.screens[1].nodes.push(button);
    const removed = reconcileReferences({ ...linked, screens: linked.screens.slice(1) }, linked);
    expect(removed.screens[0].nodes.at(-1)?.action).toBeUndefined();
  });
  it('keeps node notes attached when a node moves and respects explicit comment deletion', () => {
    const p = createSampleProject(),
      nodeId = p.comments[0].target.nodeId!;
    // Move the annotated component to another screen, maintaining its stable ID.
    const moved = structuredClone(p);
    const container = moved.screens[0].nodes.find((node) =>
      node.children.some((child) => child.id === nodeId),
    )!;
    const node = container.children.find((child) => child.id === nodeId)!;
    container.children = container.children.filter((child) => child.id !== nodeId);
    moved.screens[1].nodes.push(node);
    expect(reconcileReferences(moved, p).comments[0].target).toMatchObject({
      kind: 'node',
      nodeId,
      screenId: p.screens[1].id,
    });
    const removed = reconcileReferences({ ...p, comments: [] }, p);
    expect(removed.comments).toHaveLength(0);
    expect(removed.requirements[0].sourceCommentId).toBeUndefined();
    expect(removed.requirements[0].text).toBe(p.requirements[0].text);
  });
  it('preserves removed image notes with their reference title and normalized project coordinates', () => {
    const p = createProject();
    p.assets = [
      {
        id: 'asset_one',
        title: 'Quiet editorial spacing',
        kind: 'reference',
        imageUrl: '',
        sourceUrl: 'https://example.com',
        note: '',
        createdAt: p.createdAt,
      },
    ];
    p.comments = [
      {
        id: 'comment_one',
        target: { kind: 'asset', assetId: 'asset_one', x: 0.2, y: 0.8 },
        body: 'Keep this generous spacing.',
        status: 'open',
        replies: [{ id: 'reply_one', body: 'Agreed.', createdAt: p.createdAt }],
        createdAt: p.createdAt,
      },
    ];
    const next = reconcileReferences({ ...p, assets: [] }, p);
    expect(next.comments[0].target).toEqual({ kind: 'project', x: 0.2, y: 0.8 });
    expect(next.comments[0].previousLocation).toContain('Quiet editorial spacing');
    expect(next.comments[0].replies).toEqual(p.comments[0].replies);
    expect(next.comments[0].body).toBe(p.comments[0].body);
  });
});
