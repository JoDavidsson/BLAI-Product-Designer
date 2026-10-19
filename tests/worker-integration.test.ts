import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleRequest } from '../worker/index';
import { getProject, newProject, saveProject } from '../worker/projects';
import {
  JOB_KINDS,
  createNode,
  type AIJob,
  type AIResult,
  type HelperStatus,
  type Project,
} from '../shared/model';
import {
  applyProposal,
  bridgeOperation,
  bridgeSchema,
  CANVAS_CAPABILITY,
  enqueueJob,
  helperStatus,
  listJobs,
  listProposals,
} from '../worker/jobs';
import type { Env } from '../worker/types';

let mf: Miniflare;
let env: Env;
let registryPath: string;
async function request(
  path: string,
  method = 'GET',
  data?: unknown,
  headers: Record<string, string> = {},
) {
  return handleRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    }),
    env,
  );
}
async function payload<T>(response: Response): Promise<T> {
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBeLessThan(300);
  return data as T;
}
async function project() {
  return (
    await payload<{ project: Project }>(
      await request('/api/projects', 'POST', { title: 'Integration project' }),
    )
  ).project;
}
async function bridge(data: unknown) {
  return request('/api/codex', 'POST', data, { 'x-designer-bridge-key': 'integration-only-key' });
}
async function claimedJob(workerId: string, helperVersion?: string) {
  const p = await project();
  const claimInput = {
    action: 'claim',
    protocolVersion: 1,
    workerId,
    capabilities: JOB_KINDS,
    ...(helperVersion ? { helperVersion } : {}),
  };
  await payload(await bridge(claimInput));
  await payload(
    await request(`/api/projects/${p.id}/jobs`, 'POST', {
      kind: 'plan.assist',
      instruction: 'Clarify this plan',
    }),
  );
  const claim = await payload<{ protocolVersion: number; job: { id: string; leaseToken: string } }>(
    await bridge(claimInput),
  );
  expect(Object.keys(claim).sort()).toEqual(['job', 'protocolVersion']);
  expect(Object.keys(claim.job).sort()).toEqual([
    'baseRevision',
    'context',
    'id',
    'instruction',
    'kind',
    'leaseExpiresAt',
    'leaseToken',
    'projectId',
  ]);
  const lease = {
    protocolVersion: 1 as const,
    workerId,
    jobId: claim.job.id,
    leaseToken: claim.job.leaseToken,
  };
  const read = async () =>
    (await payload<{ jobs: AIJob[] }>(await request(`/api/projects/${p.id}/jobs`))).jobs.find(
      (job) => job.id === claim.job.id,
    )!;
  return { p, lease, read };
}
const result: AIResult = {
  title: 'Clarify the problem',
  summary: 'Plan proposal',
  reply: 'A more concrete problem statement.',
  plan: {
    problem: 'People need a shared visual specification before asking AI to build software.',
  },
  screens: null,
  design: null,
  requirements: [{ text: 'The product plan must remain editable.' }],
};

describe('Worker with real D1 and R2 bindings', () => {
  beforeAll(async () => {
    registryPath = await mkdtemp(join(tmpdir(), 'blai-worker-tests-'));
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("test"); } };',
        compatibilityDate: '2026-01-15',
        d1Databases: ['DB', 'LEGACY_DB'],
        r2Buckets: ['ASSETS_BUCKET'],
        unsafeDevRegistryPath: registryPath,
      }),
    );
    env = {
      DB: (await mf.getD1Database('DB')) as unknown as D1Database,
      ASSETS_BUCKET: (await mf.getR2Bucket('ASSETS_BUCKET')) as unknown as R2Bucket,
      DEV_AUTH: 'local',
      DESIGNER_BRIDGE_SECRET: 'integration-only-key',
    };
    const migrationsUrl = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrationsUrl))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()) {
      const migration = await readFile(new URL(file, migrationsUrl), 'utf8');
      await env.DB.batch(
        migration
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((sql) => env.DB.prepare(sql)),
      );
    }
  }, 30000);
  afterAll(async () => {
    await mf?.dispose();
    if (registryPath) await rm(registryPath, { recursive: true, force: true });
  });
  it('adds telemetry to a populated legacy database without rewriting jobs, projects or helpers', async () => {
    const legacy = { ...env, DB: (await mf.getD1Database('LEGACY_DB')) as unknown as D1Database };
    const migrate = async (file: string) => {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      await legacy.DB.batch(
        sql
          .split(';')
          .map((statement) => statement.trim())
          .filter(Boolean)
          .map((statement) => legacy.DB.prepare(statement)),
      );
    };
    await migrate('0001_initial.sql');
    const owner = 'legacy@example.com';
    const p = await newProject(legacy, owner, 'Existing project');
    const now = Date.now();
    await legacy.DB.batch([
      legacy.DB.prepare(
        'INSERT INTO helpers(owner,worker_id,protocol_version,capabilities,last_seen) VALUES(?,?,1,?,?)',
      ).bind(owner, 'legacy_worker', JSON.stringify(JOB_KINDS), now),
      legacy.DB.prepare(
        "INSERT INTO jobs(id,project_id,owner,kind,base_revision,status,instruction,context,created_at,worker_id,lease_token,lease_expires_at,started_at) VALUES(?,?,?,'plan.assist',1,'running','Legacy request',?,?,?,'legacy_lease',?,?)",
      ).bind(
        'legacy_job',
        p.id,
        owner,
        JSON.stringify(p),
        p.createdAt,
        'legacy_worker',
        now + 45000,
        now,
      ),
    ]);
    const before = await legacy.DB.prepare('SELECT * FROM jobs WHERE id=?')
      .bind('legacy_job')
      .first<Record<string, unknown>>();
    await migrate('0002_job_telemetry.sql');
    const after = await legacy.DB.prepare('SELECT * FROM jobs WHERE id=?')
      .bind('legacy_job')
      .first<Record<string, unknown>>();
    expect(after).toMatchObject(before!);
    for (const [key, value] of Object.entries(after!))
      if (!(key in before!)) expect(value).toBeNull();
    expect(await getProject(legacy, owner, p.id)).toEqual(p);
    expect(await helperStatus(legacy, owner)).toMatchObject({
      online: true,
      workerId: 'legacy_worker',
      helperVersion: null,
    });
    expect(await listJobs(legacy, owner, p.id)).toEqual([
      {
        id: 'legacy_job',
        projectId: p.id,
        kind: 'plan.assist',
        baseRevision: 1,
        status: 'running',
        instruction: 'Legacy request',
        createdAt: p.createdAt,
        startedAt: new Date(now).toISOString(),
      },
    ]);
  });
  it('keeps projects scoped and lets exactly one concurrent revision win', async () => {
    const p = await project();
    await expect(getProject(env, 'another-owner@example.com', p.id)).rejects.toThrow(
      /could not be found/,
    );
    const saved = await Promise.all(
      ['First', 'Second'].map((title) =>
        request(`/api/projects/${p.id}`, 'PUT', { project: { ...p, title }, expectedRevision: 1 }),
      ),
    );
    expect(saved.map((r) => r.status).sort()).toEqual([200, 409]);
    const current = await getProject(env, 'local@blai.test', p.id);
    expect(current.revision).toBe(2);
    const versions = await payload<{ versions: { id: string; revision: number }[] }>(
      await request(`/api/projects/${p.id}/versions`),
    );
    expect(versions.versions).toHaveLength(1);
    expect(versions.versions[0].revision).toBe(2);
    const foreign = await newProject(env, 'another-owner@example.com', 'Private');
    expect((await request(`/api/projects/${foreign.id}`)).status).toBe(404);
  });
  it('bounds stored project bytes for multilingual content without changing the saved revision', async () => {
    const p = await project();
    const proposed: Project = {
      ...p,
      chat: Array.from({ length: 80 }, (_, index) => ({
        id: `multilingual_${index}`,
        role: 'user' as const,
        text: '界'.repeat(7000),
        createdAt: p.createdAt,
      })),
    };
    // Fits both the old character check and the HTTP body limit, but exceeds
    // the storage budget after UTF-8 encoding.
    expect(JSON.stringify(proposed).length).toBeLessThan(1500000);
    const response = await request(`/api/projects/${p.id}`, 'PUT', {
      project: proposed,
      expectedRevision: 1,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'project_too_large' });
    expect(await getProject(env, 'local@blai.test', p.id)).toEqual(p);
    expect(await payload(await request(`/api/projects/${p.id}/versions`))).toEqual({
      versions: [],
    });
  });
  it('downloads private helper settings only when configured and never exposes them in status', async () => {
    expect((await request('/api/helper/setup')).status).toBe(503);
    const response = await handleRequest(new Request('http://localhost/api/helper/setup'), {
      ...env,
      DESIGNER_BRIDGE_SECRET: 'test-only-designer-key-0000000000000000',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    const settings = (await response.json()) as { site: string; bridgeSecret?: string };
    expect(settings.site).toBe('http://localhost');
    expect(typeof settings.bridgeSecret).toBe('string');
    const status = await payload<Record<string, unknown>>(await request('/api/helper/status'));
    expect('bridgeSecret' in status).toBe(false);
  });
  it('saves a named snapshot and restores it through a new revision', async () => {
    const p = await project();
    const checkpoint = await payload<{ version: { id: string } }>(
      await request(`/api/projects/${p.id}/versions`, 'POST', { label: 'Before rename' }),
    );
    await payload(
      await request(`/api/projects/${p.id}`, 'PUT', {
        project: { ...p, title: 'Changed' },
        expectedRevision: 1,
      }),
    );
    const restored = await payload<{ project: Project }>(
      await request(`/api/projects/${p.id}/versions/${checkpoint.version.id}/restore`, 'POST', {
        expectedRevision: 2,
      }),
    );
    expect(restored.project.title).toBe(p.title);
    expect(restored.project.revision).toBe(3);
    expect(
      (
        await request(`/api/projects/${p.id}/versions/${checkpoint.version.id}/restore`, 'POST', {
          expectedRevision: 2,
        })
      ).status,
    ).toBe(409);
  });
  it('preserves notes and accepted requirements when a client removes their screen and filters its comments', async () => {
    const p = (
      await payload<{ project: Project }>(await request('/api/projects', 'POST', { sample: true }))
    ).project;
    const saved = await payload<{ project: Project }>(
      await request(`/api/projects/${p.id}`, 'PUT', {
        project: { ...p, screens: [], comments: [] },
        expectedRevision: 1,
      }),
    );
    expect(saved.project.comments).toHaveLength(1);
    expect(saved.project.comments[0].body).toBe(p.comments[0].body);
    expect(saved.project.comments[0].target.kind).toBe('project');
    expect(saved.project.comments[0].previousLocation).toContain('Trip overview');
    expect(saved.project.requirements[0].status).toBe('accepted');
    expect(saved.project.requirements[0].screenId).toBeUndefined();
    expect(saved.project.requirements[0].sourceCommentId).toBe(saved.project.comments[0].id);
    const persisted = await getProject(env, 'local@blai.test', p.id);
    expect(persisted.comments).toEqual(saved.project.comments);
  });
  it('does not fabricate AI while offline; claims atomically and checks worker leases', async () => {
    const p = await project();
    expect(
      (
        await request(`/api/projects/${p.id}/jobs`, 'POST', {
          kind: 'plan.assist',
          instruction: 'Make a plan',
        })
      ).status,
    ).toBe(503);
    await payload(
      await bridge({
        action: 'claim',
        protocolVersion: 1,
        workerId: 'helper_one',
        capabilities: JOB_KINDS,
      }),
    );
    const queued = await payload<{ job: AIJob }>(
      await request(`/api/projects/${p.id}/jobs`, 'POST', {
        kind: 'plan.assist',
        instruction: 'Improve the problem',
      }),
    );
    const claims = await Promise.all(
      ['helper_one', 'helper_two'].map(async (workerId) => ({
        workerId,
        ...(await payload<{ job: null | { id: string; leaseToken: string; context: Project } }>(
          await bridge({ action: 'claim', protocolVersion: 1, workerId, capabilities: JOB_KINDS }),
        )),
      })),
    );
    expect(claims.filter((c) => c.job)).toHaveLength(1);
    const claim = claims.find((c) => c.job)!;
    expect(claim.job!.id).toBe(queued.job.id);
    expect(claim.job!.context.revision).toBe(1);
    expect(
      (
        await bridge({
          action: 'complete',
          protocolVersion: 1,
          workerId: 'intruder',
          jobId: claim.job!.id,
          leaseToken: claim.job!.leaseToken,
          result,
        })
      ).status,
    ).toBe(409);
    await payload(
      await bridge({
        action: 'complete',
        protocolVersion: 1,
        workerId: claim.workerId,
        jobId: claim.job!.id,
        leaseToken: claim.job!.leaseToken,
        result,
      }),
    );
    // Retry after a transport failure is harmless and does not create another proposal.
    await payload(
      await bridge({
        action: 'complete',
        protocolVersion: 1,
        workerId: claim.workerId,
        jobId: claim.job!.id,
        leaseToken: claim.job!.leaseToken,
        result,
      }),
    );
    const proposals = await payload<{ proposals: { id: string }[] }>(
      await request(`/api/projects/${p.id}/proposals`),
    );
    expect(proposals.proposals).toHaveLength(1);
    const before = await getProject(env, 'local@blai.test', p.id);
    expect(before.plan.problem).toBe('');
    expect(before.revision).toBe(1);
    const applied = await payload<{ project: Project }>(
      await request(`/api/projects/${p.id}/proposals/${proposals.proposals[0].id}/apply`, 'POST', {
        expectedRevision: 1,
      }),
    );
    expect(applied.project.plan.problem).toBe(result.plan!.problem);
    expect(applied.project.revision).toBe(2);
    expect(applied.project.requirements[0].status).toBe('accepted');
    expect(
      (
        await request(
          `/api/projects/${p.id}/proposals/${proposals.proposals[0].id}/apply`,
          'POST',
          { expectedRevision: 2 },
        )
      ).status,
    ).toBe(409);
  });
  it('preserves manual changes against stale proposals and honours cancellation', async () => {
    const p = await project();
    const workerId = 'helper_stale';
    await payload(
      await bridge({ action: 'claim', protocolVersion: 1, workerId, capabilities: JOB_KINDS }),
    );
    const queued = await payload<{ job: AIJob }>(
      await request(`/api/projects/${p.id}/jobs`, 'POST', {
        kind: 'plan.assist',
        instruction: 'Improve the problem',
      }),
    );
    const claim = await payload<{ job: { id: string; leaseToken: string } }>(
      await bridge({ action: 'claim', protocolVersion: 1, workerId, capabilities: JOB_KINDS }),
    );
    await payload(
      await bridge({
        action: 'complete',
        protocolVersion: 1,
        workerId,
        jobId: claim.job.id,
        leaseToken: claim.job.leaseToken,
        result,
      }),
    );
    await payload(
      await request(`/api/projects/${p.id}`, 'PUT', {
        project: { ...p, title: 'Manual change' },
        expectedRevision: 1,
      }),
    );
    const proposals = await payload<{ proposals: { id: string }[] }>(
      await request(`/api/projects/${p.id}/proposals`),
    );
    expect(
      (
        await request(
          `/api/projects/${p.id}/proposals/${proposals.proposals[0].id}/apply`,
          'POST',
          { expectedRevision: 2 },
        )
      ).status,
    ).toBe(409);
    expect((await getProject(env, 'local@blai.test', p.id)).title).toBe('Manual change');
    const next = await payload<{ job: AIJob }>(
      await request(`/api/projects/${p.id}/jobs`, 'POST', {
        kind: 'plan.assist',
        instruction: 'Try again',
      }),
    );
    const active = await payload<{ job: { id: string; leaseToken: string } }>(
      await bridge({ action: 'claim', protocolVersion: 1, workerId, capabilities: JOB_KINDS }),
    );
    expect(active.job.id).toBe(next.job.id);
    expect(active.job.id).not.toBe(queued.job.id);
    await payload(await request(`/api/projects/${p.id}/jobs/${active.job.id}`, 'DELETE'));
    expect(
      await payload(
        await bridge({
          action: 'heartbeat',
          protocolVersion: 1,
          workerId,
          jobId: active.job.id,
          leaseToken: active.job.leaseToken,
        }),
      ),
    ).toMatchObject({ cancelled: true });
    expect(
      (
        await bridge({
          action: 'complete',
          protocolVersion: 1,
          workerId,
          jobId: active.job.id,
          leaseToken: active.job.leaseToken,
          result,
        })
      ).status,
    ).toBe(409);
  });
  it('uploads, serves and exports owner-scoped images, then removes them with the project', async () => {
    const p = await project();
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
      ),
      (v) => v.charCodeAt(0),
    );
    const form = new FormData();
    form.append('file', new File([png], 'pixel.png', { type: 'image/png' }));
    form.append('kind', 'reference');
    form.append('title', 'Reference');
    const upload = await payload<{ asset: Project['assets'][number] }>(
      await handleRequest(
        new Request(`http://localhost/api/projects/${p.id}/assets`, { method: 'POST', body: form }),
        env,
      ),
    );
    const downloaded = await request(upload.asset.imageUrl);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(png);
    const other = await project();
    expect(
      (
        await request(`/api/projects/${other.id}`, 'PUT', {
          project: { ...other, assets: [upload.asset] },
          expectedRevision: 1,
        })
      ).status,
    ).toBe(400);
    await payload(
      await request(`/api/projects/${p.id}`, 'PUT', {
        project: { ...p, assets: [upload.asset] },
        expectedRevision: 1,
      }),
    );
    const exported = await request(`/api/projects/${p.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('Content-Type')).toBe('application/zip');
    expect((await exported.arrayBuffer()).byteLength).toBeGreaterThan(500);
    await payload(await request(`/api/projects/${p.id}`, 'DELETE'));
    expect((await request(upload.asset.imageUrl)).status).toBe(404);
  });
  it('saves full boards while rejecting even one image from another project', async () => {
    const p = await project(),
      other = await project();
    // Populate ownership records directly; image serving is exercised above.
    const assets: Project['assets'] = Array.from({ length: 100 }, (_, index) => ({
      id: `full_board_${p.id}_${index}`,
      title: `Reference ${index + 1}`,
      kind: 'reference',
      imageUrl: `/api/assets/full_board_${p.id}_${index}`,
      sourceUrl: '',
      note: '',
      createdAt: p.createdAt,
    }));
    await env.DB.batch(
      assets.map((asset) =>
        env.DB.prepare(
          'INSERT INTO assets(key,owner,project_id,mime,bytes,created_at) VALUES(?,?,?,?,?,?)',
        ).bind(asset.id, 'local@blai.test', p.id, 'image/png', 1, p.createdAt),
      ),
    );
    const foreign = {
      ...assets[99],
      id: `foreign_${p.id}`,
      imageUrl: `/api/assets/foreign_${p.id}`,
    };
    await env.DB.prepare(
      'INSERT INTO assets(key,owner,project_id,mime,bytes,created_at) VALUES(?,?,?,?,?,?)',
    )
      .bind(foreign.id, 'local@blai.test', other.id, 'image/png', 1, p.createdAt)
      .run();
    const rejected = await request(`/api/projects/${p.id}`, 'PUT', {
      project: { ...p, assets: [...assets.slice(0, 99), foreign] },
      expectedRevision: 1,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'asset_not_owned' });
    const saved = await payload<{ project: Project }>(
      await request(`/api/projects/${p.id}`, 'PUT', {
        project: { ...p, assets },
        expectedRevision: 1,
      }),
    );
    expect(saved.project.assets).toEqual(assets);
    // Separate board cards may intentionally reuse one owned image.
    const reused = {
      ...saved.project,
      assets: assets.map((asset) => ({ ...asset, imageUrl: assets[0].imageUrl })),
    };
    expect(
      (await request(`/api/projects/${p.id}`, 'PUT', { project: reused, expectedRevision: 2 }))
        .status,
    ).toBe(200);
  });
  it('expires a lost lease and prevents a late result from publishing', async () => {
    const p = await project(),
      workerId = 'helper_timeout';
    await payload(
      await bridge({ action: 'claim', protocolVersion: 1, workerId, capabilities: JOB_KINDS }),
    );
    await payload(
      await request(`/api/projects/${p.id}/jobs`, 'POST', {
        kind: 'plan.assist',
        instruction: 'Review this plan',
      }),
    );
    const claim = await payload<{ job: { id: string; leaseToken: string } }>(
      await bridge({ action: 'claim', protocolVersion: 1, workerId, capabilities: JOB_KINDS }),
    );
    await env.DB.prepare('UPDATE jobs SET lease_expires_at=? WHERE id=?')
      .bind(Date.now() - 1, claim.job.id)
      .run();
    expect(
      (
        await bridge({
          action: 'complete',
          protocolVersion: 1,
          workerId,
          jobId: claim.job.id,
          leaseToken: claim.job.leaseToken,
          result,
        })
      ).status,
    ).toBe(409);
    const jobs = await payload<{ jobs: AIJob[] }>(await request(`/api/projects/${p.id}/jobs`));
    expect(jobs.jobs[0].status).toBe('failed');
    const proposals = await payload<{ proposals: unknown[] }>(
      await request(`/api/projects/${p.id}/proposals`),
    );
    expect(proposals.proposals).toHaveLength(0);
  });
  it('requires the requested screen for refinements and rejects unresolved generated navigation', async () => {
    const p = (
        await payload<{ project: Project }>(
          await request('/api/projects', 'POST', { sample: true }),
        )
      ).project,
      workerId = 'helper_screen';
    await payload(
      await bridge({ action: 'claim', protocolVersion: 1, workerId, capabilities: JOB_KINDS }),
    );
    await payload(
      await request(`/api/projects/${p.id}/jobs`, 'POST', {
        kind: 'wireframe.refine',
        instruction: 'Improve the first screen',
        screenId: p.screens[0].id,
      }),
    );
    const claim = await payload<{ job: { id: string; leaseToken: string } }>(
      await bridge({ action: 'claim', protocolVersion: 1, workerId, capabilities: JOB_KINDS }),
    );
    const complete = (screens: Project['screens']) =>
      bridge({
        action: 'complete',
        protocolVersion: 1,
        workerId,
        jobId: claim.job.id,
        leaseToken: claim.job.leaseToken,
        result: { ...result, plan: null, screens },
      });
    expect((await complete([p.screens[1]])).status).toBe(400);
    const wrong = structuredClone(p.screens[0]);
    wrong.nodes[0].action = { screenId: 'missing_screen' };
    expect((await complete([wrong])).status).toBe(400);
    const collision = structuredClone(p.screens[0]);
    collision.nodes[0].id = p.screens[1].nodes[0].id;
    const rejected = await complete([collision]);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_result' });
    expect(await payload(await request(`/api/projects/${p.id}/proposals`))).toEqual({
      proposals: [],
    });
    const refined = { ...p.screens[0], description: 'Improved through the helper' };
    await payload(await complete([refined]));
    const proposals = await payload<{ proposals: { id: string }[] }>(
      await request(`/api/projects/${p.id}/proposals`),
    );
    const applied = await payload<{ project: Project }>(
      await request(`/api/projects/${p.id}/proposals/${proposals.proposals[0].id}/apply`, 'POST', {
        expectedRevision: 1,
      }),
    );
    expect(applied.project.screens[0].description).toBe(refined.description);
    expect(applied.project.screens.slice(1)).toEqual(p.screens.slice(1));
  });
  it('keeps legacy protocol-1 helpers working and exposes server lifecycle timestamps without inventing telemetry', async () => {
    const before = Date.now();
    const { lease, read } = await claimedJob('legacy_telemetry');
    const started = await read();
    expect(Date.parse(started.startedAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(started.startedAt!)).toBeLessThanOrEqual(Date.now());
    expect(started.helperVersion).toBeUndefined();
    expect(started.usage).toBeUndefined();
    expect(started.progressStage).toBeUndefined();
    expect(started.lastHeartbeatAt).toBeUndefined();
    expect(started.completedAt).toBeUndefined();
    const helper = await payload<HelperStatus>(await request('/api/helper/status'));
    expect(helper).toMatchObject({ online: true, workerId: lease.workerId, helperVersion: null });
    await payload(await bridge({ ...lease, action: 'heartbeat' }));
    const active = await read();
    expect(Date.parse(active.lastHeartbeatAt!)).toBeGreaterThanOrEqual(
      Date.parse(started.startedAt!),
    );
    await payload(await bridge({ ...lease, action: 'complete', result }));
    const completed = await read();
    expect(completed.status).toBe('completed');
    expect(Date.parse(completed.completedAt!)).toBeGreaterThanOrEqual(
      Date.parse(active.lastHeartbeatAt!),
    );
    expect(completed.usage).toBeUndefined();
    expect(completed.progressStage).toBeUndefined();
  });
  it('negotiates canvas jobs, isolates old helpers, and preserves geometry through review and apply', async () => {
    for (const kind of ['wireframe.generate', 'wireframe.refine'] as const) {
      const owner = `${kind}@canvas.test`;
      let p = await newProject(env, owner, 'Canvas contract fixture');
      p = await saveProject(
        env,
        owner,
        p,
        {
          ...p,
          assets: [
            {
              id: 'owned_photo',
              title: 'Fixture image',
              kind: 'reference',
              imageUrl: '/sample/photo.png',
              sourceUrl: '',
              note: '',
              createdAt: p.createdAt,
            },
          ],
          screens: [
            {
              id: 'canvas_frame',
              name: 'Image composition',
              platform: 'mobile',
              state: 'default',
              description: '',
              canvas: { width: 390, height: 844 },
              nodes: [
                {
                  ...createNode('image'),
                  id: 'image_layer',
                  frame: { x: 20, y: 80, width: 350, height: 500, rotation: 5 },
                  image: { assetId: 'owned_photo', fit: 'cover' },
                },
              ],
            },
          ],
        },
        p.revision,
      );
      const operate = (input: unknown) => bridgeOperation(env, owner, bridgeSchema.parse(input));
      const claim = (workerId: string, canvas: boolean) =>
        operate({
          action: 'claim',
          protocolVersion: 1,
          workerId,
          capabilities: [...JOB_KINDS, ...(canvas ? [CANVAS_CAPABILITY] : [])],
        }) as Promise<{
          protocolVersion: number;
          canvasVersion?: number;
          job: null | { id: string; leaseToken: string; context: Project };
        }>;
      expect(await claim('old_helper', false)).toEqual({ protocolVersion: 1, job: null });
      const input = {
        kind,
        instruction: 'Preserve the image composition.',
        ...(kind === 'wireframe.refine' ? { screenId: 'canvas_frame' } : {}),
      };
      await expect(enqueueJob(env, owner, p, input)).rejects.toMatchObject({
        code: 'helper_update_required',
      });
      expect((await claim('new_helper', true)).canvasVersion).toBe(1);
      expect((await helperStatus(env, owner)).capabilities).toContain(CANVAS_CAPABILITY);
      const queued = await enqueueJob(env, owner, p, input);
      const plan = await enqueueJob(env, owner, p, {
        kind: 'plan.assist',
        instruction: 'Review this plan.',
      });
      const oldClaim = await claim('old_helper', false);
      expect(oldClaim.canvasVersion).toBeUndefined();
      expect(oldClaim.job!.id).toBe(plan.id);
      await operate({
        action: 'complete',
        protocolVersion: 1,
        workerId: 'old_helper',
        jobId: plan.id,
        leaseToken: oldClaim.job!.leaseToken,
        result: { ...result, requirements: [] },
      });
      expect((await claim('old_helper', false)).job).toBeNull();
      const active = await claim('new_helper', true);
      expect(active.job!.id).toBe(queued.id);
      expect(active.job!.context).toEqual(p);
      const complete = (screens: Project['screens']) =>
        operate({
          action: 'complete',
          protocolVersion: 1,
          workerId: 'new_helper',
          jobId: queued.id,
          leaseToken: active.job!.leaseToken,
          result: { ...result, plan: null, requirements: [], screens },
        });
      const stripped = { ...p.screens[0], nodes: [] };
      delete stripped.canvas;
      await expect(complete([stripped])).rejects.toMatchObject({
        code: 'canvas_geometry_required',
      });
      const foreign = structuredClone(p.screens);
      foreign[0].nodes[0].image!.assetId = 'another_projects_asset';
      await expect(complete(foreign)).rejects.toMatchObject({ code: 'invalid_result' });
      expect((await listJobs(env, owner, p.id)).find((job) => job.id === queued.id)!.status).toBe(
        'running',
      );
      const proposed = structuredClone(p.screens);
      proposed[0].nodes[0].frame!.x = 32;
      await expect(complete(proposed)).resolves.toEqual({ ok: true });
      const proposal = (await listProposals(env, owner, p.id)).find(
        (item) => item.jobId === queued.id,
      )!;
      expect(proposal.result.screens).toEqual(proposed);
      const applied = await applyProposal(env, owner, p.id, proposal.id, p.revision);
      expect(applied.screens).toEqual(proposed);
      expect((await getProject(env, owner, p.id)).screens).toEqual(proposed);
    }
  });

  it('still lets old helpers generate and refine legacy flow screens', async () => {
    const owner = 'legacy-flow@canvas.test';
    const p = await newProject(env, owner, 'Legacy flow');
    const claim = () =>
      bridgeOperation(env, owner, {
        action: 'claim',
        protocolVersion: 1,
        workerId: 'legacy_flow',
        capabilities: [...JOB_KINDS],
      }) as Promise<{ job: { id: string; leaseToken: string } }>;
    await claim();
    const queued = await enqueueJob(env, owner, p, {
      kind: 'wireframe.generate',
      instruction: 'Create a flow screen.',
    });
    const active = await claim();
    expect(active.job.id).toBe(queued.id);
    await expect(
      bridgeOperation(env, owner, {
        action: 'complete',
        protocolVersion: 1,
        workerId: 'legacy_flow',
        jobId: queued.id,
        leaseToken: active.job.leaseToken,
        result: {
          ...result,
          plan: null,
          requirements: [],
          screens: [
            {
              id: 'legacy_screen',
              name: 'Legacy',
              platform: 'desktop',
              state: 'default',
              description: '',
              nodes: [createNode('text')],
            },
          ],
        },
      }),
    ).resolves.toEqual({ ok: true });
  });
  it('persists bounded progress, usage and helper version while resisting delayed telemetry and completion retries', async () => {
    const { lease, read } = await claimedJob('telemetry_current', '1.0.2');
    expect(await read()).toMatchObject({ helperVersion: '1.0.2' });
    expect(await payload<HelperStatus>(await request('/api/helper/status'))).toMatchObject({
      helperVersion: '1.0.2',
    });
    await payload(
      await bridge({ ...lease, action: 'heartbeat', telemetry: { stage: 'launching' } }),
    );
    const launching = await read();
    expect(launching.progressStage).toBe('launching');
    expect(launching.progressUpdatedAt).toBe(launching.lastHeartbeatAt);
    await payload(
      await bridge({
        ...lease,
        action: 'heartbeat',
        telemetry: { stage: 'model-started', usage: { inputTokens: 100, cachedInputTokens: 0 } },
      }),
    );
    const modelStarted = await read();
    expect(modelStarted).toMatchObject({
      progressStage: 'model-started',
      usage: { inputTokens: 100, cachedInputTokens: 0 },
    });
    expect(modelStarted.usage?.outputTokens).toBeUndefined();
    await payload(
      await bridge({
        ...lease,
        action: 'heartbeat',
        telemetry: { stage: 'launching', usage: { inputTokens: 10 } },
      }),
    );
    await payload(
      await bridge({ ...lease, action: 'heartbeat', telemetry: { stage: 'model-started' } }),
    );
    const delayed = await read();
    expect(delayed.progressStage).toBe('model-started');
    expect(delayed.progressUpdatedAt).toBe(modelStarted.progressUpdatedAt);
    expect(delayed.usage).toEqual(modelStarted.usage);
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 25,
      outputTokens: 64,
      reasoningOutputTokens: 12,
    };
    await payload(
      await bridge({
        ...lease,
        action: 'complete',
        result,
        telemetry: { stage: 'validating', usage },
      }),
    );
    const completed = await read();
    expect(completed).toMatchObject({ status: 'completed', progressStage: 'validating', usage });
    const heartbeat = await payload<{ cancelled: boolean }>(
      await bridge({
        ...lease,
        action: 'heartbeat',
        telemetry: { stage: 'response-received', usage: { inputTokens: 999 } },
      }),
    );
    expect(heartbeat.cancelled).toBe(true);
    await payload(
      await bridge({
        ...lease,
        action: 'complete',
        result,
        telemetry: { usage: { inputTokens: 999 } },
      }),
    );
    expect(await read()).toEqual(completed);
    const proposals = await payload<{ proposals: unknown[] }>(
      await request(`/api/projects/${completed.projectId}/proposals`),
    );
    expect(proposals.proposals).toHaveLength(1);
  });
  it('scopes telemetry to the active owner, helper and lease and rejects raw or client-timestamp metadata', async () => {
    const { lease, read } = await claimedJob('telemetry_scope', '1.0.2');
    const before = await read();
    const telemetry = { stage: 'validating' as const, usage: { inputTokens: 999 } };
    for (const wrong of [{ workerId: 'wrong_worker' }, { leaseToken: 'wrong_lease' }]) {
      expect(
        await payload(await bridge({ ...lease, ...wrong, action: 'heartbeat', telemetry })),
      ).toMatchObject({ cancelled: true });
      expect(
        (await bridge({ ...lease, ...wrong, action: 'complete', result, telemetry })).status,
      ).toBe(409);
    }
    expect(
      await bridgeOperation(env, 'another-owner@example.com', {
        ...lease,
        action: 'heartbeat',
        telemetry,
      }),
    ).toMatchObject({ cancelled: true });
    await expect(
      bridgeOperation(env, 'another-owner@example.com', {
        ...lease,
        action: 'complete',
        result,
        telemetry,
      }),
    ).rejects.toThrow(/lease expired/);
    for (const invalid of [
      {},
      { stage: 'thinking' },
      { stage: 'launching', raw: 'private output' },
      { usage: {} },
      { usage: { inputTokens: -1 } },
      { usage: { outputTokens: 1.5 } },
      { usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1 } },
      { usage: { prompt: 'private prompt' } },
      { stage: 'launching', progressUpdatedAt: '2000-01-01T00:00:00.000Z' },
    ]) {
      expect((await bridge({ ...lease, action: 'heartbeat', telemetry: invalid })).status).toBe(
        400,
      );
      expect(
        (await bridge({ ...lease, action: 'complete', result, telemetry: invalid })).status,
      ).toBe(400);
    }
    expect(
      (await bridge({ ...lease, action: 'heartbeat', lastHeartbeatAt: '2000-01-01T00:00:00.000Z' }))
        .status,
    ).toBe(400);
    expect(await read()).toEqual(before);
    await payload(
      await bridge({
        ...lease,
        action: 'complete',
        error: 'The helper could not finish this task.',
        telemetry: { stage: 'model-started', usage: { inputTokens: Number.MAX_SAFE_INTEGER } },
      }),
    );
    const failed = await read();
    expect(failed).toMatchObject({
      status: 'failed',
      progressStage: 'model-started',
      usage: { inputTokens: Number.MAX_SAFE_INTEGER },
    });
    expect(failed.completedAt).toBeDefined();
    await payload(
      await bridge({
        ...lease,
        action: 'complete',
        error: 'Retry',
        telemetry: { stage: 'validating' },
      }),
    );
    expect(await read()).toEqual(failed);
  });
  it('stamps cancellation and expiry once, preserving prior progress against late heartbeat or completion', async () => {
    for (const terminal of ['cancel', 'lease-expiry', 'runtime-expiry'] as const) {
      const { p, lease, read } = await claimedJob(
        `telemetry_${terminal.replaceAll('-', '_')}`,
        '1.0.2',
      );
      await payload(
        await bridge({
          ...lease,
          action: 'heartbeat',
          telemetry: { stage: 'model-started', usage: { inputTokens: 12 } },
        }),
      );
      const active = await read();
      if (terminal === 'cancel')
        await payload(await request(`/api/projects/${p.id}/jobs/${lease.jobId}`, 'DELETE'));
      else if (terminal === 'lease-expiry')
        await env.DB.prepare('UPDATE jobs SET lease_expires_at=? WHERE id=?')
          .bind(Date.now() - 1, lease.jobId)
          .run();
      else
        await env.DB.prepare('UPDATE jobs SET started_at=? WHERE id=?')
          .bind(Date.now() - 600001, lease.jobId)
          .run();
      const completed = await read();
      expect(completed.status).toBe(terminal === 'cancel' ? 'cancelled' : 'failed');
      expect(completed.completedAt).toBeDefined();
      expect(completed.progressUpdatedAt).toBe(active.progressUpdatedAt);
      const late = { ...lease, telemetry: { stage: 'validating', usage: { inputTokens: 999 } } };
      expect(await payload(await bridge({ ...late, action: 'heartbeat' }))).toMatchObject({
        cancelled: true,
      });
      expect((await bridge({ ...late, action: 'complete', result })).status).toBe(409);
      expect(await read()).toEqual(completed);
    }
  });
});
