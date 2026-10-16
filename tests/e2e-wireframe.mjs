import { chromium, request, expect } from '@playwright/test';
import assert from 'node:assert/strict';

// Run against the local Vite/Worker server: node tests/e2e-wireframe.mjs
const baseURL = process.env.BLAI_TEST_URL || 'http://127.0.0.1:5173';
const client = await request.newContext({ baseURL });
const created = await client.post('/api/projects', {
  data: { sample: true, title: 'Wireframe browser smoke' },
});
assert.equal(created.status(), 201, await created.text());
const { project: initial } = await created.json();
const browser = await chromium.launch({
  executablePath: process.env.BLAI_CHROMIUM || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
page.setDefaultTimeout(7000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const report = [];
const project = async () =>
  (await (await client.get(`/api/projects/${initial.id}`)).json()).project;
const save = async () => {
  await page.locator('.save-indicator').click();
  await expect(page.locator('.save-indicator')).toHaveText('All changes saved');
  const value = await project();
  assert(value && !value.error, 'Project remains readable');
  return value;
};
const screen = (data) => data.screens.find((item) => item.id === initial.screens[0].id);
const find = (nodes, id) => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = find(node.children, id);
    if (child) return child;
  }
};
const node = (id) => page.locator(`[data-node-id="${id}"]`);

try {
  await page.addInitScript((id) => localStorage.setItem('blai-project', id), initial.id);
  await page.goto(baseURL);
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('button', { name: 'Wireframes' })
    .click();
  await expect(page.locator('.wf-artboard')).toBeVisible();
  await page.screenshot({ path: '/tmp/blai-wireframe.png', fullPage: true });
  report.push('Opened isolated sample project; responsive canvas fits initial desktop viewport');

  // A linked button navigates to the mobile screen in prototype mode.
  await page.getByRole('button', { name: 'Preview flow', exact: true }).click();
  await page.locator('.wf-artboard').getByRole('button', { name: 'Open itinerary' }).click();
  await expect(page.locator('.wf-breadcrumb')).toContainText('Today’s itinerary');
  await expect(page.locator('.wf-artboard')).toHaveClass(/wf-mobile-artboard/);
  await page.getByRole('button', { name: 'Back to editor', exact: true }).click();
  await page.locator('.wf-screen-item').filter({ hasText: 'Trip overview' }).click();
  report.push('Clickable prototype link opens the connected mobile itinerary');

  // Change an existing component through its property editor, then persist.
  const heroHeading = initial.screens[0].nodes[1].children.find((item) => item.type === 'heading');
  await node(heroHeading.id).locator('h2').click();
  await page.getByLabel('Content', { exact: true }).fill('A weekend worth looking forward to.');
  let state = await save();
  assert.equal(
    find(screen(state).nodes, heroHeading.id).text,
    'A weekend worth looking forward to.',
  );
  report.push('Component content editing persists to D1');

  // Add a reusable card then insert another text component inside it.
  await page.keyboard.press('Escape');
  await page
    .locator('.wf-sidebar-tabs')
    .getByRole('button', { name: 'Components', exact: true })
    .click();
  await page
    .locator('.wf-component-button')
    .filter({ hasText: /^Card$/ })
    .click();
  state = await save();
  const card = screen(state).nodes.at(-1);
  assert.equal(card.type, 'card');
  await page
    .locator('.wf-component-button')
    .filter({ hasText: /^Text$/ })
    .click();
  await page.getByLabel('Content', { exact: true }).fill('A note inside the reusable card.');
  state = await save();
  const nested = find(screen(state).nodes, card.id).children.at(-1);
  assert.equal(nested.text, 'A note inside the reusable card.');
  report.push('Library adds a card and inserts editable nested content');

  // Native sortable drag handles reorder siblings within a nested card.
  await node(nested.id).scrollIntoViewIfNeeded();
  const dragHandle = node(nested.id).getByRole('button', { name: 'Drag Text', exact: true });
  const target = node(card.children[0].id);
  await target.scrollIntoViewIfNeeded();
  const from = await dragHandle.boundingBox();
  const to = await target.boundingBox();
  assert(from && to, 'Drag handle and target have bounds');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  state = await save();
  assert.equal(
    find(screen(state).nodes, card.id).children[0].id,
    nested.id,
    'Dragged child moves before first child',
  );
  report.push('Pointer drag reorders nested components and persists stable IDs');

  // Annotate the component, move it, and ensure the pin stays within that node.
  await node(nested.id).locator('p').click();
  await page.getByRole('button', { name: 'Leave a note on this element' }).click();
  await page
    .getByRole('textbox', { name: 'New comment', exact: true })
    .fill('This detail must stay with the card when its layout changes.');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  state = await save();
  const annotation = state.comments.find((item) => item.body.startsWith('This detail must stay'));
  assert.equal(annotation.target.nodeId, nested.id);
  assert.equal(annotation.target.x, 0.8);
  assert.equal(annotation.target.y, 0.5);
  await expect(node(nested.id).locator('.annotation-pin')).toBeVisible();
  await expect(node(nested.id).locator('.annotation-leaders path')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await expect(
    page.locator('.wf-inspector-tabs').getByRole('button', { name: 'Properties', exact: true }),
  ).toHaveClass('active');
  await page.getByRole('button', { name: 'Down', exact: true }).click();
  state = await save();
  assert.equal(find(screen(state).nodes, card.id).children[1].id, nested.id);
  assert.equal(state.comments.find((item) => item.id === annotation.id).target.nodeId, nested.id);
  const nodeBounds = await node(nested.id).boundingBox();
  const pinBounds = await node(nested.id).locator('.annotation-pin').boundingBox();
  assert(nodeBounds && pinBounds, 'Element and pin have bounds');
  assert(
    Math.abs(pinBounds.x + pinBounds.width / 2 - nodeBounds.x - nodeBounds.width * 0.8) < 2,
    'Pin preserves normalized horizontal location',
  );
  assert(
    Math.abs(pinBounds.y + pinBounds.height / 2 - nodeBounds.y - nodeBounds.height * 0.5) < 2,
    'Pin preserves normalized vertical location',
  );
  report.push(
    'Element annotation stores normalized coordinates, draws dotted leader, and follows reordering',
  );

  // Duplicate/delete components, including annotation cleanup.
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  state = await save();
  assert.equal(find(screen(state).nodes, card.id).children.length, 4);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  state = await save();
  assert.equal(find(screen(state).nodes, card.id).children.length, 3);
  await node(nested.id).locator('p').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  state = await save();
  assert.equal(find(screen(state).nodes, nested.id), undefined);
  const retainedNote = state.comments.find((item) => item.id === annotation.id);
  assert.equal(retainedNote.target.kind, 'project');
  assert(retainedNote.previousLocation.includes(nested.id));
  report.push(
    'Duplicate/delete controls update nested components; detached notes retain their prior location',
  );

  // Explicit state variants have distinct screen and component IDs.
  await page.keyboard.press('Escape');
  await page.getByLabel('New state variant').selectOption('error');
  await page.getByRole('button', { name: 'Create state variant', exact: true }).click();
  state = await save();
  const variant = state.screens.at(-1);
  assert.equal(variant.state, 'error');
  assert.notEqual(variant.id, initial.screens[0].id);
  assert(variant.nodes.some((item) => item.children.some((child) => child.text === 'Try again')));
  await expect(page.locator('.wf-breadcrumb')).toContainText('error');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  state = await save();
  assert(!state.screens.some((item) => item.id === variant.id));
  report.push('Error variant creates an explicit editable state and can be deleted');

  // Reload proves saved content/structure survive a full application restart.
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('button', { name: 'Wireframes' })
    .click();
  await expect(node(heroHeading.id).locator('h2')).toHaveText(
    'A weekend worth looking forward to.',
  );
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
  report.push('Reload preserves edited content; browser reported no runtime errors');
  console.log(
    JSON.stringify({ ok: true, checks: report, screenshot: '/tmp/blai-wireframe.png' }, null, 2),
  );
} catch (error) {
  await page.screenshot({ path: '/tmp/blai-wireframe-failure.png', fullPage: true });
  console.error(
    JSON.stringify(
      { completed: report, errors, screenshot: '/tmp/blai-wireframe-failure.png' },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  await client.delete(`/api/projects/${initial.id}`);
  await client.dispose();
}
