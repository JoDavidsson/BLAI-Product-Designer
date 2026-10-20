import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createProject } from '../shared/model.ts';

// Every API route is mocked: this checks the user's request lifecycle without
// creating projects, contacting a helper, or consuming any model tokens.
const base = process.env.BLAI_TEST_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
const page = await context.newPage();
page.setDefaultTimeout(12_000);
let project = createProject('AI activity browser verification');
let jobs = [];
let proposals = [];
const errors = [];
const cancellations = [];
let finishDuringCancellation = false;
const unexpected = [];
page.on('pageerror', (error) => errors.push(error.message));
await context.addInitScript((id) => localStorage.setItem('blai-project', id), project.id);
await page.route('**/api/**', async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  const method = request.method();
  const reply = (json, status = 200) => route.fulfill({ status, json });
  if (pathname === '/api/session')
    return reply({ email: 'local@example.test', local: true, githubConfigured: false });
  if (pathname === '/api/projects')
    return reply({
      projects: [{ id: project.id, title: project.title, updatedAt: project.updatedAt }],
    });
  if (pathname === '/api/helper/status')
    return reply({
      online: true,
      lastSeen: new Date().toISOString(),
      workerId: 'fixture-helper',
      protocolVersion: 1,
      capabilities: ['wireframe.generate'],
      imageGeneration: false,
      helperVersion: '1.0.2',
    });
  if (pathname === `/api/projects/${project.id}`) {
    if (method === 'PUT')
      project = {
        ...request.postDataJSON().project,
        revision: project.revision + 1,
        updatedAt: new Date().toISOString(),
      };
    return reply({ project });
  }
  if (pathname === `/api/projects/${project.id}/jobs`) {
    if (method === 'POST') {
      const input = request.postDataJSON();
      const job = {
        id: 'job_activity',
        projectId: project.id,
        kind: input.kind,
        instruction: input.instruction,
        status: 'queued',
        createdAt: new Date().toISOString(),
        baseRevision: project.revision,
      };
      jobs = [job];
      return reply({ job }, 201);
    }
    return reply({ jobs });
  }
  if (pathname === `/api/projects/${project.id}/proposals`) return reply({ proposals });
  if (method === 'DELETE' && pathname.startsWith(`/api/projects/${project.id}/jobs/`)) {
    const id = pathname.split('/').at(-1);
    cancellations.push(id);
    jobs = jobs.map((job) =>
      job.id === id
        ? {
            ...job,
            status: finishDuringCancellation ? 'completed' : 'cancelled',
            completedAt: new Date().toISOString(),
          }
        : job,
    );
    return reply({ ok: true });
  }
  unexpected.push(`${method} ${pathname}`);
  return reply({ error: 'Unexpected mocked request' }, 500);
});
const activity = page.getByRole('region', { name: 'AI request activity' });
const details = () => page.locator('#ai-activity-details');
const setJob = (changes) => {
  jobs = [{ ...jobs[0], ...changes }];
};
try {
  await page.goto(base);
  await page.getByLabel('Project title', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Wireframes', exact: true }).click();
  await page.getByRole('button', { name: 'Generate from plan', exact: true }).click();
  await page.getByRole('button', { name: 'Create a first draft', exact: true }).click();
  await expect(activity).toContainText('Waiting for helper');
  await expect(page.locator('.view-wireframes')).toBeVisible();
  assert.equal(jobs[0].kind, 'wireframe.generate');
  await activity.getByRole('button', { name: 'Show AI request activity', exact: true }).click();
  await expect(details()).toContainText('Token usage has not been reported yet.');

  setJob({
    status: 'running',
    startedAt: new Date(Date.now() - 70_000).toISOString(),
    helperVersion: '1.0.2',
  });
  await expect(details()).toContainText('Helper accepted request');
  await expect(details()).toContainText('Waiting for first helper check-in');
  await expect(details()).toContainText(/Elapsed 1m/);
  await expect(details()).not.toContainText('thinking');
  setJob({ progressStage: 'launching', lastHeartbeatAt: new Date().toISOString() });
  await expect(activity.locator('.ai-activity-summary')).toContainText('Starting Codex');
  setJob({
    progressStage: 'model-started',
    lastHeartbeatAt: new Date(Date.now() - 45_000).toISOString(),
  });
  await expect(activity.locator('.ai-activity-summary')).toContainText('Codex started');
  await expect(details()).toContainText('The helper has not checked in recently.');
  setJob({
    progressStage: 'response-received',
    lastHeartbeatAt: new Date().toISOString(),
    usage: {
      inputTokens: 12345,
      cachedInputTokens: 4000,
      outputTokens: 678,
      reasoningOutputTokens: 0,
    },
  });
  await expect(activity.locator('.ai-activity-summary')).toContainText('Response received');
  await expect(details().locator('dd').nth(0)).toHaveText('12,345');
  await expect(details().locator('dd').nth(1)).toHaveText('678');
  await expect(details().locator('dd').nth(3)).toHaveText('Not reported');
  await expect(details().locator('dd').nth(4)).toHaveText('0');
  setJob({ progressStage: 'validating' });
  await expect(activity.locator('.ai-activity-summary')).toContainText('Checking result');

  setJob({ status: 'completed', completedAt: new Date().toISOString() });
  const result = {
    title: 'The wireframe result for this request',
    summary: 'A complete draft is ready to review.',
    reply: 'Review the proposed draft.',
    plan: null,
    screens: null,
    design: null,
    requirements: [],
  };
  proposals = [
    {
      id: 'proposal_other',
      jobId: 'job_other',
      projectId: project.id,
      kind: 'plan.assist',
      status: 'pending',
      baseRevision: project.revision,
      createdAt: new Date().toISOString(),
      result: { ...result, title: 'A different proposal' },
    },
    {
      id: 'proposal_activity',
      jobId: jobs[0].id,
      projectId: project.id,
      kind: jobs[0].kind,
      status: 'pending',
      baseRevision: project.revision,
      createdAt: new Date().toISOString(),
      result,
    },
  ];
  await expect(activity.locator('.ai-activity-summary')).toContainText('Ready to review');
  await page.screenshot({ path: '/tmp/blai-ai-activity.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/blai-ai-activity-mobile.png' });
  await page.setViewportSize({ width: 1512, height: 982 });
  await activity.locator('.ai-activity-review').click();
  await expect(page.locator('.proposal-detail h3')).toHaveText(result.title);
  await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.locator('.view-wireframes')).toBeVisible();

  // Historical helpers did not report usage: absent counts must stay unknown.
  proposals = [];
  setJob({
    id: 'job_legacy',
    createdAt: new Date().toISOString(),
    usage: undefined,
    helperVersion: undefined,
    completedAt: undefined,
    progressStage: undefined,
  });
  await activity.getByRole('button', { name: 'Show AI request activity', exact: true }).click();
  await expect(details()).toContainText('Token usage was not reported for this request.');
  await expect(details()).toContainText('Update to Helper 1.0.2');
  await expect(details().locator('time')).toContainText('Requested');
  await expect(details().locator('dd')).toHaveCount(0);

  setJob({
    id: 'job_failed',
    status: 'failed',
    error: 'invalid',
    helperVersion: '1.0.2',
    completedAt: new Date().toISOString(),
  });
  await expect(details()).toContainText(
    'Codex returned a result Designer could not use. Try a smaller, more focused request.',
  );
  await expect(page.locator('.toast')).toContainText(
    'Codex returned a result Designer could not use.',
  );
  await expect(details()).not.toContainText('Update to Helper');

  const savedBeforeFailures = structuredClone(project);
  for (const [error, message] of [
    ['timeout', 'Codex reached the request’s time limit before finishing.'],
    ['runtime_timeout', 'This request reached the server’s time limit.'],
    ['helper_disconnected', 'The helper stopped checking in.'],
    ['queue_timeout', 'This request waited too long for an available helper.'],
  ]) {
    setJob({
      id: `job_${error}`,
      error,
      helperVersion: '1.1.1',
      progressStage: 'response-received',
    });
    await expect(details()).toContainText(message);
    await expect(details()).toContainText('Last reported stage: Response received');
    await expect(details()).toContainText('Helper v1.1.1');
    await expect(details()).not.toContainText('Ready to review');
  }
  assert.deepEqual(project, savedBeforeFailures);

  setJob({
    id: 'job_cancel',
    status: 'queued',
    error: undefined,
    completedAt: undefined,
    progressStage: undefined,
  });
  await expect(details()).toContainText('Waiting for helper');
  await details().getByRole('button', { name: 'Cancel request', exact: true }).click();
  await expect(details()).toContainText('Request cancelled');
  assert.deepEqual(cancellations, ['job_cancel']);
  // Cancellation can arrive after completion. Read back server state instead
  // of inventing a cancellation or a browser-side terminal timestamp.
  finishDuringCancellation = true;
  setJob({ id: 'job_cancel_race', status: 'queued', completedAt: undefined });
  await expect(details()).toContainText('Waiting for helper');
  await details().getByRole('button', { name: 'Cancel request', exact: true }).click();
  await expect(details()).toContainText('Request completed');
  await expect(details()).not.toContainText('Request cancelled');
  assert.deepEqual(cancellations, ['job_cancel', 'job_cancel_race']);
  await activity.getByRole('button', { name: 'Close AI request activity', exact: true }).click();
  await page.getByRole('button', { name: 'Product plan', exact: true }).click();
  await expect(activity).toContainText('Request completed');

  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Download BLAI Helper 1.1.1', exact: true }),
  ).toHaveAttribute('download', 'blai-helper-1.1.1.tar.gz');
  await page.setViewportSize({ width: 390, height: 844 });
  await activity.getByRole('button', { name: 'Show AI request activity', exact: true }).click();
  const bounds = await details().boundingBox();
  assert.ok(
    bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390,
    'activity remains within the mobile viewport',
  );
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    'AI activity browser checks passed: queued, claimed, stages, heartbeat, real usage, unknown usage, correct proposal review, failure, cancellation, and mobile layout.',
  );
} finally {
  await browser.close();
}
