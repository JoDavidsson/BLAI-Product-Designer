import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { unzipSync } from 'fflate';

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
const ids = [];
const errors = [];
async function create(title) {
  const response = await context.request.post(base + '/api/projects', { data: { sample: true } });
  assert.equal(response.status(), 201);
  const { project } = await response.json();
  ids.push(project.id);
  const saved = await context.request.put(`${base}/api/projects/${project.id}`, {
    data: { project: { ...project, title }, expectedRevision: project.revision },
  });
  assert.equal(saved.status(), 200);
  return (await saved.json()).project;
}
async function get(id) {
  return (await (await context.request.get(`${base}/api/projects/${id}`)).json()).project;
}
async function until(check, description) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + description);
}
try {
  const a = await create('App test A');
  const b = await create('App test B');
  await context.addInitScript((id) => localStorage.setItem('blai-project', id), a.id);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel('Project title', { exact: true }).waitFor();
  const problem =
    'Edited in the browser: keep product decisions connected and preserve every saved change.';
  await page.getByLabel('Problem & opportunity', { exact: true }).fill(problem);
  await until(async () => (await get(a.id)).plan.problem === problem, 'plan autosave');

  let releaseLoad;
  let enteredLoad;
  const loadStarted = new Promise((resolve) => {
    enteredLoad = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  await page.route(`**/api/projects/${b.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    enteredLoad();
    await gate;
    await route.continue();
  });
  await page.getByLabel('Current project', { exact: true }).selectOption(b.id);
  await loadStarted;
  await until(
    () => page.locator('.studio-body').evaluate((element) => element.inert),
    'project transition locked',
  );
  assert.equal(await page.locator('.sidebar').evaluate((element) => element.inert), true);
  releaseLoad();
  await until(
    async () => (await page.getByLabel('Project title', { exact: true }).inputValue()) === b.title,
    'new project loaded',
  );
  assert.equal((await get(a.id)).plan.problem, problem);
  await page.unroute(`**/api/projects/${b.id}`);

  await page.getByRole('button', { name: 'Project checkpoints', exact: true }).click();
  await page.getByLabel('Checkpoint name').fill('Before exploration');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Before exploration', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const previousPromise = b.plan.value;
  await page
    .getByLabel('Product promise', { exact: true })
    .fill('A new direction we will deliberately restore from a named checkpoint.');
  await until(async () => (await get(b.id)).plan.value !== previousPromise, 'changed plan saved');
  await page.getByRole('button', { name: 'Project checkpoints', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .locator('.version-row')
    .filter({ hasText: 'Before exploration' })
    .getByRole('button', { name: 'Restore', exact: true })
    .click();
  await until(
    async () =>
      (await page.getByLabel('Product promise', { exact: true }).inputValue()) === previousPromise,
    'checkpoint restore',
  );

  await page.getByRole('button', { name: 'Handoff', exact: true }).click();
  await page.getByRole('button', { name: 'Mark requirement proposed', exact: true }).click();
  await until(async () => {
    const p = await get(b.id);
    return p.requirements[0].status === 'proposed' && p.comments[0].status === 'open';
  }, 'linked decisions synchronize on revoke');
  await page.getByRole('button', { name: 'Accept requirement', exact: true }).click();
  await until(async () => {
    const p = await get(b.id);
    return p.requirements[0].status === 'accepted' && p.comments[0].status === 'accepted';
  }, 'linked decisions synchronize on accept');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download specification', exact: true }).click();
  const download = await downloaded;
  const zip = unzipSync(await fs.readFile(await download.path()));
  const names = Object.keys(zip);
  assert.ok(names.some((name) => name.endsWith('.md')));
  assert.ok(names.some((name) => name.endsWith('.svg')));
  assert.ok(names.includes('project.json'));
  const exported = JSON.parse(new TextDecoder().decode(zip['project.json']));
  assert.equal(exported.id, b.id);
  assert.equal(exported.plan.value, previousPromise);
  await page.getByRole('button', { name: 'Save to GitHub', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Commit specification', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Browser-created project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await until(
    async () =>
      (await page.getByLabel('Project title', { exact: true }).inputValue()) ===
      'Browser-created project',
    'create project form',
  );
  const newId = await page.evaluate(() => localStorage.getItem('blai-project'));
  ids.push(newId);
  assert.equal((await get(newId)).screens.length, 0);
  await page.getByLabel('Message Codex', { exact: true }).fill('Help me define the audience.');
  await page.getByRole('button', { name: 'Send to Codex', exact: true }).click();
  await page.getByRole('heading', { name: 'Codex Helper', exact: true }).waitFor();
  assert.equal((await get(newId)).chat.length, 0, 'offline helper must not fabricate a reply');
  await page.getByRole('button', { name: 'Product plan', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1),
    'mobile planner should fit viewport',
  );
  assert.deepEqual(errors, []);
  console.log(
    'App browser checks passed: autosave, guarded project switching, checkpoints/restore, consistent decisions, ZIP download, GitHub setup state, new project, offline AI, mobile layout.',
  );
} finally {
  for (const id of ids)
    await context.request.delete(`${base}/api/projects/${id}`).catch(() => undefined);
  await browser.close();
}
