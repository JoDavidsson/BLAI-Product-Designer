import { z } from 'zod';
import {
  JOB_KINDS,
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
        })
        .strict(),
      action: z.object({ screenId: idSchema }).strict().optional(),
    })
    .strict(),
);
export const screenSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(160),
    platform: z.enum(['desktop', 'mobile']),
    description: z.string().max(4000),
    state: z.enum(['default', 'loading', 'empty', 'error', 'success']),
    nodes: z.array(nodeSchema).max(100),
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
        visit(n.children, depth + 1);
      }
    }
    for (const screen of p.screens) {
      add(screen.id);
      visit(screen.nodes, 1);
    }
    for (const list of [p.assets, p.comments, p.requirements, p.chat])
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

/** Limit nesting before recursive schema traversal, including malicious raw JSON. */
export function boundedJsonDepth(value: unknown, depth = 0): boolean {
  if (depth > 35) return false;
  if (value && typeof value === 'object')
    return Object.values(value).every((v) => boundedJsonDepth(v, depth + 1));
  return true;
}
