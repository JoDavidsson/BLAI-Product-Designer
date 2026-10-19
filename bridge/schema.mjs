/** Self-contained structured output contract for the subscription-only helper. */
export const PROTOCOL_VERSION = 1;
export const DESIGNER_HELPER_VERSION = '1.1.0';
export const CANVAS_CAPABILITY = 'canvas.v1';
export const PROGRESS_STAGES = Object.freeze([
  'launching',
  'model-started',
  'response-received',
  'validating',
]);
export const USAGE_FIELDS = Object.freeze([
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
]);

/** Telemetry is a small closed vocabulary, never model text or diagnostics. */
export function validateTelemetry(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).some((key) => !['stage', 'usage'].includes(key)) ||
    (Object.hasOwn(value, 'stage') && !PROGRESS_STAGES.includes(value.stage))
  )
    throw new Error('protocol');
  const result = {};
  if (value.stage !== undefined) result.stage = value.stage;
  if (Object.hasOwn(value, 'usage')) {
    if (
      !value.usage ||
      typeof value.usage !== 'object' ||
      Array.isArray(value.usage) ||
      Object.keys(value.usage).length === 0 ||
      Object.entries(value.usage).some(
        ([key, count]) => !USAGE_FIELDS.includes(key) || !Number.isSafeInteger(count) || count < 0,
      )
    )
      throw new Error('protocol');
    result.usage = { ...value.usage };
  }
  return result;
}

/** Copy only counts actually reported by Codex's turn.completed event. */
export function usageFromCodex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = {};
  for (const [source, target] of [
    ['input_tokens', 'inputTokens'],
    ['cached_input_tokens', 'cachedInputTokens'],
    ['cache_write_input_tokens', 'cacheWriteInputTokens'],
    ['output_tokens', 'outputTokens'],
    ['reasoning_output_tokens', 'reasoningOutputTokens'],
  ]) {
    const count = value[source];
    if (Number.isSafeInteger(count) && count >= 0) usage[target] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}
export const CAPABILITIES = Object.freeze([
  'plan.assist',
  'plan.review',
  'wireframe.generate',
  'wireframe.refine',
  'moodboard.direction',
]);
export const PLAN_KEYS = [
  'problem',
  'audience',
  'value',
  'goals',
  'scope',
  'outOfScope',
  'journeys',
  'dataRules',
  'integrations',
  'acceptance',
  'questions',
];
const string = (maxLength, minLength = 0) => ({ type: 'string', minLength, maxLength });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const id = { ...string(100, 1), pattern: '^[a-zA-Z0-9_-]+$' };
const color = { type: 'string', pattern: '^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})$' };
export const legacyOutputSchema = {
  ...object({
    title: string(200, 1),
    summary: string(4000),
    reply: string(16000),
    plan: nullable(
      object(Object.fromEntries(PLAN_KEYS.map((key) => [key, nullable(string(24000))]))),
    ),
    screens: nullable(array({ $ref: '#/$defs/screen' }, 12)),
    design: nullable(
      object({
        accent: color,
        background: color,
        surface: color,
        text: color,
        muted: color,
        radius: number(0, 64),
        font: { enum: ['sans', 'serif'] },
      }),
    ),
    requirements: array(object({ text: string(8000, 1), screenId: nullable(id) }), 100),
  }),
  $defs: {
    screen: object({
      id,
      name: string(160, 1),
      platform: { enum: ['desktop', 'mobile'] },
      description: string(4000),
      state: { enum: ['default', 'loading', 'empty', 'error', 'success'] },
      nodes: array({ $ref: '#/$defs/node' }, 100),
    }),
    node: object({
      id,
      type: {
        enum: [
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
        ],
      },
      name: string(160, 1),
      text: string(4000),
      children: array({ $ref: '#/$defs/node' }, 100),
      style: object({
        background: nullable(color),
        color: nullable(color),
        fontSize: nullable(number(8, 96)),
        padding: nullable(number(0, 100)),
        gap: nullable(number(0, 100)),
        radius: nullable(number(0, 64)),
        align: nullable({ enum: ['start', 'center', 'end'] }),
      }),
      action: nullable(object({ screenId: id })),
    }),
  },
};

export const outputSchema = structuredClone(legacyOutputSchema);
Object.assign(outputSchema.$defs.screen.properties, {
  canvas: nullable(object({ width: number(100, 10000), height: number(100, 10000) })),
});
outputSchema.$defs.screen.required.push('canvas');
outputSchema.$defs.node.properties.type.enum.push('group', 'rectangle', 'ellipse', 'line', 'path');
Object.assign(outputSchema.$defs.node.properties, {
  frame: nullable(
    object({
      x: number(-20000, 20000),
      y: number(-20000, 20000),
      width: number(1, 20000),
      height: number(1, 20000),
      rotation: number(-360, 360),
    }),
  ),
  layout: nullable({ type: 'string', enum: ['free', 'row', 'column'] }),
  image: nullable(object({ assetId: id, fit: { type: 'string', enum: ['cover', 'contain'] } })),
  points: nullable({ ...array(object({ x: number(0, 1), y: number(0, 1) }), 256), minItems: 2 }),
  locked: nullable({ type: 'boolean' }),
  hidden: nullable({ type: 'boolean' }),
});
outputSchema.$defs.node.required.push('frame', 'layout', 'image', 'points', 'locked', 'hidden');
Object.assign(outputSchema.$defs.node.properties.style.properties, {
  stroke: nullable(color),
  strokeWidth: nullable(number(0, 32)),
  opacity: nullable(number(0, 1)),
  fontWeight: nullable({ type: 'number', enum: [400, 500, 600, 700] }),
});
outputSchema.$defs.node.properties.style.required.push(
  'stroke',
  'strokeWidth',
  'opacity',
  'fontWeight',
);

export function jobNeedsCanvas(job) {
  return (job?.context?.screens ?? []).some(
    (screen) =>
      screen.canvas !== undefined &&
      (job.kind === 'wireframe.generate' ||
        (job.kind === 'wireframe.refine' && screen.id === job.screenId)),
  );
}

/** Validate only our closed JSON Schema vocabulary; never execute model data. */
function conforms(value, schema, depth = 0, root = outputSchema) {
  if (depth > 60) return false;
  if (schema.$ref)
    return conforms(value, root.$defs[schema.$ref.split('/').at(-1)], depth + 1, root);
  if (schema.anyOf) return schema.anyOf.some((item) => conforms(value, item, depth + 1, root));
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === 'null') return value === null;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'string')
    return (
      typeof value === 'string' &&
      value.length >= (schema.minLength ?? 0) &&
      value.length <= (schema.maxLength ?? Infinity) &&
      (!schema.pattern || new RegExp(schema.pattern).test(value))
    );
  if (schema.type === 'number')
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= schema.minimum &&
      value <= schema.maximum
    );
  if (schema.type === 'array')
    return (
      Array.isArray(value) &&
      value.length >= (schema.minItems ?? 0) &&
      value.length <= schema.maxItems &&
      value.every((item) => conforms(item, schema.items, depth + 1, root))
    );
  if (schema.type === 'object')
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === schema.required.length &&
      schema.required.every(
        (key) =>
          Object.hasOwn(value, key) &&
          conforms(value[key], schema.properties[key], depth + 1, root),
      )
    );
  return false;
}

export function validateResult(value, job, { canvas } = {}) {
  if (Buffer.byteLength(JSON.stringify(value)) > 600_000) throw new Error('invalid');
  const result = structuredClone(value);
  // Old helpers and already queued flow jobs remain readable. Only known additive
  // fields get defaults; unknown fields and malformed existing values still fail.
  if (canvas !== false) {
    function addDefaults(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 10) return;
      for (const key of ['frame', 'layout', 'image', 'points', 'locked', 'hidden'])
        if (!Object.hasOwn(node, key)) node[key] = null;
      if (node.style && typeof node.style === 'object')
        for (const key of ['stroke', 'strokeWidth', 'opacity', 'fontWeight'])
          if (!Object.hasOwn(node.style, key)) node.style[key] = null;
      if (Array.isArray(node.children))
        node.children.forEach((child) => addDefaults(child, depth + 1));
    }
    if (Array.isArray(result?.screens))
      for (const screen of result.screens) {
        if (!screen || typeof screen !== 'object') continue;
        if (!Object.hasOwn(screen, 'canvas')) screen.canvas = null;
        if (Array.isArray(screen.nodes)) screen.nodes.forEach((node) => addDefaults(node));
      }
  }
  const schema = canvas === false ? legacyOutputSchema : outputSchema;
  if (!conforms(result, schema, 0, schema)) throw new Error('invalid');
  if (canvas === false && jobNeedsCanvas(job)) throw new Error('invalid');
  if (result.plan)
    for (const key of PLAN_KEYS) if (result.plan[key] === null) delete result.plan[key];
  const screenIds = new Set();
  // IDs that survive applying the proposal remain reserved. In particular,
  // refining one screen must not steal a component ID from an untouched screen.
  const reserved = new Set();
  for (const items of ['assets', 'comments', 'requirements', 'chat', 'diagrams'])
    for (const item of job?.context?.[items] ?? []) reserved.add(item.id);
  function reserveNode(node) {
    reserved.add(node.id);
    node.children.forEach(reserveNode);
  }
  if (job?.kind === 'wireframe.refine')
    for (const screen of job.context.screens)
      if (screen.id !== job.screenId) {
        reserved.add(screen.id);
        screen.nodes.forEach(reserveNode);
      }
  for (const screen of result.screens ?? [])
    if (reserved.has(screen.id)) throw new Error('invalid');
  const nodeIds = new Set([...reserved, ...(result.screens ?? []).map((screen) => screen.id)]);
  let nodes = 0;
  const assets = new Set(
    (job?.context?.assets ?? []).filter((asset) => asset.imageUrl).map((asset) => asset.id),
  );
  const containers = ['group', 'section', 'row', 'column', 'card'];
  const shapes = ['group', 'rectangle', 'ellipse', 'line', 'path'];
  function visit(node, depth, freeform) {
    if (depth > 10 || ++nodes > 600 || nodeIds.has(node.id)) throw new Error('invalid');
    nodeIds.add(node.id);
    for (const key of Object.keys(node.style)) if (node.style[key] === null) delete node.style[key];
    if (node.action === null) delete node.action;
    for (const key of ['frame', 'layout', 'image', 'points', 'locked', 'hidden'])
      if (node[key] === null) delete node[key];
    if (freeform && !node.frame) throw new Error('invalid');
    if (
      !freeform &&
      (shapes.includes(node.type) ||
        ['frame', 'layout', 'image', 'points', 'locked', 'hidden'].some((key) =>
          Object.hasOwn(node, key),
        ))
    )
      throw new Error('invalid');
    if (node.layout !== undefined && !containers.includes(node.type)) throw new Error('invalid');
    if (node.image && (node.type !== 'image' || !assets.has(node.image.assetId)))
      throw new Error('invalid');
    if ((node.type === 'path') !== (node.points !== undefined)) throw new Error('invalid');
    node.children.forEach((child) => visit(child, depth + 1, freeform));
  }
  for (const screen of result.screens ?? []) {
    if (screenIds.has(screen.id)) throw new Error('invalid');
    screenIds.add(screen.id);
    if (screen.canvas === null) delete screen.canvas;
    if (
      (canvas === true || jobNeedsCanvas(job)) &&
      job?.kind?.startsWith('wireframe.') &&
      !screen.canvas
    )
      throw new Error('invalid');
    screen.nodes.forEach((node) => visit(node, 1, !!screen.canvas));
  }
  if (job?.kind === 'wireframe.refine') {
    if (!job.screenId || result.screens?.length !== 1 || result.screens[0].id !== job.screenId)
      throw new Error('invalid');
    for (const screen of job.context.screens) screenIds.add(screen.id);
  }
  if (job?.kind === 'wireframe.generate' && !result.screens?.length) throw new Error('invalid');
  if (job && !job.kind.startsWith('wireframe.') && result.screens !== null)
    throw new Error('invalid');
  if (result.screens === null)
    for (const screen of job?.context?.screens ?? []) screenIds.add(screen.id);
  function checkLinks(node) {
    if (node.action && !screenIds.has(node.action.screenId)) throw new Error('invalid');
    node.children.forEach(checkLinks);
  }
  for (const screen of result.screens ?? []) screen.nodes.forEach(checkLinks);
  for (const requirement of result.requirements) {
    if (requirement.screenId === null) delete requirement.screenId;
    if (requirement.screenId && !screenIds.has(requirement.screenId)) throw new Error('invalid');
  }
  return result;
}

export function validateJob(value) {
  const required = [
    'id',
    'projectId',
    'kind',
    'baseRevision',
    'instruction',
    'context',
    'leaseToken',
    'leaseExpiresAt',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => ![...required, 'screenId'].includes(key))
  )
    throw new Error('protocol');
  if (
    !CAPABILITIES.includes(value.kind) ||
    !Number.isInteger(value.baseRevision) ||
    value.baseRevision < 1 ||
    typeof value.instruction !== 'string' ||
    value.instruction.length > 20000
  )
    throw new Error('protocol');
  for (const key of ['id', 'projectId', 'leaseToken'])
    if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value[key]))
      throw new Error('protocol');
  if (
    typeof value.leaseExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.leaseExpiresAt))
  )
    throw new Error('protocol');
  if (
    !value.context ||
    typeof value.context !== 'object' ||
    value.context.id !== value.projectId ||
    !Array.isArray(value.context.screens) ||
    !value.context.plan ||
    typeof value.context.plan !== 'object' ||
    Array.isArray(value.context.plan) ||
    Buffer.byteLength(JSON.stringify(value.context)) > 1_500_000
  )
    throw new Error('protocol');
  if (
    value.screenId !== undefined &&
    (typeof value.screenId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value.screenId))
  )
    throw new Error('protocol');
  if (
    value.kind === 'wireframe.refine' &&
    !value.context.screens.some((screen) => screen.id === value.screenId)
  )
    throw new Error('protocol');
  return value;
}
