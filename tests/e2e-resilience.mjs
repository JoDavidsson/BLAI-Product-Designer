import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = process.env.BLAI_TEST_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 1512, height: 982 },
  acceptDownloads: true,
});
let id, secondId;
const errors = [];
async function get() {
  return (await (await context.request.get(`${base}/api/projects/${id}`)).json()).project;
}
async function until(check, description) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + description);
}
try {
  const created = await context.request.post(base + '/api/projects', { data: { sample: true } });
  assert.equal(created.status(), 201);
  const original = (await created.json()).project;
  id = original.id;
  const second = await context.request.post(base + '/api/projects', {
    data: { title: 'Checkpoint transition test' },
  });
  assert.equal(second.status(), 201);
  secondId = (await second.json()).project.id;
  await context.addInitScript((id) => localStorage.setItem('blai-project', id), id);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel('Project title', { exact: true }).waitFor();

  // Undo must survive an older save response arriving after the user's undo.
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const saving = new Promise((resolve) => {
    started = resolve;
  });
  let held = false;
  await page.route(`**/api/projects/${id}`, async (route) => {
    if (route.request().method() === 'PUT' && !held) {
      held = true;
      started();
      await gate;
    }
    await route.continue();
  });
  await page
    .getByLabel('Problem & opportunity', { exact: true })
    .fill('A deliberate edit whose older save response arrives after undo.');
  await saving;
  await page.getByRole('button', { name: 'Undo last edit', exact: true }).click();
  release();
  await until(
    async () =>
      (await get()).revision >= original.revision + 2 &&
      (await get()).plan.problem === original.plan.problem,
    'in-flight save cannot overwrite undo',
  );
  await page.unroute(`**/api/projects/${id}`);

  // A second tab's revision is never overwritten. Local work can be downloaded
  // before deliberately reloading the saved revision.
  const prior = await get();
  const remote = { ...prior, title: 'Changed in another tab' };
  assert.equal(
    (
      await context.request.put(`${base}/api/projects/${id}`, {
        data: { project: remote, expectedRevision: prior.revision },
      })
    ).status(),
    200,
  );
  const unsaved =
    'Keep this local text in a downloadable copy while another tab owns the newer revision.';
  await page.getByLabel('Problem & opportunity', { exact: true }).fill(unsaved);
  await page.getByRole('button', { name: 'Download unsaved copy', exact: true }).waitFor();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download unsaved copy', exact: true }).click();
  const draft = JSON.parse(await fs.readFile(await (await downloaded).path(), 'utf8'));
  assert.equal(draft.plan.problem, unsaved);
  assert.equal((await get()).title, remote.title);
  assert.equal((await get()).plan.problem, original.plan.problem);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Reload saved version', exact: true }).click();
  assert.equal(
    await page.getByLabel('Problem & opportunity', { exact: true }).inputValue(),
    unsaved,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reload saved version', exact: true }).click();
  await until(
    async () =>
      (await page.getByLabel('Project title', { exact: true }).inputValue()) === remote.title,
    'reload newer saved version',
  );
  assert.equal(await page.locator('.save-error').count(), 0);
  assert.equal(
    await page.getByRole('button', { name: 'Undo last edit', exact: true }).isDisabled(),
    true,
  );

  // Checkpoint responses from the previous project must not open a stale modal
  // while the next project's fetch is still in flight.
  let releaseVersions, versionsStarted, releaseProject, projectStarted;
  const versionsGate = new Promise((resolve) => {
    releaseVersions = resolve;
  });
  const versionsRequested = new Promise((resolve) => {
    versionsStarted = resolve;
  });
  const projectGate = new Promise((resolve) => {
    releaseProject = resolve;
  });
  const projectRequested = new Promise((resolve) => {
    projectStarted = resolve;
  });
  await page.route(`**/api/projects/${id}/versions`, async (route) => {
    const response = await route.fetch();
    versionsStarted();
    await versionsGate;
    await route.fulfill({ response });
  });
  await page.route(`**/api/projects/${secondId}`, async (route) => {
    projectStarted();
    await projectGate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Project checkpoints', exact: true }).click();
  await versionsRequested;
  await page.getByLabel('Current project', { exact: true }).selectOption(secondId);
  await projectRequested;
  const oldResponse = page.waitForResponse(`**/api/projects/${id}/versions`);
  releaseVersions();
  await oldResponse;
  // Allow the old response handler to run while the project transition is pending.
  await page.waitForTimeout(100);
  releaseProject();
  await until(
    async () =>
      (await page.getByLabel('Project title', { exact: true }).inputValue()) ===
      'Checkpoint transition test',
    'second project loaded',
  );
  assert.equal(
    await page.locator('.modal[role="dialog"]').count(),
    0,
    'stale checkpoints must not open over the new project',
  );
  await page.unroute(`**/api/projects/${id}/versions`);
  await page.unroute(`**/api/projects/${secondId}`);
  await page.getByLabel('Current project', { exact: true }).selectOption(id);
  await until(
    async () =>
      (await page.getByLabel('Project title', { exact: true }).inputValue()) === remote.title,
    'return to test project',
  );

  // A background image transfer must not be accepted into a snapshot that is
  // currently being replaced by a checkpoint restore.
  const checkpoint = await context.request.post(`${base}/api/projects/${id}/versions`, {
    data: { label: 'Before delayed image' },
  });
  assert.equal(checkpoint.status(), 201);
  const version = (await checkpoint.json()).version;
  await page.getByRole('button', { name: 'Moodboard', exact: true }).click();
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext('2d').fillRect(0, 0, 32, 32);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  let releaseUpload, uploadStarted, releaseRestore, restoreStarted;
  const uploadGate = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const uploadReady = new Promise((resolve) => {
    uploadStarted = resolve;
  });
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const restoreReady = new Promise((resolve) => {
    restoreStarted = resolve;
  });
  await page.route(`**/api/projects/${id}/assets`, async (route) => {
    const response = await route.fetch();
    uploadStarted();
    await uploadGate;
    await route.fulfill({ response });
  });
  await page.route(`**/api/projects/${id}/versions/${version.id}/restore`, async (route) => {
    const response = await route.fetch();
    restoreStarted();
    await restoreGate;
    await route.fulfill({ response });
  });
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'Late during restore.png', mimeType: 'image/png', buffer: png });
  await uploadReady;
  await page.getByRole('button', { name: 'Project checkpoints', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .locator('.version-row')
    .filter({ hasText: 'Before delayed image' })
    .getByRole('button', { name: 'Restore', exact: true })
    .click();
  await restoreReady;
  releaseUpload();
  await page
    .getByRole('alert', { includeHidden: true })
    .filter({ hasText: 'The active project changed. This image was not added to the board.' })
    .waitFor({ state: 'attached' });
  releaseRestore();
  await page.locator('.modal[role="dialog"]').waitFor({ state: 'detached' });
  assert.equal(
    (await get()).assets.some((asset) => asset.title === 'Late during restore'),
    false,
  );
  await page.unroute(`**/api/projects/${id}/assets`);
  await page.unroute(`**/api/projects/${id}/versions/${version.id}/restore`);
  await page.getByRole('button', { name: 'Close add reference', exact: true }).click();
  await page.getByRole('button', { name: 'Product plan', exact: true }).click();

  // Read-only AI proposal fixtures validate review rendering without simulating
  // a connected helper or applying fake AI results to the project.
  const current = await get();
  const result = {
    title: 'Review palette',
    summary: 'Change the accent',
    reply: '',
    plan: null,
    screens: null,
    design: { ...current.design, accent: '#123abc', radius: 24 },
    requirements: [{ text: 'A visible keyboard focus indicator.' }],
  };
  const proposal = {
    id: 'fixture_palette',
    projectId: id,
    jobId: 'fixture_job',
    kind: 'moodboard.direction',
    status: 'pending',
    baseRevision: current.revision,
    createdAt: current.updatedAt,
    result,
  };
  const plan = {
    ...proposal,
    id: 'fixture_plan',
    kind: 'plan.assist',
    result: {
      ...result,
      title: 'Review plan',
      design: null,
      requirements: [],
      plan: { problem: 'A clearer, proposed problem statement for the product.' },
    },
  };
  const screens = {
    ...proposal,
    id: 'fixture_screens',
    kind: 'wireframe.generate',
    result: {
      ...result,
      title: 'Review screens',
      screens: [
        ...current.screens,
        {
          id: 'fixture_canvas_preview',
          name: 'Freeform proposal',
          platform: 'mobile',
          state: 'default',
          description: 'Review spatial changes before applying.',
          canvas: { width: 390, height: 720 },
          nodes: [
            {
              id: 'fixture_preview_shape',
              type: 'rectangle',
              name: 'Rotated card',
              text: '',
              children: [],
              style: { background: '#123abc' },
              frame: { x: 40, y: 80, width: 260, height: 400, rotation: 12 },
            },
          ],
        },
      ],
    },
  };
  const stale = {
    ...proposal,
    id: 'fixture_stale',
    baseRevision: current.revision - 1,
    result: { ...result, title: 'Old proposal' },
  };
  await page.route(`**/api/projects/${id}/proposals`, (route) =>
    route.fulfill({ json: { proposals: [proposal, plan, screens, stale] } }),
  );
  await until(
    async () => (await page.locator('.count-pill').textContent()) === '4',
    'proposal fixtures loaded',
  );
  await page.getByRole('button', { name: /^Proposals/ }).click();
  await page.getByRole('heading', { name: 'Design changes', exact: true }).waitFor();
  assert.ok((await page.locator('.proposal-design-changes').innerText()).includes('#123abc'));
  assert.ok(
    (await page.locator('.proposal-design-changes').innerText()).includes(current.design.accent),
  );
  await page
    .getByText('Applying this proposal accepts these requirements.', { exact: true })
    .waitFor();
  await page.locator('.proposal-list button').filter({ hasText: 'Review plan' }).click();
  const comparison = await page.locator('.comparison-columns').innerText();
  assert.ok(comparison.includes(current.plan.problem));
  assert.ok(comparison.includes(plan.result.plan.problem));
  await page.locator('.proposal-list button').filter({ hasText: 'Review screens' }).click();
  assert.ok(
    (await page.locator('.proposal-screen-changes').innerText()).includes(
      `Replace ${current.screens.length} existing screens`,
    ),
  );
  await page.locator('.proposal-screen-changes summary').first().click();
  assert.ok(await page.locator('.proposal-structure').first().isVisible());
  await page
    .locator('.proposal-screen-changes summary')
    .filter({ hasText: 'Freeform proposal' })
    .click();
  const preview = page.getByRole('img', { name: 'Proposed design for Freeform proposal' });
  await preview.waitFor({ state: 'visible' });
  assert.equal(await preview.locator('[inert]').count(), 1, 'Proposal canvas is read-only');
  assert.equal(
    await preview
      .locator('[data-node-id="fixture_preview_shape"]')
      .evaluate((element) => element.style.transform),
    'rotate(12deg)',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await until(
    async () =>
      preview.evaluate((element) => {
        const frame = element.querySelector('.freeform-canvas').getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return frame.width <= bounds.width + 1;
      }),
    'Canvas proposal preview fits narrow review panel',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.proposal-list button').filter({ hasText: 'Old proposal' }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Apply changes', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.unroute(`**/api/projects/${id}/proposals`);
  assert.equal((await get()).revision, current.revision, 'reviewing a proposal is read-only');
  assert.deepEqual(errors, []);
  console.log(
    'Resilience browser checks passed: in-flight undo, revision conflict/export/reload, proposal plan/design/component review, stale proposal guard.',
  );
} finally {
  if (secondId)
    await context.request.delete(`${base}/api/projects/${secondId}`).catch(() => undefined);
  if (id) await context.request.delete(`${base}/api/projects/${id}`).catch(() => undefined);
  await browser.close();
}
