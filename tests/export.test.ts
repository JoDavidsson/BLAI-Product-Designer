import { describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import {
  createNode,
  createProject,
  NODE_TYPES,
  type Annotation,
  type Project,
} from '../shared/model';
import type { buildProductOverview } from '../shared/overview';
import {
  buildProjectExport,
  publishGithubExport,
  renderScreenSvg,
  validateGithubDestination,
  type ExportBucket,
} from '../worker/export';

function projectFixture(): Project {
  const project = createProject('Member studio');
  project.id = 'project_a';
  project.createdAt = project.updatedAt = '2026-10-16T12:00:00.000Z';
  project.plan.problem = 'Members need to manage their workshops.';
  project.plan.questions = 'Does a booking require payment?';
  project.screens = [
    {
      id: 'screen_a',
      name: 'My workshops',
      platform: 'desktop',
      state: 'default',
      description: 'Available workshops and bookings.',
      nodes: [
        {
          ...createNode('row'),
          id: 'row',
          children: [
            {
              ...createNode('card'),
              id: 'card_a',
              children: [
                {
                  ...createNode('button', 'Book workshop'),
                  id: 'button',
                  action: { screenId: 'screen_b' },
                },
              ],
            },
            {
              ...createNode('card'),
              id: 'card_b',
              children: [{ ...createNode('text', 'Choose another workshop.'), id: 'text' }],
            },
          ],
        },
      ],
    },
  ];
  project.requirements = [
    {
      id: 'req_accepted',
      text: 'Save the booking.',
      status: 'accepted',
      sourceCommentId: 'comment_a',
    },
    { id: 'req_proposed', text: 'Maybe accept payments.', status: 'proposed' },
  ];
  const note: Annotation = {
    id: 'comment_a',
    body: 'Save on click.',
    status: 'accepted',
    target: { kind: 'node', screenId: 'screen_a', nodeId: 'button', x: 0.5, y: 0.5 },
    createdAt: project.createdAt,
    replies: [],
    requirementId: 'req_accepted',
  };
  project.comments = [
    note,
    {
      ...note,
      id: 'comment_b',
      status: 'open',
      body: 'Which payment provider?',
      requirementId: undefined,
    },
    {
      ...note,
      id: 'comment_c',
      status: 'resolved',
      body: 'Keep this discussion history.',
      requirementId: undefined,
    },
  ];
  return project;
}
const emptyBucket = (): ExportBucket => ({ get: vi.fn(async () => null) });
const uploadedImage = {
  id: 'asset_a',
  title: 'Workshop photo',
  kind: 'reference' as const,
  imageUrl: '/api/assets/opaque_1',
  sourceUrl: 'https://example.org/photo',
  note: 'Warm natural light.',
  createdAt: '2026-10-16T12:00:00.000Z',
};

describe('portable product handoff', () => {
  it('bundles uploaded bytes, structured context, decisions, and stable SVGs with verifiable checksums', async () => {
    const project = projectFixture();
    project.comments[2].target = { kind: 'project', x: 0.5, y: 0.5 };
    project.comments[2].previousLocation = 'Deleted checkout screen · Pay now button';
    project.assets = [
      uploadedImage,
      {
        ...uploadedImage,
        id: 'asset_b',
        title: 'External reference',
        imageUrl: 'https://example.org/reference.jpg',
      },
    ];
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const get = vi.fn(async () => ({
      size: png.length,
      customMetadata: { owner: 'owner', projectId: project.id },
      httpMetadata: { contentType: 'image/png' },
      arrayBuffer: async () => png.buffer,
    }));
    const { files, zip } = await buildProjectExport(project, { bucket: { get }, owner: 'owner' });
    const archive = unzipSync(zip);
    expect(Object.keys(archive)).toEqual(Object.keys(files));
    expect(archive['assets/001-workshop-photo.png']).toEqual(png);
    expect(JSON.parse(strFromU8(archive['project.json']))).toEqual(project);
    expect(get).toHaveBeenCalledExactlyOnceWith('opaque_1');
    const requirements = JSON.parse(strFromU8(archive['requirements.json']));
    expect(requirements.accepted.map((item: { id: string }) => item.id)).toEqual(['req_accepted']);
    expect(requirements.proposed.map((item: { id: string }) => item.id)).toEqual(['req_proposed']);
    expect(requirements.annotations.open[0].body).toBe('Which payment provider?');
    expect(requirements.annotations.resolved[0].body).toBe('Keep this discussion history.');
    expect(requirements.openQuestions).toBe('Does a booking require payment?');
    const spec = strFromU8(archive['spec.md']);
    expect(spec).toContain('## Proposed requirements — awaiting decision');
    expect(spec).toContain('→ screen screen_b');
    expect(spec).toContain('do not silently treat them as approved behavior');
    expect(spec).toContain('Previous location: Deleted checkout screen · Pay now button');
    const guide = strFromU8(archive['CODEX.md']);
    expect(guide).toContain('project_a, revision 1');
    expect(guide).toContain(
      '1 accepted requirements, 1 proposed requirements, and 1 open annotations',
    );
    expect(guide).toContain('Resolved annotations and chat messages are discussion history');
    const manifest = JSON.parse(strFromU8(archive['manifest.json']));
    expect(manifest.entrypoint).toBe('CODEX.md');
    expect(manifest.overview).toMatchObject({
      derivedFrom: 'project.json',
      sourcesPath: 'overview/sources.json',
      graphs: ['product', 'journey', 'screens'].map((id) => ({
        id,
        path: `overview/${id}.mmd`,
      })),
    });
    expect(strFromU8(archive['CODEX.md'])).toContain('These views introduce no new decisions');
    expect(strFromU8(archive['spec.md'])).toContain('## Automatic product overview');
    expect(manifest.screens).toEqual([
      {
        id: 'screen_a',
        name: 'My workshops',
        platform: 'desktop',
        state: 'default',
        path: 'screens/01-my-workshops.svg',
      },
    ]);
    expect(manifest.assets[0]).toMatchObject({
      status: 'bundled',
      path: 'assets/001-workshop-photo.png',
    });
    expect(manifest.assets[1]).toMatchObject({
      status: 'reference',
      originalImageUrl: 'https://example.org/reference.jpg',
    });
    expect(manifest.assets[1].reason).toContain('never fetches');
    for (const file of manifest.files) {
      const digest = await crypto.subtle.digest('SHA-256', archive[file.path]);
      expect(file.sha256).toBe(
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      );
      expect(file.bytes).toBe(archive[file.path].byteLength);
    }
    expect(manifest.files.some((file: { path: string }) => file.path === 'manifest.json')).toBe(
      false,
    );
    expect((await buildProjectExport(project, { bucket: { get }, owner: 'owner' })).zip).toEqual(
      zip,
    );
  });

  it('does not bundle another owner’s or another project’s image', async () => {
    const project = projectFixture();
    project.assets = [uploadedImage];
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    for (const metadata of [
      { owner: 'other', projectId: project.id },
      { owner: 'owner', projectId: 'other' },
      undefined,
    ]) {
      const bucket = {
        get: vi.fn(async () => ({
          size: 0,
          customMetadata: metadata,
          httpMetadata: { contentType: 'image/png' },
          arrayBuffer,
        })),
      };
      await expect(buildProjectExport(project, { bucket, owner: 'owner' })).rejects.toMatchObject({
        status: 422,
        code: 'EXPORT_ASSET_UNAVAILABLE',
      });
    }
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('makes missing assets, oversized images, and SVG uploads explicit failures', async () => {
    const project = projectFixture();
    project.assets = [uploadedImage];
    await expect(
      buildProjectExport(project, { bucket: emptyBucket(), owner: 'owner' }),
    ).rejects.toMatchObject({ code: 'EXPORT_ASSET_UNAVAILABLE' });
    const object = {
      size: 100,
      customMetadata: { owner: 'owner', projectId: project.id },
      httpMetadata: { contentType: 'image/svg+xml' },
      arrayBuffer: vi.fn(),
    };
    await expect(
      buildProjectExport(project, { bucket: { get: async () => object }, owner: 'owner' }),
    ).rejects.toMatchObject({ code: 'EXPORT_ASSET_FORMAT' });
    object.httpMetadata.contentType = 'image/png';
    object.size = 10 * 1024 * 1024 + 1;
    await expect(
      buildProjectExport(project, { bucket: { get: async () => object }, owner: 'owner' }),
    ).rejects.toMatchObject({ status: 413 });
    expect(object.arrayBuffer).not.toHaveBeenCalled();
  });

  it('explains sample references and gives duplicate screen names unique package paths', async () => {
    const project = projectFixture();
    project.screens.push({ ...project.screens[0], id: 'screen_b' });
    project.assets = [{ ...uploadedImage, imageUrl: '/sample/warm.svg' }];
    const bucket = emptyBucket();
    const { files } = await buildProjectExport(project, { bucket, owner: 'owner' });
    expect(files['screens/01-my-workshops.svg']).toBeDefined();
    expect(files['screens/02-my-workshops.svg']).toBeDefined();
    expect(JSON.parse(strFromU8(files['manifest.json'])).assets[0].reason).toContain(
      'Built-in sample illustration',
    );
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('builds the same checked files without allocating an unused ZIP for GitHub', async () => {
    const project = projectFixture();
    const options = { bucket: emptyBucket(), owner: 'owner' };
    const archived = await buildProjectExport(project, options);
    const plain = await buildProjectExport(project, { ...options, includeZip: false });
    expect(plain).toEqual({ files: archived.files });
    expect(plain).not.toHaveProperty('zip');
  });

  it('derives current overview sources on every export without changing the project', async () => {
    const project = projectFixture();
    project.plan.problem = '  Members need accessible workshops.\nKeep the original spacing.  ';
    const before = structuredClone(project);
    const options = { bucket: emptyBucket(), owner: 'owner', includeZip: false as const };
    const first = await buildProjectExport(project, options);
    expect(project).toEqual(before);
    const overview = JSON.parse(strFromU8(first.files['overview/sources.json'])) as ReturnType<
      typeof buildProductOverview
    >;
    expect(overview.projectId).toBe(project.id);
    const entries = overview.graphs.flatMap((graph) => graph.nodes.flatMap((node) => node.entries));
    expect(entries).toContainEqual(
      expect.objectContaining({
        body: project.plan.problem,
        source: { kind: 'plan', key: 'problem' },
      }),
    );
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: 'Save the booking.',
          status: 'accepted',
          source: { kind: 'requirement', requirementId: 'req_accepted' },
        }),
        expect.objectContaining({
          body: 'Maybe accept payments.',
          status: 'proposed',
          source: { kind: 'requirement', requirementId: 'req_proposed' },
        }),
        expect.objectContaining({
          body: 'Which payment provider?',
          status: 'open',
          source: { kind: 'comment', commentId: 'comment_b' },
        }),
        expect.objectContaining({
          body: 'Keep this discussion history.',
          status: 'resolved',
          source: { kind: 'comment', commentId: 'comment_c' },
        }),
        expect.objectContaining({
          title: 'My workshops',
          status: 'default',
          source: { kind: 'screen', screenId: 'screen_a' },
        }),
        expect.objectContaining({
          body: expect.stringContaining('Book workshop'),
          source: { kind: 'screen', screenId: 'screen_a', nodeId: 'button' },
        }),
      ]),
    );
    project.plan.problem = 'Updated problem after the last overview.';
    project.screens[0].name = 'Workshop library';
    project.comments[1].body = 'Updated unresolved payment question.';
    const edited = structuredClone(project);
    const second = await buildProjectExport(project, options);
    expect(project).toEqual(edited);
    expect(second.files['overview/product.mmd']).not.toEqual(first.files['overview/product.mmd']);
    expect(second.files['overview/screens.mmd']).not.toEqual(first.files['overview/screens.mmd']);
    const refreshed = strFromU8(second.files['overview/sources.json']);
    expect(refreshed).toContain(project.plan.problem);
    expect(refreshed).toContain('Workshop library');
    expect(refreshed).toContain(project.comments[1].body);
    expect(refreshed).not.toContain('Members need accessible workshops.');
    expect(refreshed).not.toContain('Which payment provider?');
  });

  it('exports screen connections only when a component has an explicit navigation target', async () => {
    const project = projectFixture();
    const button = project.screens[0].nodes[0].children[0].children[0];
    delete button.action;
    project.screens.push({
      id: 'screen_b',
      name: 'Confirmation',
      platform: 'desktop',
      state: 'success',
      description: 'The saved booking.',
      nodes: [],
    });
    project.plan.journeys = 'My workshops leads to Confirmation after booking.';
    const options = { bucket: emptyBucket(), owner: 'owner', includeZip: false as const };
    const readScreenEdges = (files: Record<string, Uint8Array>) => {
      const overview = JSON.parse(strFromU8(files['overview/sources.json'])) as ReturnType<
        typeof buildProductOverview
      >;
      return overview.graphs.find((graph) => graph.id === 'screens')!.edges;
    };
    const unlinked = await buildProjectExport(project, options);
    expect(readScreenEdges(unlinked.files).filter((edge) => edge.kind === 'navigation')).toEqual(
      [],
    );
    button.action = { screenId: 'screen_b' };
    const linked = await buildProjectExport(project, options);
    expect(readScreenEdges(linked.files).filter((edge) => edge.kind === 'navigation')).toHaveLength(
      1,
    );
    delete button.action;
    const removed = await buildProjectExport(project, options);
    expect(removed.files['overview/screens.mmd']).toEqual(unlinked.files['overview/screens.mmd']);
  });

  it('preserves Mermaid drafts byte-for-byte with stable paths, metadata, and checksums', async () => {
    const project = projectFixture();
    project.diagrams = [
      {
        id: 'diagram_Flow-1',
        title: 'Workshop journey',
        kind: 'flowchart',
        source: 'flowchart LR\r\n  Browse["Explore 🌍"] --> Book["Book a workshop"]\r\n',
      },
      {
        id: 'diagram_states',
        title: 'Workshop journey',
        kind: 'state',
        source: 'stateDiagram-v2\n  [*] --> Loading\n  Loading -->',
      },
    ];
    const { files, zip } = await buildProjectExport(project, {
      bucket: emptyBucket(),
      owner: 'owner',
    });
    const archive = unzipSync(zip);
    const manifest = JSON.parse(strFromU8(archive['manifest.json']));
    expect(manifest.diagrams).toEqual(
      project.diagrams.map(({ id, title, kind }) => ({
        id,
        title,
        kind,
        path: `diagrams/${id}.mmd`,
      })),
    );
    for (const diagram of project.diagrams) {
      const path = `diagrams/${diagram.id}.mmd`;
      expect(archive[path]).toEqual(strToU8(diagram.source));
      expect(files[path]).toEqual(archive[path]);
      const checksum = manifest.files.find((file: { path: string }) => file.path === path);
      expect(checksum.bytes).toBe(strToU8(diagram.source).byteLength);
      const digest = await crypto.subtle.digest('SHA-256', archive[path]);
      expect(checksum.sha256).toBe(
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      );
      expect(strFromU8(files['spec.md'])).toContain(`Source: \`${path}\``);
    }
    expect(JSON.parse(strFromU8(files['project.json'])).diagrams).toEqual(project.diagrams);
    expect(strFromU8(files['CODEX.md'])).toContain('not approved requirements');
    expect(strFromU8(files['spec.md'])).toContain('export does not validate or render them');
    expect(Object.keys(files).filter((path) => path.startsWith('diagrams/'))).toHaveLength(2);

    project.diagrams.reverse();
    project.diagrams[0].title = 'Renamed draft';
    const renamed = await buildProjectExport(project, {
      bucket: emptyBucket(),
      owner: 'owner',
      includeZip: false,
    });
    for (const path of Object.keys(files).filter((path) => path.startsWith('diagrams/')))
      expect(renamed.files[path]).toEqual(files[path]);
  });

  it('keeps legacy projects compatible and rejects unsafe diagram file IDs', async () => {
    const project = projectFixture();
    delete project.diagrams;
    const legacy = await buildProjectExport(project, { bucket: emptyBucket(), owner: 'owner' });
    expect(JSON.parse(strFromU8(legacy.files['manifest.json']))).not.toHaveProperty('diagrams');
    project.diagrams = [];
    const empty = await buildProjectExport(project, { bucket: emptyBucket(), owner: 'owner' });
    for (const path of ['CODEX.md', 'spec.md'])
      expect(empty.files[path]).toEqual(legacy.files[path]);
    expect(Object.keys(empty.files).some((path) => path.startsWith('diagrams/'))).toBe(false);
    project.diagrams = [
      { id: '../escape', title: 'Unsafe', kind: 'flowchart', source: 'flowchart LR\n A --> B' },
    ];
    await expect(
      buildProjectExport(project, { bucket: emptyBucket(), owner: 'owner' }),
    ).rejects.toMatchObject({ code: 'EXPORT_DIAGRAM_ID' });
  });
});

describe('safe layout-aware SVG', () => {
  it('positions row children horizontally and attaches dotted annotations to component bounds', () => {
    const project = projectFixture();
    const svg = renderScreenSvg(project.screens[0], project.design, project.comments);
    const bounds = (id: string) => {
      const match = svg.match(
        new RegExp(
          `data-node-id="${id}"[^>]*><title>[^<]*<\\/title><rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"`,
        ),
      );
      expect(match).not.toBeNull();
      return match!.slice(1).map(Number);
    };
    const left = bounds('card_a');
    const right = bounds('card_b');
    expect(left[1]).toBe(right[1]);
    expect(left[0] + left[2]).toBeLessThan(right[0]);
    expect(svg).toContain('stroke-dasharray="3 5"');
    expect(svg).toContain('data-comment-id="comment_a"');
    const button = bounds('button');
    expect(svg).toContain(
      `M ${button[0] + button[2] / 2} ${Math.round((button[1] + button[3] / 2) * 100) / 100}`,
    );
    expect(svg).toBe(renderScreenSvg(project.screens[0], project.design, project.comments));
  });

  it('renders every supported node type and escapes untrusted markup and attributes', () => {
    const project = projectFixture();
    const screen = project.screens[0];
    screen.name = '<script>alert(1)</script>';
    screen.nodes = NODE_TYPES.map((type) => ({
      ...createNode(type, '<img src=x onerror="alert(1)"> & text'),
      id: `${type}\" onload=\"alert(1)`,
      style: { background: 'url(https://evil.example/track)', color: 'red\" onload=\"alert(1)' },
    }));
    const svg = renderScreenSvg(screen, { ...project.design, accent: 'javascript:alert(1)' });
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<img');
    expect(svg).not.toContain('https://evil.example');
    expect(svg).not.toContain('javascript:');
    expect(svg).not.toContain('" onload="');
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(svg).toContain('&quot; onload=&quot;');
    for (const type of NODE_TYPES) expect(svg).toContain(`data-node-type="${type}"`);
  });

  it('wraps long text within mobile components and grows the SVG instead of clipping it', () => {
    const project = projectFixture();
    project.screens[0].platform = 'mobile';
    project.screens[0].nodes = [
      createNode('text', 'Long requirements need readable wrapping. '.repeat(100)),
    ];
    const svg = renderScreenSvg(project.screens[0], project.design);
    expect(svg).toContain('width="375"');
    expect((svg.match(/<tspan /g) || []).length).toBeGreaterThan(50);
    expect(Number(svg.match(/height="([\d.]+)"/)![1])).toBeGreaterThan(844);
  });

  it('stacks row children vertically on mobile', () => {
    const project = projectFixture();
    project.screens[0].platform = 'mobile';
    const svg = renderScreenSvg(project.screens[0], project.design);
    const rect = (id: string) =>
      svg
        .match(
          new RegExp(
            `data-node-id="${id}"[^>]*><title>[^<]*<\\/title><rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"`,
          ),
        )!
        .slice(1)
        .map(Number);
    const first = rect('card_a');
    const second = rect('card_b');
    expect(first[0]).toBe(second[0]);
    expect(first[1] + first[3]).toBeLessThan(second[1]);
  });
});

const SHA = {
  parent: 'a'.repeat(40),
  baseTree: 'b'.repeat(40),
  blob: 'c'.repeat(40),
  tree: 'd'.repeat(40),
  commit: 'e'.repeat(40),
  docsTree: 'f'.repeat(40),
  destinationTree: '1'.repeat(40),
};
interface ExistingEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}
const existingFiles = (...paths: string[]): ExistingEntry[] =>
  paths.map((path) => ({ path, mode: '100644', type: 'blob', sha: SHA.blob }));
function githubMock(patchStatus = 200, existing: ExistingEntry[] | null = null) {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.github.com/repos/JoDavidsson/example', '');
    const method = init?.method || 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.startsWith('/git/ref/heads/')) return Response.json({ object: { sha: SHA.parent } });
    if (path === `/git/commits/${SHA.parent}`)
      return Response.json({ tree: { sha: SHA.baseTree } });
    if (path === `/git/trees/${SHA.baseTree}`)
      return Response.json({
        tree: existing ? [{ path: 'docs', mode: '040000', type: 'tree', sha: SHA.docsTree }] : [],
        truncated: false,
      });
    if (path === `/git/trees/${SHA.docsTree}`)
      return Response.json({
        tree: [{ path: 'product', mode: '040000', type: 'tree', sha: SHA.destinationTree }],
        truncated: false,
      });
    if (path === `/git/trees/${SHA.destinationTree}?recursive=1`)
      return Response.json({ tree: existing, truncated: false });
    if (path === '/git/blobs') return Response.json({ sha: SHA.blob });
    if (path === '/git/trees') return Response.json({ sha: SHA.tree });
    if (path === '/git/commits') return Response.json({ sha: SHA.commit });
    if (method === 'PATCH')
      return Response.json({ object: { sha: SHA.commit } }, { status: patchStatus });
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  return { request, calls };
}
const destination = {
  token: 'test-server-secret',
  repository: 'JoDavidsson/example',
  branch: 'design/spec',
  path: 'docs/product',
};

describe('atomic GitHub handoff', () => {
  it('creates binary blobs and one commit on the existing tree, preserving unrelated paths', async () => {
    const { request, calls } = githubMock();
    const result = await publishGithubExport(
      { 'spec.md': strToU8('Hello 🌍'), 'assets/001-image.png': new Uint8Array([0, 127, 255]) },
      { ...destination, fetch: request },
    );
    expect(result).toEqual({
      commit: SHA.commit,
      url: `https://github.com/JoDavidsson/example/tree/${SHA.commit}/docs/product`,
    });
    expect(calls[0].path).toBe('/git/ref/heads/design/spec');
    const blobs = calls.filter((call) => call.path === '/git/blobs');
    expect(blobs.map((call) => call.body?.encoding)).toEqual(['base64', 'base64']);
    expect(blobs[1].body?.content).toBe('AH//');
    const tree = calls.find((call) => call.path === '/git/trees')!.body!;
    expect(tree.base_tree).toBe(SHA.baseTree);
    expect(tree.tree).toEqual([
      { path: 'docs/product/spec.md', mode: '100644', type: 'blob', sha: SHA.blob },
      { path: 'docs/product/assets/001-image.png', mode: '100644', type: 'blob', sha: SHA.blob },
    ]);
    expect(calls.find((call) => call.path === '/git/commits')!.body).toMatchObject({
      parents: [SHA.parent],
      tree: SHA.tree,
    });
    expect(calls.at(-1)).toEqual({
      path: '/git/refs/heads/design/spec',
      method: 'PATCH',
      body: { sha: SHA.commit, force: false },
    });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(request.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer test-server-secret',
    });
  });

  it('reports a concurrent branch change and never retries with force', async () => {
    const { request, calls } = githubMock(422);
    await expect(
      publishGithubExport({ 'spec.md': strToU8('spec') }, { ...destination, fetch: request }),
    ).rejects.toMatchObject({ status: 409, code: 'GITHUB_CONFLICT' });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(calls.at(-1)?.body?.force).toBe(false);
  });

  it('removes only stale managed files from the same project’s previous manifest', async () => {
    const { request, calls } = githubMock(
      200,
      existingFiles(
        'manifest.json',
        'spec.md',
        'screens/01-old.svg',
        'diagrams/diagram_old.mmd',
        'diagrams/notes.md',
        'overview/product.mmd',
        'overview/journey.mmd',
        'overview/screens.mmd',
        'overview/sources.json',
        'overview/custom.mmd',
        'overview/notes.md',
        'notes.md',
      ),
    );
    const previous = {
      format: 'blai-product-handoff',
      projectId: 'project_a',
      files: [
        { path: 'screens/01-old.svg' },
        { path: 'diagrams/diagram_old.mmd' },
        { path: 'diagrams/notes.md' },
        { path: 'overview/product.mmd' },
        { path: 'overview/journey.mmd' },
        { path: 'overview/screens.mmd' },
        { path: 'overview/sources.json' },
        { path: 'overview/custom.mmd' },
        { path: 'overview/notes.md' },
        { path: 'assets/001-old.png' },
        { path: 'spec.md' },
        { path: '../worker.ts' },
        { path: 'notes.md' },
      ],
    };
    const read = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('/contents/')
        ? Response.json({ encoding: 'base64', size: 1000, content: btoa(JSON.stringify(previous)) })
        : request(url, init),
    );
    const manifest = strToU8(
      JSON.stringify({ format: 'blai-product-handoff', projectId: 'project_a' }),
    );
    await publishGithubExport(
      { 'spec.md': strToU8('spec'), 'manifest.json': manifest },
      { ...destination, fetch: read },
    );
    const tree = calls.find((call) => call.path === '/git/trees')!.body!.tree as {
      path: string;
      sha: string | null;
    }[];
    expect(tree.filter((entry) => entry.sha === null).map((entry) => entry.path)).toEqual([
      'docs/product/screens/01-old.svg',
      'docs/product/diagrams/diagram_old.mmd',
      'docs/product/overview/product.mmd',
      'docs/product/overview/journey.mmd',
      'docs/product/overview/screens.mmd',
      'docs/product/overview/sources.json',
    ]);
    // The prior image was already removed manually: asking GitHub to delete it
    // again would reject an otherwise valid export.
    expect(tree.some((entry) => entry.path === 'docs/product/assets/001-old.png')).toBe(false);
    expect(tree.some((entry) => /worker|notes|custom/.test(entry.path))).toBe(false);
    expect(
      read.mock.calls.some(([url]) =>
        String(url).endsWith(`/contents/docs/product/manifest.json?ref=${SHA.parent}`),
      ),
    ).toBe(true);
  });

  it('publishes the complete package to a new folder and rejects overwriting another project', async () => {
    const { request, calls } = githubMock();
    const project = projectFixture();
    project.diagrams = [
      { id: 'diagram_flow', title: 'Journey', kind: 'flowchart', source: 'flowchart LR\n A --> B' },
    ];
    const { files } = await buildProjectExport(project, {
      bucket: emptyBucket(),
      owner: 'owner',
    });
    const newFolder = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('/contents/') ? new Response('', { status: 404 }) : request(url, init),
    );
    await expect(
      publishGithubExport(files, { ...destination, fetch: newFolder }),
    ).resolves.toMatchObject({ commit: SHA.commit });
    expect(calls.filter((call) => call.path === '/git/blobs')).toHaveLength(
      Object.keys(files).length,
    );
    const existing = githubMock(200, existingFiles('manifest.json'));
    const otherProject = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('/contents/')
        ? Response.json({
            encoding: 'base64',
            size: 100,
            content: btoa(
              JSON.stringify({
                format: 'blai-product-handoff',
                projectId: 'project_other',
                files: [],
              }),
            ),
          })
        : existing.request(url, init),
    );
    await expect(
      publishGithubExport(files, { ...destination, fetch: otherProject }),
    ).rejects.toMatchObject({ code: 'GITHUB_DESTINATION_CONFLICT' });
    expect(existing.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('preserves unmanaged files and rejects package-name collisions before uploading', async () => {
    for (const path of [
      'spec.md',
      'CODEX.md',
      'assets/001-photo.png',
      'diagrams/diagram_flow.mmd',
      'overview/product.mmd',
      'overview/journey.mmd',
      'overview/screens.mmd',
      'overview/sources.json',
    ]) {
      const { request, calls } = githubMock(200, existingFiles(path, 'notes.md'));
      await expect(
        publishGithubExport({ [path]: strToU8('replacement') }, { ...destination, fetch: request }),
      ).rejects.toMatchObject({ code: 'GITHUB_DESTINATION_CONFLICT' });
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
    }
    const { request, calls } = githubMock(200, existingFiles('notes.md'));
    await expect(
      publishGithubExport({ 'spec.md': strToU8('spec') }, { ...destination, fetch: request }),
    ).resolves.toMatchObject({ commit: SHA.commit });
    expect(JSON.stringify(calls.find((call) => call.path === '/git/trees')?.body)).not.toContain(
      'notes.md',
    );
  });

  it('does not claim new unmanaged files merely because a folder has this project’s manifest', async () => {
    const { request, calls } = githubMock(
      200,
      existingFiles('manifest.json', 'spec.md', 'CODEX.md'),
    );
    const previous = {
      format: 'blai-product-handoff',
      projectId: 'project_a',
      files: [{ path: 'spec.md' }],
    };
    const read = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('/contents/')
        ? Response.json({ encoding: 'base64', size: 1000, content: btoa(JSON.stringify(previous)) })
        : request(url, init),
    );
    const { files } = await buildProjectExport(projectFixture(), {
      bucket: emptyBucket(),
      owner: 'owner',
      includeZip: false,
    });
    await expect(publishGithubExport(files, { ...destination, fetch: read })).rejects.toMatchObject(
      { code: 'GITHUB_DESTINATION_CONFLICT' },
    );
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('rejects links, files, and submodules occupying destination folders', async () => {
    for (const [mode, type] of [
      ['120000', 'blob'],
      ['100644', 'blob'],
      ['160000', 'commit'],
    ]) {
      const base = githubMock();
      const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
        String(url).endsWith(`/git/trees/${SHA.baseTree}`)
          ? Response.json({ tree: [{ path: 'docs', mode, type, sha: SHA.blob }] })
          : base.request(url, init),
      );
      await expect(
        publishGithubExport({ 'spec.md': strToU8('spec') }, { ...destination, fetch: request }),
      ).rejects.toMatchObject({ code: 'GITHUB_DESTINATION_CONFLICT' });
      expect(base.calls.every((call) => call.method === 'GET')).toBe(true);
    }
    const { request, calls } = githubMock(200, [
      { path: 'assets', mode: '120000', type: 'blob', sha: SHA.blob },
    ]);
    await expect(
      publishGithubExport(
        { 'assets/001-photo.png': new Uint8Array([1]) },
        { ...destination, fetch: request },
      ),
    ).rejects.toMatchObject({ code: 'GITHUB_DESTINATION_CONFLICT' });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('does not publish after an incomplete destination tree or unconfirmed branch response', async () => {
    const base = githubMock(200, []);
    const truncated = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith('?recursive=1')
        ? Response.json({ tree: [], truncated: true })
        : base.request(url, init),
    );
    await expect(
      publishGithubExport({ 'spec.md': strToU8('spec') }, { ...destination, fetch: truncated }),
    ).rejects.toMatchObject({ code: 'GITHUB_DESTINATION_CONFLICT' });
    expect(base.calls.every((call) => call.method === 'GET')).toBe(true);
    const unconfirmed = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? Response.json({ object: { sha: SHA.parent } })
        : base.request(url, init),
    );
    await expect(
      publishGithubExport({ 'spec.md': strToU8('spec') }, { ...destination, fetch: unconfirmed }),
    ).rejects.toMatchObject({ code: 'GITHUB_INVALID_RESPONSE' });
  });

  it('leaves the branch untouched when a file upload fails', async () => {
    const base = githubMock();
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith('/git/blobs')
        ? new Response('private upstream failure', { status: 500 })
        : base.request(url, init),
    );
    await expect(
      publishGithubExport(
        { 'spec.md': strToU8('spec'), 'CODEX.md': strToU8('instructions') },
        { ...destination, fetch: request },
      ),
    ).rejects.toMatchObject({ code: 'GITHUB_API_ERROR' });
    expect(base.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(request.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('rejects token absence and unsafe paths before making remote requests', async () => {
    const request = vi.fn();
    await expect(
      publishGithubExport(
        { 'spec.md': strToU8('spec') },
        { ...destination, token: '', fetch: request },
      ),
    ).rejects.toMatchObject({ status: 503, code: 'GITHUB_NOT_CONFIGURED' });
    for (const path of [
      '',
      '/',
      '../docs',
      'docs/../../src',
      '.github/workflows',
      'docs/.git',
      'docs//spec',
      'docs\\spec',
    ]) {
      expect(() =>
        validateGithubDestination(destination.repository, destination.branch, path),
      ).toThrow();
    }
    for (const branch of [
      '../main',
      'main.lock',
      'main@{0}',
      'branch?',
      '-main',
      'main//spec',
      'main ',
      'main.',
    ])
      expect(() =>
        validateGithubDestination(destination.repository, branch, destination.path),
      ).toThrow();
    await expect(
      publishGithubExport({ '../code.ts': strToU8('bad') }, { ...destination, fetch: request }),
    ).rejects.toMatchObject({ code: 'INVALID_EXPORT_FILE' });
    for (const path of [
      'overview/custom.mmd',
      'overview/notes.md',
      'overview/product.svg',
      'overview/../spec.md',
      'overview/project.json',
    ])
      await expect(
        publishGithubExport({ [path]: strToU8('bad') }, { ...destination, fetch: request }),
      ).rejects.toMatchObject({ code: 'INVALID_EXPORT_FILE' });
    expect(request).not.toHaveBeenCalled();
    expect(
      validateGithubDestination('JoDavidsson/BLAI-Product-Designer', 'main', 'docs/handoff/'),
    ).toMatchObject({ path: 'docs/handoff' });
  });

  it('provides an actionable missing-branch error without echoing upstream secrets', async () => {
    const request = vi.fn(
      async () => new Response('test-server-secret: private upstream data', { status: 404 }),
    );
    await expect(
      publishGithubExport({ 'spec.md': strToU8('spec') }, { ...destination, fetch: request }),
    ).rejects.toMatchObject({
      code: 'GITHUB_NOT_FOUND',
      message: expect.stringContaining('Initialize the repository'),
    });
    try {
      await publishGithubExport({ 'spec.md': strToU8('spec') }, { ...destination, fetch: request });
    } catch (error) {
      expect(String(error)).not.toContain('test-server-secret');
    }
  });
});
