import { describe, expect, it } from 'vitest';
import {
  createNode,
  createProject,
  reconcileReferences,
  type AIResult,
  type WireNode,
} from '../shared/model';
import { createSampleProject } from '../shared/seed';
import { boundedJsonDepth, projectSchema, resultSchema } from '../shared/validation';
import { proposalToProject } from '../worker/projects';

const result = (): AIResult => ({
  title: 'Proposal',
  summary: 'A focused change',
  reply: 'Ready for review.',
  plan: { problem: 'Help people plan useful products.' },
  screens: null,
  design: null,
  requirements: [],
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
        id: 'proposal',
        jobId: 'job',
        projectId: p.id,
        baseRevision: 1,
        createdAt: p.createdAt,
        status: 'pending',
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

describe('reference reconciliation', () => {
  it('preserves accepted notes and requirement text when AI replaces the screen draft', () => {
    const p = createSampleProject(),
      before = structuredClone(p),
      original = p.comments[0];
    const next = proposalToProject(
      p,
      {
        id: 'proposal',
        jobId: 'job',
        projectId: p.id,
        baseRevision: 1,
        createdAt: p.createdAt,
        status: 'pending',
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
