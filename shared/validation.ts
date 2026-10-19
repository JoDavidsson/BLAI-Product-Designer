import { z } from 'zod';
import {
  JOB_KINDS,
  JOB_PROGRESS_STAGES,
  MAX_DIAGRAMS,
  MAX_DIAGRAM_SOURCE_LENGTH,
  NODE_TYPES,
  PLAN_FIELDS,
  type AIResult,
  type Project,
  type WireNode,
} from './model';

export const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().max(24000);
const color = z.string().regex(/^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/);
const planShape = Object.fromEntries(PLAN_FIELDS.map(([key]) => [key, text])) as Record<
  (typeof PLAN_FIELDS)[number][0],
  typeof text
>;
export const planSchema = z.object(planShape).strict();
export const designSchema = z
  .object({
    accent: color,
    background: color,
    surface: color,
    text: color,
    muted: color,
    radius: z.number().min(0).max(64),
    font: z.enum(['sans', 'serif']),
  })
  .strict();
export const frameSchema = z
  .object({
    x: z.number().finite().min(-20000).max(20000),
    y: z.number().finite().min(-20000).max(20000),
    width: z.number().finite().min(1).max(20000),
    height: z.number().finite().min(1).max(20000),
    rotation: z.number().finite().min(-360).max(360),
  })
  .strict();
export const canvasSchema = z
  .object({
    width: z.number().finite().min(100).max(10000),
    height: z.number().finite().min(100).max(10000),
  })
  .strict();
const sceneTypes = new Set(['group', 'rectangle', 'ellipse', 'line', 'path']);
const layoutTypes = new Set(['group', 'section', 'row', 'column', 'card']);
export const nodeSchema: z.ZodType<WireNode> = z.lazy(() =>
  z
    .object({
      id: idSchema,
      type: z.enum(NODE_TYPES),
      name: z.string().max(160),
      text: z.string().max(4000),
      children: z.array(nodeSchema).max(100),
      style: z
        .object({
          background: color.optional(),
          color: color.optional(),
          fontSize: z.number().min(8).max(96).optional(),
          padding: z.number().min(0).max(100).optional(),
          gap: z.number().min(0).max(100).optional(),
          radius: z.number().min(0).max(64).optional(),
          align: z.enum(['start', 'center', 'end']).optional(),
          stroke: color.optional(),
          strokeWidth: z.number().finite().min(0).max(32).optional(),
          opacity: z.number().finite().min(0).max(1).optional(),
          fontWeight: z
            .union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)])
            .optional(),
        })
        .strict(),
      action: z.object({ screenId: idSchema }).strict().optional(),
      frame: frameSchema.optional(),
      layout: z.enum(['free', 'row', 'column']).optional(),
      image: z
        .object({ assetId: idSchema, fit: z.enum(['cover', 'contain']) })
        .strict()
        .optional(),
      points: z
        .array(
          z
            .object({
              x: z.number().finite().min(0).max(1),
              y: z.number().finite().min(0).max(1),
            })
            .strict(),
        )
        .min(2)
        .max(256)
        .optional(),
      locked: z.boolean().optional(),
      hidden: z.boolean().optional(),
    })
    .strict()
    .superRefine((node, ctx) => {
      if (node.layout !== undefined && !layoutTypes.has(node.type))
        ctx.addIssue({ code: 'custom', message: 'Only containers support automatic layout.' });
      if (node.image !== undefined && node.type !== 'image')
        ctx.addIssue({ code: 'custom', message: 'Only image layers can reference an image.' });
      if (node.type === 'path' && !node.points)
        ctx.addIssue({ code: 'custom', message: 'Path layers require points.' });
      if (node.type !== 'path' && node.points !== undefined)
        ctx.addIssue({ code: 'custom', message: 'Only path layers support points.' });
    }),
);
export const screenSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(160),
    platform: z.enum(['desktop', 'mobile']),
    description: z.string().max(4000),
    state: z.enum(['default', 'loading', 'empty', 'error', 'success']),
    nodes: z.array(nodeSchema).max(100),
    canvas: canvasSchema.optional(),
  })
  .strict()
  .superRefine((screen, ctx) => {
    const visit = (nodes: WireNode[]) => {
      for (const node of nodes) {
        if (screen.canvas && !node.frame)
          ctx.addIssue({
            code: 'custom',
            message: 'Every canvas layer requires a complete frame.',
          });
        if (
          !screen.canvas &&
          (sceneTypes.has(node.type) ||
            node.frame !== undefined ||
            node.layout !== undefined ||
            node.image !== undefined ||
            node.points !== undefined ||
            node.hidden !== undefined ||
            node.locked !== undefined)
        )
          ctx.addIssue({ code: 'custom', message: 'Scene layers require a canvas screen.' });
        visit(node.children);
      }
    };
    visit(screen.nodes);
  });
export const diagramSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(120),
    kind: z.enum(['flowchart', 'state']),
    source: z.string().max(MAX_DIAGRAM_SOURCE_LENGTH),
  })
  .strict();
const date = z.string().datetime();
const sourceUrl = z
  .string()
  .max(2048)
  .refine((v) => !v || /^https:\/\//i.test(v), 'Use an HTTPS URL.');
const assetSchema = z
  .object({
    id: idSchema,
    title: z.string().max(200),
    kind: z.enum(['reference', 'screenshot']),
    imageUrl: z
      .string()
      .max(2048)
      .refine(
        (v) =>
          !v || /^\/api\/assets\/[a-zA-Z0-9_-]+$/.test(v) || /^\/sample\/[a-zA-Z0-9_.-]+$/.test(v),
        'Use an uploaded image or a bundled sample.',
      ),
    sourceUrl,
    note: text,
    createdAt: date,
  })
  .strict();
const targetSchema = z
  .object({
    kind: z.enum(['screen', 'node', 'asset', 'project']),
    screenId: idSchema.optional(),
    nodeId: idSchema.optional(),
    assetId: idSchema.optional(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();
const commentSchema = z
  .object({
    id: idSchema,
    target: targetSchema,
    body: z.string().min(1).max(8000),
    status: z.enum(['open', 'resolved', 'accepted']),
    replies: z
      .array(
        z.object({ id: idSchema, body: z.string().min(1).max(8000), createdAt: date }).strict(),
      )
      .max(100),
    createdAt: date,
    requirementId: idSchema.optional(),
    previousLocation: z.string().max(1000).optional(),
  })
  .strict();
export const projectSchema: z.ZodType<Project> = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(200),
    summary: z.string().max(4000),
    platform: z.enum(['web', 'mobile', 'both']),
    createdAt: date,
    updatedAt: date,
    revision: z.number().int().positive(),
    plan: planSchema,
    design: designSchema,
    screens: z.array(screenSchema).max(30),
    diagrams: z.array(diagramSchema).max(MAX_DIAGRAMS).optional(),
    assets: z.array(assetSchema).max(100),
    comments: z.array(commentSchema).max(500),
    requirements: z
      .array(
        z
          .object({
            id: idSchema,
            text: z.string().min(1).max(8000),
            sourceCommentId: idSchema.optional(),
            screenId: idSchema.optional(),
            status: z.enum(['proposed', 'accepted']),
          })
          .strict(),
      )
      .max(500),
    chat: z
      .array(
        z
          .object({ id: idSchema, role: z.enum(['user', 'assistant']), text, createdAt: date })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = new Set<string>();
    const assets = new Map(p.assets.map((asset) => [asset.id, asset]));
    let count = 0;
    function add(id: string) {
      if (ids.has(id)) ctx.addIssue({ code: 'custom', message: `Duplicate identifier: ${id}` });
      ids.add(id);
    }
    function visit(nodes: WireNode[], depth: number) {
      if (nodes.length && depth > 10) {
        ctx.addIssue({
          code: 'custom',
          message: 'Components cannot be nested more than 10 levels.',
        });
        return;
      }
      for (const n of nodes) {
        add(n.id);
        count++;
        if (n.image && !assets.get(n.image.assetId)?.imageUrl)
          ctx.addIssue({
            code: 'custom',
            message: 'Image layers must reference an existing project image.',
          });
        visit(n.children, depth + 1);
      }
    }
    for (const screen of p.screens) {
      add(screen.id);
      visit(screen.nodes, 1);
    }
    for (const list of [p.assets, p.comments, p.requirements, p.chat, p.diagrams ?? []])
      for (const item of list) add(item.id);
    if (count > 1000)
      ctx.addIssue({ code: 'custom', message: 'A project supports up to 1,000 components.' });
  });
export const resultSchema: z.ZodType<AIResult> = z
  .object({
    title: z.string().min(1).max(200),
    summary: z.string().max(4000),
    reply: z.string().max(16000),
    plan: planSchema.partial().nullable(),
    screens: z.array(screenSchema).max(12).nullable(),
    design: designSchema.nullable(),
    requirements: z
      .array(
        z.object({ text: z.string().min(1).max(8000), screenId: idSchema.optional() }).strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    let count = 0;
    const add = (id: string) => {
      if (seen.has(id))
        ctx.addIssue({
          code: 'custom',
          message: 'AI output contains duplicate component or screen identifiers.',
        });
      seen.add(id);
    };
    const walk = (nodes: WireNode[], depth: number) => {
      if (nodes.length && depth > 10) {
        ctx.addIssue({ code: 'custom', message: 'AI output is too deeply nested.' });
        return;
      }
      for (const node of nodes) {
        add(node.id);
        count++;
        walk(node.children, depth + 1);
      }
    };
    for (const screen of r.screens ?? []) {
      add(screen.id);
      walk(screen.nodes, 1);
    }
    if (count > 600)
      ctx.addIssue({ code: 'custom', message: 'AI output has too many components.' });
  });
export const jobKindSchema = z.enum(JOB_KINDS);
export const revisionSchema = z.number().int().positive();
export const helperVersionSchema = z
  .string()
  .max(64)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const usageSchema = z
  .object({
    inputTokens: tokenCount.optional(),
    cachedInputTokens: tokenCount.optional(),
    cacheWriteInputTokens: tokenCount.optional(),
    outputTokens: tokenCount.optional(),
    reasoningOutputTokens: tokenCount.optional(),
  })
  .strict()
  .refine(
    (usage) => Object.values(usage).some((value) => value !== undefined),
    'Send a token count.',
  );
export const telemetrySchema = z
  .object({ stage: z.enum(JOB_PROGRESS_STAGES).optional(), usage: usageSchema.optional() })
  .strict()
  .refine(
    (telemetry) => telemetry.stage !== undefined || telemetry.usage !== undefined,
    'Send a progress stage or token usage.',
  );

/** Limit nesting before recursive schema traversal, including malicious raw JSON. */
export function boundedJsonDepth(value: unknown, depth = 0): boolean {
  if (depth > 35) return false;
  if (value && typeof value === 'object')
    return Object.values(value).every((v) => boundedJsonDepth(v, depth + 1));
  return true;
}
