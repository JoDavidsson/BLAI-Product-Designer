import { strToU8, zipSync } from 'fflate';
import {
  PLAN_FIELDS,
  type Annotation,
  type BoardAsset,
  type DesignTokens,
  type Project,
  type Screen,
  type WireNode,
} from '../shared/model';
import { AppError } from './types';

export type ExportFiles = Record<string, Uint8Array>;
export interface ExportBucket {
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    size: number;
    customMetadata?: Record<string, string>;
    httpMetadata?: { contentType?: string };
  } | null>;
}
export interface AssetManifest {
  id: string;
  title: string;
  sourceUrl: string;
  originalImageUrl: string;
  status: 'bundled' | 'reference';
  path?: string;
  reason?: string;
}
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const CONTAINERS = new Set(['section', 'row', 'column', 'card']);
const PACKAGE_PATH =
  /^(?:spec\.md|project\.json|requirements\.json|manifest\.json|screens\/[a-z0-9-]+\.svg|assets\/[a-z0-9-]+\.(?:png|jpg|gif|webp))$/;

function xml(value: unknown): string {
  return String(value)
    .replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
function color(value: string | undefined, fallback: string): string {
  return value &&
    /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|transparent|white|black)$/i.test(value)
    ? value
    : fallback;
}
function bounded(value: number | undefined, fallback: number, min = 0, max = 96): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'untitled'
  );
}
function json(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}
function noteLocation(comment: Annotation): string {
  const t = comment.target;
  return [
    t.kind,
    t.screenId && `screen ${t.screenId}`,
    t.nodeId && `node ${t.nodeId}`,
    t.assetId && `asset ${t.assetId}`,
    `(${t.x}, ${t.y})`,
  ]
    .filter(Boolean)
    .join(' · ');
}
function markdownComments(comments: Annotation[]): string {
  if (!comments.length) return '_None._';
  return comments
    .map(
      (c) =>
        `### ${c.id}\n\nTarget: ${noteLocation(c)}${c.previousLocation ? `\n\nPrevious location: ${c.previousLocation}` : ''}${c.requirementId ? `\n\nRequirement: ${c.requirementId}` : ''}\n\n${c.body}${c.replies.map((r) => `\n\nReply (${r.createdAt}): ${r.body}`).join('')}`,
    )
    .join('\n\n');
}
function nodeOutline(nodes: WireNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${'  '.repeat(depth)}- **${node.type}** (${node.id}): ${node.name}${node.text ? ` — ${node.text.replace(/\n/g, ' ')}` : ''}${node.action ? ` → screen ${node.action.screenId}` : ''}`,
    ...nodeOutline(node.children, depth + 1),
  ]);
}

export function productSpecMarkdown(project: Project, assets: AssetManifest[]): string {
  const accepted = project.requirements.filter((r) => r.status === 'accepted');
  const proposed = project.requirements.filter((r) => r.status === 'proposed');
  const requirementList = (items: typeof accepted) =>
    items.length
      ? items
          .map(
            (r) =>
              `- **${r.id}**${r.screenId ? ` (screen ${r.screenId})` : ''}: ${r.text}${r.sourceCommentId ? ` [source comment: ${r.sourceCommentId}]` : ''}`,
          )
          .join('\n')
      : '_None._';
  return [
    `# ${project.title}`,
    project.summary || '_No summary provided._',
    `Project: ${project.id} · Revision: ${project.revision} · Platform: ${project.platform} · Updated: ${project.updatedAt}`,
    '## How to use this handoff',
    'The product plan and accepted requirements express the current product intent. Proposed requirements, open comments, and open questions are unresolved: do not silently treat them as approved behavior. Resolved comments retain discussion history. The structured project is the source of stable screen, node, asset, and comment IDs. SVGs are illustrative layout renderings; preserve the behavior and relationships in project.json. Ask for a decision when instructions conflict.',
    ...PLAN_FIELDS.flatMap(([key, label]) => [
      `## ${label}`,
      project.plan[key].trim() || '_Not specified._',
    ]),
    '## Accepted requirements',
    requirementList(accepted),
    '## Proposed requirements — awaiting decision',
    requirementList(proposed),
    '## Screens and interactions',
    project.screens.length
      ? project.screens
          .map(
            (s) =>
              `### ${s.name} (${s.id})\n\n${s.platform} · ${s.state}\n\n${s.description || '_No description._'}\n\n${nodeOutline(s.nodes).join('\n') || '_No components._'}`,
          )
          .join('\n\n')
      : '_No screens yet._',
    '## Design tokens',
    `\`\`\`json\n${JSON.stringify(project.design, null, 2)}\n\`\`\``,
    '## Moodboard and review references',
    assets.length
      ? assets
          .map((a) => {
            const asset = project.assets.find((item) => item.id === a.id)!;
            return `### ${a.title} (${a.id})\n\nKind: ${asset.kind}\n\n${asset.note || '_No note._'}\n\n${a.path ? `Bundled file: ${a.path}` : `Reference: ${a.originalImageUrl || a.sourceUrl || 'No image'}\n\n${a.reason}`}${a.sourceUrl ? `\n\nSource: ${a.sourceUrl}` : ''}`;
          })
          .join('\n\n')
      : '_No visual references._',
    '## Accepted annotations',
    markdownComments(project.comments.filter((c) => c.status === 'accepted')),
    '## Open annotations — awaiting decision',
    markdownComments(project.comments.filter((c) => c.status === 'open')),
    '## Resolved annotations — discussion history',
    markdownComments(project.comments.filter((c) => c.status === 'resolved')),
    '## Package contents',
    '- `project.json`: complete editable project, including layout, stable IDs, comments, and conversation.\n- `requirements.json`: accepted/proposed requirements, annotation status groups, and open questions.\n- `screens/`: deterministic SVG layouts, including anchored annotation markers.\n- `assets/`: original uploaded raster image bytes when present.\n- `manifest.json`: asset mapping, source references, byte sizes, and SHA-256 checksums. Remote references are never fetched by export.',
    '',
  ].join('\n\n');
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Layout extends Box {
  node: WireNode;
  children: Layout[];
  lines: string[];
  fontSize: number;
  lineHeight: number;
  padding: number;
  paddingY: number;
}

function wrapText(text: string, width: number, fontSize: number): string[] {
  const capacity = Math.max(1, Math.floor(width / (fontSize * 0.56)));
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > capacity) {
        result.push(line);
        line = '';
      }
      while (word.length > capacity) {
        if (line) {
          result.push(line);
          line = '';
        }
        result.push(word.slice(0, capacity));
        word = word.slice(capacity);
      }
      line = line ? `${line} ${word}` : word;
    }
    result.push(line);
  }
  return result;
}
function layoutNode(
  node: WireNode,
  x: number,
  y: number,
  width: number,
  mobile = false,
  inCard = false,
  depth = 0,
): Layout {
  if (depth > 12)
    throw new AppError(
      422,
      'EXPORT_LAYOUT_DEPTH',
      'A screen is nested too deeply to export. Use at most 12 component levels.',
    );
  const container = CONTAINERS.has(node.type);
  const defaultFont =
    node.type === 'heading'
      ? inCard
        ? 20
        : mobile
          ? 27
          : 36
      : node.type === 'badge'
        ? 9
        : ['button', 'input', 'nav'].includes(node.type) || inCard
          ? 12
          : 14;
  const fontSize = bounded(node.style.fontSize, defaultFont, 8, 64);
  const lineHeight = fontSize * (node.type === 'heading' ? 1.2 : node.type === 'text' ? 1.8 : 1.45);
  const defaultPaddingX =
    node.type === 'card'
      ? 24
      : node.type === 'button'
        ? 19
        : node.type === 'input'
          ? 15
          : node.type === 'nav'
            ? 32
            : node.type === 'badge'
              ? 9
              : node.type === 'section' && mobile
                ? 6
                : 0;
  const defaultPaddingY =
    node.type === 'section'
      ? mobile
        ? 24
        : 34
      : node.type === 'card'
        ? 24
        : ['button', 'input'].includes(node.type)
          ? 12
          : node.type === 'nav'
            ? 23
            : node.type === 'badge'
              ? 4
              : node.type === 'divider'
                ? 10
                : 0;
  const padding = bounded(
    node.style.padding,
    defaultPaddingX,
    0,
    Math.max(0, Math.min(96, (width - 1) / 2)),
  );
  const paddingY = bounded(node.style.padding, defaultPaddingY);
  const gap = bounded(
    node.style.gap,
    node.type === 'row' || node.type === 'section' ? 20 : node.type === 'card' ? 13 : 16,
  );
  const inner = Math.max(1, width - padding * 2);
  const lines = wrapText(node.text, inner, fontSize);
  const children: Layout[] = [];
  let height = paddingY * 2;
  if (container && node.children.length) {
    if (node.type === 'row' && !mobile) {
      const effectiveGap = Math.min(gap, inner / (node.children.length * 2));
      const childWidth = Math.max(
        1,
        (inner - effectiveGap * (node.children.length - 1)) / node.children.length,
      );
      node.children.forEach((child, index) =>
        children.push(
          layoutNode(
            child,
            x + padding + index * (childWidth + effectiveGap),
            y + paddingY,
            childWidth,
            mobile,
            inCard || node.type === 'card',
            depth + 1,
          ),
        ),
      );
      height += Math.max(...children.map((child) => child.height));
    } else {
      let nextY = y + paddingY;
      for (const child of node.children) {
        const layout = layoutNode(
          child,
          x + padding,
          nextY,
          inner,
          mobile,
          inCard || node.type === 'card',
          depth + 1,
        );
        children.push(layout);
        nextY += layout.height + gap;
      }
      height += nextY - y - paddingY - gap;
    }
  } else if (node.type === 'image') height += 170;
  else if (node.type === 'divider') height += 1;
  else height += Math.max(lineHeight, lines.length * lineHeight);
  return {
    node,
    x,
    y,
    width,
    height: Math.max(node.type === 'button' ? 42 : node.type === 'input' ? 44 : 1, height),
    children,
    lines,
    fontSize,
    lineHeight,
    padding,
    paddingY,
  };
}
function number(value: number): string {
  return String(Math.round(value * 100) / 100);
}
function rectangle(box: Box, fill: string, radius = 0, stroke?: string): string {
  return `<rect x="${number(box.x)}" y="${number(box.y)}" width="${number(box.width)}" height="${number(box.height)}" rx="${number(radius)}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`;
}
function drawNode(layout: Layout, design: DesignTokens, bounds: Map<string, Box>): string {
  const { node, x, y, width, height, padding, paddingY, fontSize, lineHeight, lines } = layout;
  bounds.set(node.id, layout);
  const bg = color(
    node.style.background,
    node.type === 'button'
      ? color(design.accent, '#7360df')
      : ['card', 'input', 'nav'].includes(node.type)
        ? color(design.surface, '#ffffff')
        : node.type === 'badge' || node.type === 'image'
          ? '#eceaf2'
          : 'transparent',
  );
  const fg = color(
    node.style.color,
    node.type === 'button'
      ? '#ffffff'
      : node.type === 'input'
        ? color(design.muted, '#7b8190')
        : color(design.text, '#232833'),
  );
  const radius = bounded(node.style.radius, bounded(design.radius, 12));
  let content = rectangle(
    layout,
    bg,
    radius,
    ['input', 'card'].includes(node.type) ? '#dedde5' : undefined,
  );
  if (layout.children.length)
    content += layout.children.map((child) => drawNode(child, design, bounds)).join('');
  else if (node.type === 'divider')
    content += `<path d="M ${number(x)} ${number(y + height / 2)} H ${number(x + width)}" stroke="#dedde5"/>`;
  else {
    const center =
      node.style.align === 'center' ||
      (node.style.align === undefined && ['button', 'badge', 'image'].includes(node.type));
    const end = node.style.align === 'end';
    const textX = center ? x + width / 2 : end ? x + width - padding : x + padding;
    const textY = node.type === 'image' ? y + height / 2 : y + paddingY + fontSize;
    const visibleLines = node.type === 'image' ? lines.slice(0, 3) : lines;
    content += `<text fill="${fg}" font-size="${number(fontSize)}"${node.type === 'heading' ? ' font-weight="700"' : ''} text-anchor="${center ? 'middle' : end ? 'end' : 'start'}">${visibleLines.map((line, i) => `<tspan x="${number(textX)}" y="${number(textY + i * lineHeight)}">${xml(line)}</tspan>`).join('')}</text>`;
  }
  return `<g data-node-id="${xml(node.id)}" data-node-type="${xml(node.type)}"><title>${xml(node.name)}${node.action ? ` — navigates to ${xml(node.action.screenId)}` : ''}</title>${content}</g>`;
}

/** SVG uses only fixed elements and escaped strings. Images remain placeholders; originals live in assets/. */
export function renderScreenSvg(
  screen: Screen,
  design: DesignTokens,
  comments: Annotation[] = [],
): string {
  const mobile = screen.platform === 'mobile';
  const width = mobile ? 375 : 900;
  const padding = mobile ? 20 : 32;
  const layouts: Layout[] = [];
  let y = padding;
  for (const node of screen.nodes) {
    const layout = layoutNode(node, padding, y, width - padding * 2, mobile);
    layouts.push(layout);
    y += layout.height + 20;
  }
  const screenHeight = Math.max(mobile ? 780 : 640, y + padding - 20);
  const bounds = new Map<string, Box>();
  const contents = layouts.map((layout) => drawNode(layout, design, bounds)).join('');
  const annotations = comments.filter(
    (c) =>
      c.target.screenId === screen.id && (c.target.kind === 'screen' || c.target.kind === 'node'),
  );
  const height = Math.max(screenHeight, annotations.length * 88 + 40);
  const svgWidth = width + (annotations.length ? 300 : 0);
  const callouts = annotations
    .map((comment, index) => {
      const target = comment.target.nodeId
        ? bounds.get(comment.target.nodeId)
        : { x: 0, y: 0, width, height: screenHeight };
      if (!target) return '';
      const targetX = target.x + bounded(comment.target.x, 0.5, 0, 1) * target.width;
      const targetY = target.y + bounded(comment.target.y, 0.5, 0, 1) * target.height;
      const labelY = 30 + index * 88;
      return `<g data-comment-id="${xml(comment.id)}"><title>${xml(comment.body)}</title><path d="M ${number(targetX)} ${number(targetY)} L ${width + 20} ${labelY}" stroke="#7360df" stroke-dasharray="3 5" fill="none"/><circle cx="${number(targetX)}" cy="${number(targetY)}" r="10" fill="#7360df"/><text x="${number(targetX)}" y="${number(targetY + 4)}" text-anchor="middle" fill="#ffffff" font-size="11">${index + 1}</text><text x="${width + 25}" y="${labelY}" fill="#232833" font-size="12"><tspan font-weight="700">${index + 1}. ${xml(comment.status)}</tspan>${wrapText(
        comment.body,
        250,
        12,
      )
        .slice(0, 3)
        .map((line, i) => `<tspan x="${width + 25}" dy="${i === 0 ? 20 : 16}">${xml(line)}</tspan>`)
        .join('')}</text></g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${number(height)}" viewBox="0 0 ${svgWidth} ${number(height)}" role="img" font-family="${design.font === 'serif' ? 'Georgia, serif' : 'Arial, sans-serif'}"><title>${xml(screen.name)}</title><desc>${xml(screen.description)} · ${xml(screen.state)}</desc>${rectangle({ x: 0, y: 0, width: svgWidth, height }, '#ffffff')}${rectangle({ x: 0, y: 0, width, height: screenHeight }, color(design.background, '#f7f6f2'))}${contents}${callouts}</svg>\n`;
}

function localAssetKey(asset: BoardAsset): string | undefined {
  const match = /^\/api\/assets\/([a-zA-Z0-9_-]{1,200})$/.exec(asset.imageUrl);
  return match?.[1];
}
async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildProjectExport(
  project: Project,
  options: { bucket: ExportBucket; owner: string },
): Promise<{ files: ExportFiles; zip: Uint8Array }> {
  const files: ExportFiles = {};
  const assets: AssetManifest[] = [];
  let bytes = 0;
  const add = (path: string, data: Uint8Array) => {
    bytes += data.byteLength;
    if (bytes > MAX_PACKAGE_BYTES)
      throw new AppError(
        413,
        'EXPORT_TOO_LARGE',
        'The handoff exceeds 32 MB. Remove large references or export a smaller project.',
      );
    files[path] = data;
  };
  add('project.json', json(project));
  add(
    'requirements.json',
    json({
      projectId: project.id,
      revision: project.revision,
      accepted: project.requirements.filter((r) => r.status === 'accepted'),
      proposed: project.requirements.filter((r) => r.status === 'proposed'),
      annotations: {
        accepted: project.comments.filter((c) => c.status === 'accepted'),
        open: project.comments.filter((c) => c.status === 'open'),
        resolved: project.comments.filter((c) => c.status === 'resolved'),
      },
      openQuestions: project.plan.questions,
    }),
  );
  for (let index = 0; index < project.assets.length; index++) {
    const asset = project.assets[index];
    const entry: AssetManifest = {
      id: asset.id,
      title: asset.title,
      sourceUrl: asset.sourceUrl,
      originalImageUrl: asset.imageUrl,
      status: 'reference',
    };
    const key = localAssetKey(asset);
    if (key) {
      const object = await options.bucket.get(key);
      if (
        !object ||
        object.customMetadata?.owner !== options.owner ||
        object.customMetadata?.projectId !== project.id
      ) {
        throw new AppError(
          422,
          'EXPORT_ASSET_UNAVAILABLE',
          `The uploaded image “${asset.title}” is unavailable for this project. Remove it or upload it again before export.`,
        );
      }
      const extension = IMAGE_EXTENSIONS[object.httpMetadata?.contentType || ''];
      if (!extension)
        throw new AppError(
          422,
          'EXPORT_ASSET_FORMAT',
          `The image “${asset.title}” has an unsupported format. Upload a PNG, JPEG, GIF, or WebP image.`,
        );
      if (object.size > MAX_ASSET_BYTES || bytes + object.size > MAX_PACKAGE_BYTES)
        throw new AppError(
          413,
          'EXPORT_TOO_LARGE',
          'The handoff image data exceeds the export size limit (10 MB per image, 32 MB per package).',
        );
      const data = new Uint8Array(await object.arrayBuffer());
      if (data.byteLength > MAX_ASSET_BYTES)
        throw new AppError(
          413,
          'EXPORT_TOO_LARGE',
          `The image “${asset.title}” exceeds the 10 MB export limit.`,
        );
      entry.path = `assets/${String(index + 1).padStart(3, '0')}-${slug(asset.title)}.${extension}`;
      entry.status = 'bundled';
      add(entry.path, data);
    } else
      entry.reason = asset.imageUrl.startsWith('/sample/')
        ? 'Built-in sample illustration; source reference retained. Upload your own image to bundle original image bytes.'
        : 'External or webpage reference; export preserves the URL and never fetches remote content. Upload the image to bundle its bytes.';
    assets.push(entry);
  }
  project.screens.forEach((screen, index) =>
    add(
      `screens/${String(index + 1).padStart(2, '0')}-${slug(screen.name)}.svg`,
      strToU8(renderScreenSvg(screen, project.design, project.comments)),
    ),
  );
  add('spec.md', strToU8(productSpecMarkdown(project, assets)));
  const checksums = await Promise.all(
    Object.entries(files).map(async ([path, data]) => ({
      path,
      bytes: data.byteLength,
      sha256: await sha256(data),
    })),
  );
  add(
    'manifest.json',
    json({
      format: 'blai-product-handoff',
      version: 1,
      projectId: project.id,
      revision: project.revision,
      updatedAt: project.updatedAt,
      assets,
      files: checksums,
      notes: [
        'Checksums cover every file except manifest.json itself.',
        'SVGs render supported component layouts; image nodes use labeled placeholders. Original raster assets are bundled separately.',
        'Open comments and proposed requirements remain unresolved.',
      ],
    }),
  );
  // Fixed ZIP timestamps make the same project and assets produce reproducible archives.
  const archive: Record<string, [Uint8Array, { mtime: Date; level: 0 | 6 }]> = {};
  for (const [path, data] of Object.entries(files))
    archive[path] = [
      data,
      { mtime: new Date('2000-01-01T00:00:00Z'), level: path.startsWith('assets/') ? 0 : 6 },
    ];
  return { files, zip: zipSync(archive) };
}

export interface GithubExportOptions {
  token: string;
  repository: string;
  branch: string;
  path: string;
  fetch?: typeof globalThis.fetch;
}

export function validateGithubDestination(
  repository: string,
  branch: string,
  path: string,
): { repository: string; branch: string; path: string } {
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/.test(repository) ||
    repository.split('/')[1].startsWith('.')
  ) {
    throw new AppError(
      400,
      'INVALID_REPOSITORY',
      'Use a GitHub repository in owner/repository form.',
    );
  }
  if (
    !branch ||
    branch.length > 240 ||
    /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch === '@' ||
    branch.startsWith('-') ||
    branch.endsWith('.') ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw new AppError(
      400,
      'INVALID_BRANCH',
      'Enter an existing Git branch name, such as main or design/product-spec.',
    );
  }
  const normalized = path.replace(/\/$/, '');
  if (
    !normalized ||
    normalized.length > 240 ||
    !/^[a-zA-Z0-9_.\/-]+$/.test(normalized) ||
    normalized
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git' ||
          part.toLowerCase() === '.github',
      )
  ) {
    throw new AppError(
      400,
      'INVALID_EXPORT_PATH',
      'Choose a handoff folder such as docs/product-spec. Root, traversal, .git, and .github paths are not allowed.',
    );
  }
  return { repository, branch, path: normalized };
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** All content lands in one commit. A racing branch update fails instead of overwriting another commit. */
export async function publishGithubExport(
  files: ExportFiles,
  options: GithubExportOptions,
): Promise<{ url: string; commit: string }> {
  if (!options.token?.trim())
    throw new AppError(
      503,
      'GITHUB_NOT_CONFIGURED',
      'GitHub export needs a server-side GITHUB_TOKEN with Contents write access to the chosen repository. Configure it in Worker secrets, or download the ZIP.',
    );
  const destination = validateGithubDestination(options.repository, options.branch, options.path);
  const entries = Object.entries(files);
  if (!entries.length)
    throw new AppError(400, 'EMPTY_EXPORT', 'There are no handoff files to export.');
  if (
    entries.length > 200 ||
    entries.reduce((total, [, data]) => total + data.byteLength, 0) > MAX_PACKAGE_BYTES
  )
    throw new AppError(
      413,
      'GITHUB_EXPORT_TOO_LARGE',
      'This handoff is too large for one GitHub export (200 files or 32 MB). Download the ZIP or reduce the project size.',
    );
  for (const [path] of entries) {
    if (!PACKAGE_PATH.test(path))
      throw new AppError(
        400,
        'INVALID_EXPORT_FILE',
        'The package contains an unexpected file path. Rebuild the handoff before exporting.',
      );
  }
  const request = options.fetch || globalThis.fetch;
  const api = `https://api.github.com/repos/${destination.repository}`;
  async function github<T>(path: string, method?: string, body?: unknown): Promise<T>;
  async function github<T>(
    path: string,
    method: string,
    body: unknown,
    missingAllowed: true,
  ): Promise<T | null>;
  async function github<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    missingAllowed = false,
  ): Promise<T | null> {
    let response: Response;
    try {
      response = await request(`${api}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'BLAI-Product-Designer',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppError(
        502,
        'GITHUB_UNREACHABLE',
        'GitHub could not be reached. Check the connection and try again. No branch update has been confirmed.',
      );
    }
    if (!response.ok) {
      // Never reflect an upstream body: it may echo credentials or private content.
      if (response.status === 404 && missingAllowed) return null;
      if (response.status === 401 || response.status === 403)
        throw new AppError(
          502,
          'GITHUB_PERMISSION',
          'GitHub rejected this request. Check token expiry, repository Contents write permission, branch protections, and API rate limits.',
        );
      if (response.status === 404)
        throw new AppError(
          422,
          'GITHUB_NOT_FOUND',
          'The repository or branch was not found or is not accessible to the configured token. Initialize the repository and create the target branch first.',
        );
      if (response.status === 409 || response.status === 422)
        throw new AppError(
          409,
          'GITHUB_CONFLICT',
          'GitHub could not update the branch. It may have changed during export, be empty, or have protection rules. Refresh the repository and retry; no force update was attempted.',
        );
      throw new AppError(
        502,
        'GITHUB_API_ERROR',
        `GitHub returned HTTP ${response.status}. Retry the export after checking GitHub availability.`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new AppError(
        502,
        'GITHUB_INVALID_RESPONSE',
        'GitHub returned an unexpected response. Check the target branch before retrying.',
      );
    }
  }
  const refPath = destination.branch.split('/').map(encodeURIComponent).join('/');
  const ref = await github<{ object: { sha: string } }>(`/git/ref/heads/${refPath}`);
  const validSha = (sha: unknown): sha is string =>
    typeof sha === 'string' && /^[a-f0-9]{40,64}$/i.test(sha);
  if (!validSha(ref?.object?.sha))
    throw new AppError(
      502,
      'GITHUB_INVALID_RESPONSE',
      'GitHub did not return a valid branch commit.',
    );
  const parent = await github<{ tree: { sha: string } }>(`/git/commits/${ref.object.sha}`);
  if (!validSha(parent?.tree?.sha))
    throw new AppError(
      502,
      'GITHUB_INVALID_RESPONSE',
      'GitHub did not return a valid repository tree.',
    );
  const treeEntries: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
  if (files['manifest.json']) {
    let current: { format?: string; projectId?: string };
    try {
      current = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    } catch {
      throw new AppError(
        400,
        'INVALID_EXPORT_MANIFEST',
        'The handoff manifest is invalid. Rebuild the handoff before publishing.',
      );
    }
    if (
      !current ||
      current.format !== 'blai-product-handoff' ||
      typeof current.projectId !== 'string'
    )
      throw new AppError(
        400,
        'INVALID_EXPORT_MANIFEST',
        'The handoff manifest is invalid. Rebuild the handoff before publishing.',
      );
    const previousFile = await github<{ encoding?: string; content?: string; size?: number }>(
      `/contents/${destination.path}/manifest.json?ref=${ref.object.sha}`,
      'GET',
      undefined,
      true,
    );
    if (previousFile) {
      let previous: { format?: string; projectId?: string; files?: { path?: string }[] };
      try {
        if (
          previousFile.encoding !== 'base64' ||
          !previousFile.content ||
          (previousFile.size || 0) > 1024 * 1024 ||
          previousFile.content.length > 1500000
        )
          throw new Error('Unsupported manifest response');
        const binary = atob(previousFile.content.replace(/\s/g, ''));
        previous = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))),
        );
        if (
          previous.format !== 'blai-product-handoff' ||
          !Array.isArray(previous.files) ||
          previous.files.length > 200 ||
          previous.files.some((file) => !file || typeof file.path !== 'string')
        )
          throw new Error('Unsupported manifest');
      } catch {
        throw new AppError(
          409,
          'GITHUB_DESTINATION_CONFLICT',
          'The destination already contains an unrecognized manifest. Choose a dedicated, empty handoff folder.',
        );
      }
      if (previous.projectId !== current.projectId)
        throw new AppError(
          409,
          'GITHUB_DESTINATION_CONFLICT',
          'This folder contains a handoff for another project. Choose a separate folder for this project.',
        );
      // Remove only paths explicitly owned by this project's previous package, never arbitrary repository files.
      for (const path of new Set(previous.files!.map((file) => file.path))) {
        if (typeof path === 'string' && PACKAGE_PATH.test(path) && !(path in files))
          treeEntries.push({
            path: `${destination.path}/${path}`,
            mode: '100644',
            type: 'blob',
            sha: null,
          });
      }
    }
  }
  // Small bounded batches avoid exhausting Worker simultaneous connection limits.
  for (let index = 0; index < entries.length; index += 4) {
    const chunk = await Promise.all(
      entries.slice(index, index + 4).map(async ([path, bytes]) => {
        const blob = await github<{ sha: string }>('/git/blobs', 'POST', {
          content: base64(bytes),
          encoding: 'base64',
        });
        if (!validSha(blob?.sha))
          throw new AppError(
            502,
            'GITHUB_INVALID_RESPONSE',
            'GitHub did not accept a handoff file.',
          );
        return {
          path: `${destination.path}/${path}`,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blob.sha,
        };
      }),
    );
    treeEntries.push(...chunk);
  }
  const tree = await github<{ sha: string }>('/git/trees', 'POST', {
    base_tree: parent.tree.sha,
    tree: treeEntries,
  });
  if (!validSha(tree?.sha))
    throw new AppError(
      502,
      'GITHUB_INVALID_RESPONSE',
      'GitHub did not return a valid handoff tree.',
    );
  const commit = await github<{ sha: string }>('/git/commits', 'POST', {
    message: `Update product handoff in ${destination.path}`,
    tree: tree.sha,
    parents: [ref.object.sha],
  });
  if (!validSha(commit?.sha))
    throw new AppError(
      502,
      'GITHUB_INVALID_RESPONSE',
      'GitHub did not return a valid handoff commit.',
    );
  await github(`/git/refs/heads/${refPath}`, 'PATCH', { sha: commit.sha, force: false });
  return {
    commit: commit.sha,
    url: `https://github.com/${destination.repository}/tree/${commit.sha}/${destination.path.split('/').map(encodeURIComponent).join('/')}`,
  };
}
