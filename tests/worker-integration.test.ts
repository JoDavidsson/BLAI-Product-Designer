import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleRequest } from '../worker/index';
import { getProject, newProject } from '../worker/projects';
import { JOB_KINDS, type AIJob, type AIResult, type Project } from '../shared/model';
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
        d1Databases: ['DB'],
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
    const migration = await readFile(
      new URL('../migrations/0001_initial.sql', import.meta.url),
      'utf8',
    );
    await env.DB.batch(
      migration
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((sql) => env.DB.prepare(sql)),
    );
  }, 30000);
  afterAll(async () => {
    await mf?.dispose();
    if (registryPath) await rm(registryPath, { recursive: true, force: true });
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
});
