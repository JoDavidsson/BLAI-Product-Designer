import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

// Uses disposable projects against an already-started local Vite/Worker server.
const baseURL = process.env.BLAI_TEST_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || process.env.BLAI_CHROMIUM || '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 1512, height: 982 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const ids = [];
const errors = [];
const externalRequests = [];
const mutations = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (request.url().includes('pele-test.invalid')) externalRequests.push(request.url());
  if (/\/api\//.test(request.url()) && !['GET', 'HEAD'].includes(request.method()))
    mutations.push({ method: request.method(), url: request.url() });
});
await page.route('https://pele-test.invalid/**', (route) => route.abort());

async function create(title, sample = false) {
  const response = await context.request.post(`${baseURL}/api/projects`, {
    data: { title, sample },
  });
  assert.equal(response.status(), 201, await response.text());
  const project = (await response.json()).project;
  ids.push(project.id);
  return project;
}
async function read(id) {
  const response = await context.request.get(`${baseURL}/api/projects/${id}`);
  assert.equal(response.status(), 200);
  return (await response.json()).project;
}
async function save(project) {
  const response = await context.request.put(`${baseURL}/api/projects/${project.id}`, {
    data: { project, expectedRevision: project.revision },
  });
  assert.equal(response.status(), 200, await response.text());
  return (await response.json()).project;
}
async function openOverview() {
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your product, at a glance.' })).toBeVisible();
}
async function ready() {
  await expect(page.locator('.overview-render-status')).toHaveText('Overview ready');
  await expect(page.locator('.overview-svg > svg')).toBeVisible();
  await expect(page.locator('.overview-workspace textarea')).toHaveCount(0);
  await expect(page.locator('.overview-workspace [contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByLabel('Diagram name', { exact: true })).toHaveCount(0);
  await expect(page.locator('.overview-svg .pele-zoom')).toHaveCount(1);
}
async function inspect(id) {
  await page.getByLabel('Inspect overview item', { exact: true }).selectOption(id);
}
async function sourceCard(body) {
  const card = page.locator('.overview-source-card').filter({ hasText: body }).first();
  if ((await card.getAttribute('open')) === null) await card.locator('summary').click();
  return card;
}
async function zoom() {
  const svg = page.locator('.overview-svg > svg');
  const original = await svg.getAttribute('viewBox');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(svg).not.toHaveAttribute('viewBox', original);
  await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
  await expect(svg).toHaveAttribute('viewBox', original);
  await svg.focus();
  await svg.press('+');
  await expect(svg).not.toHaveAttribute('viewBox', original);
  await svg.press('0');
  await expect(svg).toHaveAttribute('viewBox', original);
}

try {
  let project = await create('Overview browser verification', true);
  const blank = await create('Blank overview verification');
  const hostile =
    '<img src="https://pele-test.invalid/label.png" onerror="window.__peleInjected=true"> & </text><script>window.__peleInjected=true</script> [unfinished';
  project.plan.problem = hostile;
  project.plan.journeys =
    '1. Choose a destination.\n2. Save places for the trip.\n3. Open the itinerary on your phone.';
  project.requirements.push({
    id: 'req_overview_proposed',
    text: 'Consider adding a shared packing list.',
    status: 'proposed',
  });
  project.comments.push({
    id: 'comment_overview_resolved',
    body: 'The empty state wording has been reviewed.',
    target: { kind: 'screen', screenId: project.screens[2].id, x: 0.5, y: 0.5 },
    status: 'resolved',
    replies: [],
    createdAt: project.createdAt,
  });
  project.assets.push({
    id: 'asset_overview_reference',
    title: 'Quiet travel reference',
    kind: 'reference',
    imageUrl: '',
    sourceUrl: '',
    note: 'A calm palette and generous space for the itinerary.',
    createdAt: project.createdAt,
  });
  project.chat.push({
    id: 'chat_overview_context',
    role: 'user',
    text: 'Keep travel planning simple and connected.',
    createdAt: project.createdAt,
  });
  // Previous experimental data remains preserved, but never becomes an editable diagram.
  project.diagrams = [
    {
      id: 'diagram_legacy_draft',
      title: 'Legacy draft',
      kind: 'flowchart',
      source: 'flowchart LR\n  A["unfinished',
    },
  ];
  project = await save(project);
  await context.addInitScript((id) => {
    localStorage.setItem('blai-project', id);
    window.__peleInjected = false;
  }, project.id);
  await page.goto(baseURL);
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(project.id);
  await openOverview();
  await expect(
    page.getByRole('heading', { name: 'Turn your thinking into a picture.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Visualize product', exact: true }).click();
  await ready();
  await expect(page.locator('.overview-map')).toContainText(project.title);
  await expect(page.getByLabel('Included project material')).toContainText('3 screens');
  await expect(page.getByLabel('Included project material')).toContainText('2 requirements');
  await expect(page.getByLabel('Included project material')).toContainText('2 comments');
  await zoom();

  // Actual SVG nodes support pointer and keyboard selection, without authoring syntax.
  await page.getByRole('button', { name: 'Inspect Purpose & people', exact: true }).click();
  await expect(page.getByLabel('Inspect overview item')).toHaveValue('plan_purpose');
  await expect(page.getByLabel('Overview source details')).toContainText(hostile);
  await page.getByRole('button', { name: 'Inspect Scope & boundaries', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Inspect overview item')).toHaveValue('plan_scope');
  await page.getByRole('button', { name: 'Inspect Purpose & people', exact: true }).focus();
  await page.keyboard.press(' ');
  await expect(page.getByLabel('Inspect overview item')).toHaveValue('plan_purpose');
  await (await sourceCard(hostile)).getByRole('button', { name: 'Open plan section' }).click();
  await expect(page.locator('#plan-problem')).toBeFocused();
  await expect(page.getByLabel('Problem & opportunity', { exact: true })).toHaveValue(hostile);
  // The plan's shortcut directly visualizes the current project.
  await page.getByRole('button', { name: 'Visualize product', exact: true }).click();
  await ready();

  await page.getByRole('button', { name: 'Written journey', exact: true }).click();
  await ready();
  await expect(page.locator('.overview-svg .pele-node')).toHaveCount(4);
  await expect(page.locator('.overview-svg')).toContainText('Choose a destination.');
  await expect(page.locator('.overview-svg')).toContainText('Save places for the trip.');
  await inspect('journey_0_2');
  await expect(page.getByLabel('Overview source details')).toContainText(
    'Open the itinerary on your phone.',
  );
  await expect(page.locator('.overview-svg .pele-edge')).toHaveCount(2);
  await zoom();

  await page.getByRole('button', { name: 'Screen connections', exact: true }).click();
  await ready();
  await expect(page.locator('.overview-svg .pele-node')).toHaveCount(project.screens.length);
  await expect(page.locator('.overview-svg .pele-edge')).toHaveCount(2);
  // A component source on another screen must open that exact screen and element.
  const destination = project.screens[1];
  const component = destination.nodes[0];
  await inspect('screen_1');
  await (await sourceCard(component.text)).getByRole('button', { name: 'Open wireframe' }).click();
  await expect(page.locator('.wf-breadcrumb')).toContainText(destination.name);
  await expect(page.locator(`[data-node-id="${component.id}"]`)).toHaveClass(/is-selected/);
  await expect(page.locator(`[data-node-id="${component.id}"]`)).toBeFocused();
  await expect(page.getByLabel('Content', { exact: true })).toHaveValue(component.text);

  await openOverview();
  await ready();
  await inspect('requirements_proposed');
  await expect(page.getByLabel('Overview source details')).toContainText('proposed');
  await (
    await sourceCard('Consider adding a shared packing list.')
  )
    .getByRole('button', { name: 'Open requirement' })
    .click();
  await expect(page.locator('#requirement-req_overview_proposed')).toBeFocused();
  await openOverview();
  await ready();
  await inspect('requirements_accepted');
  await expect(page.getByLabel('Overview source details')).toContainText(
    project.requirements[0].text,
  );
  await expect(page.locator('.overview-source-status')).toHaveText('accepted');
  await inspect('annotations');
  const annotation = await sourceCard('The empty state wording has been reviewed.');
  await expect(annotation.locator('.overview-source-status')).toHaveText('resolved');
  await annotation.getByRole('button', { name: 'Open discussion' }).click();
  await expect(page.locator('#comment-comment_overview_resolved')).toBeFocused();

  await openOverview();
  await ready();
  await inspect('references');
  await (
    await sourceCard('A calm palette and generous space for the itinerary.')
  )
    .getByRole('button', { name: 'Open reference' })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Reference: Quiet travel reference', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close reference', exact: true }).click();
  await openOverview();
  await ready();
  await inspect('discussion');
  await (
    await sourceCard(project.chat[0].text)
  )
    .getByRole('button', { name: 'Open conversation' })
    .click();
  await expect(page.locator('#chat-chat_overview_context')).toBeFocused();
  await openOverview();
  await ready();
  await page.getByRole('button', { name: 'Refresh overview', exact: true }).click();
  await ready();

  // Hostile and incomplete original prose stays inert, including when a real SVG is mounted.
  await expect(
    page.locator(
      '.overview-svg script, .overview-svg foreignObject, .overview-svg img, .overview-svg image, .overview-svg a[href]',
    ),
  ).toHaveCount(0);
  assert.equal(
    await page
      .locator('.overview-svg')
      .evaluate((root) =>
        [...root.querySelectorAll('*')].some((element) =>
          [...element.attributes].some((attribute) => /^on/i.test(attribute.name)),
        ),
      ),
    false,
  );
  assert.equal(await page.evaluate(() => window.__peleInjected), false);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(
    mutations,
    [],
    'Visualization, source navigation and refresh never save or create AI jobs',
  );
  assert.deepEqual(
    await read(project.id),
    project,
    'The complete original project and revision remain unchanged',
  );

  // A changed plan is reflected automatically; export derives fresh material even before reopening the view.
  await page.getByRole('button', { name: 'Product plan', exact: true }).click();
  const updatedProblem = 'Updated source: travel decisions remain connected in one calm workspace.';
  const proseJourney =
    'People explore destinations and save places when they find something useful.';
  await page.getByLabel('Problem & opportunity', { exact: true }).fill(updatedProblem);
  await page.getByLabel('User journeys', { exact: true }).fill(proseJourney);
  await expect.poll(async () => (await read(project.id)).plan.journeys).toBe(proseJourney);
  project = await read(project.id);
  await page.getByRole('button', { name: 'Handoff', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download specification', exact: true }).click();
  const zip = unzipSync(await fs.readFile(await (await downloading).path()));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  const sources = JSON.parse(strFromU8(zip['overview/sources.json']));
  assert.deepEqual(JSON.parse(strFromU8(zip['project.json'])), project);
  assert.equal(manifest.revision, project.revision);
  assert.equal(manifest.overview.derivedFrom, 'project.json');
  assert.equal(manifest.overview.sourcesPath, 'overview/sources.json');
  assert.equal(manifest.overview.graphs.length, 3);
  for (const graph of manifest.overview.graphs) {
    assert.ok(zip[graph.path]);
    assert.match(strFromU8(zip[graph.path]), /^(?:mindmap|flowchart TD)\n/);
  }
  const purpose = sources.graphs
    .find((graph) => graph.id === 'product')
    .nodes.find((node) => node.id === 'plan_purpose');
  assert.deepEqual(purpose.entries.find((entry) => entry.source.key === 'problem').source, {
    kind: 'plan',
    key: 'problem',
  });
  assert.equal(
    purpose.entries.find((entry) => entry.source.key === 'problem').body,
    updatedProblem,
  );
  const journey = sources.graphs.find((graph) => graph.id === 'journey');
  assert.equal(journey.nodes.length, 1);
  assert.equal(journey.edges.length, 0, 'Prose is context and does not invent a sequence');
  assert.equal(journey.nodes[0].entries[0].body, proseJourney);
  assert.equal(strFromU8(zip['diagrams/diagram_legacy_draft.mmd']), project.diagrams[0].source);

  await openOverview();
  await ready();
  await inspect('plan_purpose');
  await expect(page.getByLabel('Overview source details')).toContainText(updatedProblem);
  await page.getByRole('button', { name: 'Written journey', exact: true }).click();
  await ready();
  await expect(page.locator('.overview-svg .pele-node')).toHaveCount(1);
  await expect(page.locator('.overview-svg .pele-edge')).toHaveCount(0);
  await expect(page.getByLabel('Overview source details')).toContainText(proseJourney);
  await page.reload();
  await openOverview();
  await ready();
  await inspect('plan_purpose');
  await expect(page.getByLabel('Overview source details')).toContainText(updatedProblem);

  await page.getByLabel('Current project', { exact: true }).selectOption(blank.id);
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(blank.id);
  await openOverview();
  await expect(
    page.getByRole('heading', { name: 'Turn your thinking into a picture.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Visualize product', exact: true }).click();
  await ready();
  await expect(page.locator('.overview-map')).toContainText(blank.title);
  await expect(page.locator('.overview-workspace')).not.toContainText(project.title);
  await expect(page.getByLabel('Included project material')).toContainText('0 screens');
  await page.getByRole('button', { name: 'Screen connections', exact: true }).click();
  await ready();
  await expect(page.locator('.overview-svg')).toContainText('No screens yet');
  await expect(page.locator('.overview-svg .pele-node')).toHaveCount(1);
  await expect(page.locator('.overview-svg .pele-edge')).toHaveCount(0);
  assert.deepEqual(
    await read(blank.id),
    blank,
    'An empty project never gains generated sample content',
  );

  await page.getByLabel('Current project', { exact: true }).selectOption(project.id);
  await openOverview();
  await ready();
  await expect(page.locator('.overview-map')).toContainText(project.title);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Refresh overview', exact: true })).toBeVisible();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    true,
    'The automatic overview fits a narrow viewport without page-level horizontal overflow',
  );
  await page.locator('.overview-map').scrollIntoViewIfNeeded();
  await expect(page.locator('.overview-svg > svg')).toBeVisible();
  assert.deepEqual(await read(project.id), project);
  assert.deepEqual(errors, []);
  console.log(
    'Overview browser checks passed: automatic real Pele visualization; no source editor, helper jobs or project mutation; SVG pointer/keyboard inspection and zoom; exact plan, screen, component, decision, comment, reference and chat source navigation; fresh portable export; updated prose without invented order; reload/project isolation; inert hostile text; narrow layout.',
  );
} finally {
  await page.close();
  for (const id of ids)
    await context.request.delete(`${baseURL}/api/projects/${id}`).catch(() => undefined);
  await browser.close();
}
