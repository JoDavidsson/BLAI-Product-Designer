import { describe, expect, it } from 'vitest';
import { createProject, createNode, type AIResult, type Screen } from '../shared/model';
import { bridgeSchema, CANVAS_CAPABILITY, validateResultForJob } from '../worker/jobs';

const result: AIResult = {
  title: 'One more requirement',
  summary: 'Clarify acceptance criteria',
  reply: 'A proposed acceptance criterion.',
  plan: null,
  screens: null,
  design: null,
  requirements: [{ text: 'The user can export the accepted specification.' }],
};

describe('AI proposal composition', () => {
  it('rejects a result that exceeds the total requirement limit before publishing it', () => {
    const project = createProject();
    project.requirements = Array.from({ length: 500 }, (_, index) => ({
      id: `requirement_${index}`,
      text: `Existing requirement ${index}`,
      status: 'accepted',
    }));
    const job = {
      kind: 'plan.review' as const,
      screen_id: null,
      context: JSON.stringify(project),
    };
    expect(() => validateResultForJob(result, job)).toThrow(/project’s limits/);
    // A review with no additional requirements remains useful at capacity.
    expect(() => validateResultForJob({ ...result, requirements: [] }, job)).not.toThrow();
    expect(project.requirements).toHaveLength(500);
  });
  it('preserves freeform geometry and resolves generated image IDs against the job snapshot', () => {
    const project = createProject();
    const canvas: Screen = {
      id: 'canvas_one',
      name: 'Design',
      platform: 'mobile',
      state: 'default',
      description: '',
      canvas: { width: 390, height: 844 },
      nodes: [
        {
          ...createNode('image'),
          id: 'photo_layer',
          frame: { x: 20, y: 60, width: 350, height: 500, rotation: 0 },
          image: { assetId: 'photo', fit: 'cover' },
        },
      ],
    };
    project.assets = [
      {
        id: 'photo',
        title: 'Reference',
        kind: 'reference',
        imageUrl: '/sample/photo.png',
        sourceUrl: '',
        note: '',
        createdAt: project.createdAt,
      },
    ];
    project.screens = [canvas];
    for (const kind of ['wireframe.generate', 'wireframe.refine'] as const) {
      const job = { kind, screen_id: canvas.id, context: JSON.stringify(project) };
      const output = { ...result, screens: [structuredClone(canvas)], requirements: [] };
      expect(() => validateResultForJob(output, job)).not.toThrow();
      delete output.screens[0].canvas;
      output.screens[0].nodes = [];
      expect(() => validateResultForJob(output, job)).toThrow(/remove freeform canvas geometry/);
      output.screens[0] = structuredClone(canvas);
      output.screens[0].nodes[0].image!.assetId = 'foreign_photo';
      expect(() => validateResultForJob(output, job)).toThrow(/project’s limits/);
    }
  });
});

describe('optional helper telemetry protocol', () => {
  const claim = {
    action: 'claim',
    protocolVersion: 1,
    workerId: 'helper_test',
    capabilities: ['plan.assist'],
  };
  it('accepts old claims and bounded semantic versions without allowing arbitrary metadata', () => {
    expect(bridgeSchema.safeParse(claim).success).toBe(true);
    for (const helperVersion of ['1.0.2', '1.0.2-preview.1'])
      expect(bridgeSchema.safeParse({ ...claim, helperVersion }).success).toBe(true);
    for (const helperVersion of [
      '',
      'latest',
      '1.0',
      '1.0.2\n',
      '1.0.2+build',
      `1.0.2-${'a'.repeat(60)}`,
    ])
      expect(bridgeSchema.safeParse({ ...claim, helperVersion }).success).toBe(false);
    expect(
      bridgeSchema.safeParse({
        ...claim,
        helperVersion: '1.0.2',
        telemetry: { stage: 'launching' },
      }).success,
    ).toBe(false);
  });
  it('negotiates a closed canvas capability only alongside supported work', () => {
    expect(
      bridgeSchema.safeParse({ ...claim, capabilities: ['wireframe.generate', CANVAS_CAPABILITY] })
        .success,
    ).toBe(true);
    expect(bridgeSchema.safeParse({ ...claim, capabilities: [CANVAS_CAPABILITY] }).success).toBe(
      false,
    );
    expect(
      bridgeSchema.safeParse({ ...claim, capabilities: ['wireframe.generate', 'canvas.v2'] })
        .success,
    ).toBe(false);
  });
});
