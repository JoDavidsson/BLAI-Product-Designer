import { describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import {
  createNode,
  createProject,
  NODE_TYPES,
  type Annotation,
  type Project,
} from '../shared/model';
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
    const manifest = JSON.parse(strFromU8(archive['manifest.json']));
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
};
function githubMock(patchStatus = 200) {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.github.com/repos/JoDavidsson/example', '');
    const method = init?.method || 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.startsWith('/git/ref/heads/')) return Response.json({ object: { sha: SHA.parent } });
    if (path === `/git/commits/${SHA.parent}`)
      return Response.json({ tree: { sha: SHA.baseTree } });
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
    const { request, calls } = githubMock();
    const previous = {
      format: 'blai-product-handoff',
      projectId: 'project_a',
      files: [
        { path: 'screens/01-old.svg' },
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
      'docs/product/assets/001-old.png',
    ]);
    expect(tree.some((entry) => /worker|notes/.test(entry.path))).toBe(false);
    expect(
      read.mock.calls.some(([url]) =>
        String(url).endsWith(`/contents/docs/product/manifest.json?ref=${SHA.parent}`),
      ),
    ).toBe(true);
  });

  it('publishes the complete package to a new folder and rejects overwriting another project', async () => {
    const { request, calls } = githubMock();
    const { files } = await buildProjectExport(projectFixture(), {
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
        : request(url, init),
    );
    await expect(
      publishGithubExport(files, { ...destination, fetch: otherProject }),
    ).rejects.toMatchObject({ code: 'GITHUB_DESTINATION_CONFLICT' });
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
