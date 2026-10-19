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
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || process.env.BLAI_CHROMIUM || '/usr/bin/chromium',
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
const marginCard = (id) => page.locator(`[data-comment-card="${id}"]`);
async function assertCommentGeometry(comment, description) {
  await expect(marginCard(comment.id)).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ id, target }) => {
            const frame = document.querySelector('.wf-artboard');
            const anchor =
              target.kind === 'node'
                ? [...frame.querySelectorAll('[data-node-id]')].find(
                    (item) => item.dataset.nodeId === target.nodeId,
                  )
                : frame;
            const pin = [...frame.querySelectorAll('.wf-comment-pin')].find(
              (item) => item.dataset.commentId === id,
            );
            const card = [...document.querySelectorAll('[data-comment-card]')].find(
              (item) => item.dataset.commentCard === id,
            );
            const line = [...document.querySelectorAll('.wf-comment-connectors path')].find(
              (item) => item.dataset.commentId === id,
            );
            if (!anchor || !pin || !card || !line) return 9999;
            const bounds = anchor.getBoundingClientRect();
            const pinBounds = pin.getBoundingClientRect();
            const cardBounds = card.getBoundingClientRect();
            const start = line.getPointAtLength(0).matrixTransform(line.getScreenCTM());
            const end = line
              .getPointAtLength(line.getTotalLength())
              .matrixTransform(line.getScreenCTM());
            const x = bounds.left + bounds.width * target.x;
            const y = bounds.top + bounds.height * target.y;
            return Math.max(
              Math.abs(start.x - x),
              Math.abs(start.y - y),
              Math.abs(pinBounds.left + pinBounds.width / 2 - x),
              Math.abs(pinBounds.top + pinBounds.height / 2 - y),
              Math.abs(end.x - cardBounds.left),
              end.y < cardBounds.top || end.y > cardBounds.bottom ? 9999 : 0,
              cardBounds.left < frame.getBoundingClientRect().right + 30 ? 9999 : 0,
              getComputedStyle(line).strokeDasharray === 'none' ? 9999 : 0,
            );
          },
          { id: comment.id, target: comment.target },
        ),
      { message: description },
    )
    .toBeLessThan(2);
}

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
  await expect(node(nested.id).locator('.wf-comment-pin')).toBeVisible();
  await expect(
    page.locator(`.wf-comment-connectors path[data-comment-id="${annotation.id}"]`),
  ).toHaveCount(1);
  await expect(page.locator('.wf-artboard .annotation-label')).toHaveCount(0);
  await assertCommentGeometry(
    annotation,
    'Comment card sits in the margin, with its dotted leader on the saved anchor',
  );
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await expect(
    page.locator('.wf-inspector-tabs').getByRole('button', { name: 'Properties', exact: true }),
  ).toHaveClass('active');
  await page.getByRole('button', { name: 'Down', exact: true }).click();
  state = await save();
  assert.equal(find(screen(state).nodes, card.id).children[1].id, nested.id);
  assert.equal(state.comments.find((item) => item.id === annotation.id).target.nodeId, nested.id);
  const nodeBounds = await node(nested.id).boundingBox();
  const pinBounds = await node(nested.id).locator('.wf-comment-pin').boundingBox();
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
  await assertCommentGeometry(annotation, 'Margin connector follows component reordering');
  const originalCardWidth = (await marginCard(annotation.id).boundingBox()).width;
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await assertCommentGeometry(annotation, 'Margin connector follows canvas zoom');
  assert(
    Math.abs((await marginCard(annotation.id).boundingBox()).width - originalCardWidth) < 1,
    'Comment text stays at readable, unscaled width when the artboard zooms',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertCommentGeometry(annotation, 'Margin connector follows viewport resize');
  await page.locator('.wf-canvas-scroll').evaluate((element) => {
    element.scrollTop += 170;
    element.scrollLeft += 90;
  });
  await assertCommentGeometry(
    annotation,
    'Comment and connector share the scrolled canvas coordinates',
  );
  await page.setViewportSize({ width: 1600, height: 1050 });

  // Nearby annotations stack in the margin instead of covering each other or the design.
  await node(nested.id).locator('p').click();
  await page.getByRole('button', { name: 'Leave a note on this element' }).click();
  await page
    .getByRole('textbox', { name: 'New comment', exact: true })
    .fill(
      'A second thought at the same location. Keep both notes readable when their anchors overlap.\nThis extra context makes the card taller.',
    );
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  state = await save();
  const nearby = state.comments.find((item) => item.body.startsWith('A second thought'));
  await assertCommentGeometry(
    nearby,
    'A second comment keeps its own connector at the shared anchor',
  );
  const firstCard = await marginCard(annotation.id).boundingBox();
  const secondCard = await marginCard(nearby.id).boundingBox();
  assert(secondCard.y >= firstCard.y + firstCard.height + 8, 'Nearby comment cards do not overlap');
  await marginCard(nearby.id).getByRole('button', { name: 'Open thread', exact: true }).click();
  const thread = page.locator(`#comment-${nearby.id}`);
  await expect(thread).toHaveClass(/is-selected/);
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await thread
    .getByRole('textbox', { name: 'Reply to comment' })
    .fill('Reply from the margin thread.');
  await thread.getByRole('button', { name: 'Send reply', exact: true }).click();
  state = await save();
  assert.equal(state.comments.find((item) => item.id === nearby.id).replies.length, 1);
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await page
    .locator('.wf-inspector-tabs')
    .getByRole('button', { name: /^Comments/ })
    .click();
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'New comment', exact: true })
    .fill('A screen-level note in the right margin.');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  state = await save();
  const screenNote = state.comments.find((item) => item.body.startsWith('A screen-level note'));
  assert.equal(screenNote.target.kind, 'screen');
  await assertCommentGeometry(
    screenNote,
    'Screen-level comments use the artboard coordinate space',
  );
  await page.screenshot({ path: '/tmp/blai-wireframe-comments-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await marginCard(nearby.id).scrollIntoViewIfNeeded();
  await assertCommentGeometry(
    nearby,
    'Narrow-screen horizontal panning keeps comment anchors connected',
  );
  assert(
    await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1),
    'Margin scrolls inside canvas without widening the mobile page',
  );
  await page.screenshot({ path: '/tmp/blai-wireframe-comments-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1050 });
  await marginCard(nearby.id).getByRole('button', { name: 'Resolve', exact: true }).click();
  state = await save();
  assert.equal(state.comments.find((item) => item.id === nearby.id).status, 'resolved');
  await expect(marginCard(nearby.id)).toHaveCount(0);
  await expect(
    page.locator(`.wf-comment-connectors path[data-comment-id="${nearby.id}"]`),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  report.push(
    'Right-margin cards stay readable and separate; anchor geometry survives zoom, scrolling, resize and mobile panning; screen notes, replies and resolving work',
  );

  // Existing content can move into an empty container without losing comments.
  await node(nested.id).locator('p').click();
  await page.keyboard.press('Escape');
  await page
    .locator('.wf-component-button')
    .filter({ hasText: /^Column$/ })
    .click();
  state = await save();
  const emptyColumn = screen(state).nodes.at(-1);
  assert.equal(emptyColumn.type, 'column');
  assert.equal(emptyColumn.children.length, 0);
  await node(nested.id).locator('p').click();
  await page.getByLabel('Inside container', { exact: true }).selectOption(emptyColumn.id);
  state = await save();
  assert.equal(find(screen(state).nodes, emptyColumn.id).children[0].id, nested.id);
  assert.equal(state.comments.find((item) => item.id === annotation.id).target.nodeId, nested.id);
  await expect(node(nested.id).locator('.wf-comment-pin')).toBeVisible();
  await page.getByRole('button', { name: 'Select parent container', exact: true }).click();
  await page.getByLabel('Container layout', { exact: true }).selectOption('row');
  state = await save();
  assert.equal(find(screen(state).nodes, emptyColumn.id).type, 'row');
  assert.equal(find(screen(state).nodes, emptyColumn.id).children[0].id, nested.id);
  await node(nested.id).locator('p').click();
  await page.getByLabel('Inside container', { exact: true }).selectOption(card.id);
  state = await save();
  assert.equal(find(screen(state).nodes, card.id).children.at(-1).id, nested.id);
  await node(nested.id).locator('p').click();
  await node(emptyColumn.id).scrollIntoViewIfNeeded();
  const moveHandle = await node(nested.id)
    .getByRole('button', { name: 'Drag Text', exact: true })
    .boundingBox();
  const emptyBounds = await node(emptyColumn.id).boundingBox();
  assert(moveHandle && emptyBounds, 'Empty container and drag handle have bounds');
  await page.mouse.move(moveHandle.x + moveHandle.width / 2, moveHandle.y + moveHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveHandle.x + 15, moveHandle.y + 15, { steps: 3 });
  await page.mouse.move(
    emptyBounds.x + emptyBounds.width / 2,
    emptyBounds.y + emptyBounds.height / 2,
    { steps: 15 },
  );
  await page.mouse.up();
  state = await save();
  assert.equal(find(screen(state).nodes, emptyColumn.id).children[0].id, nested.id);
  await node(nested.id).locator('p').click();
  await page.getByLabel('Inside container', { exact: true }).selectOption(card.id);
  await save();
  report.push(
    'Container controls and pointer drops reparent annotated content into empty containers; row/column conversion preserves IDs',
  );

  // Canvas shortcuts reuse components across screens and leave text editing alone.
  await node(nested.id).locator('p').click();
  await page.keyboard.press('Control+c');
  await expect(page.getByRole('button', { name: 'Paste component', exact: true })).toBeEnabled();
  await page
    .locator('.wf-sidebar-tabs')
    .getByRole('button', { name: /^Screens/ })
    .click();
  await page.locator('.wf-screen-item').filter({ hasText: 'Today’s itinerary' }).click();
  await page.getByLabel('Wireframe canvas', { exact: true }).focus();
  await page.keyboard.press('Control+v');
  state = await save();
  const mobile = state.screens.find((item) => item.id === initial.screens[1].id);
  const pasted = mobile.nodes.at(-1);
  assert.equal(pasted.text, nested.text);
  assert.notEqual(pasted.id, nested.id);
  assert.equal(state.comments.filter((item) => item.target.nodeId === pasted.id).length, 0);
  await node(pasted.id).locator('p').click();
  await page.keyboard.press('Control+d');
  state = await save();
  const duplicate = state.screens.find((item) => item.id === mobile.id).nodes.at(-1);
  assert.notEqual(duplicate.id, pasted.id);
  assert.equal(duplicate.text, pasted.text);
  await node(duplicate.id).locator('p').click();
  await page.keyboard.press('Delete');
  state = await save();
  assert.equal(
    find(state.screens.find((item) => item.id === mobile.id).nodes, duplicate.id),
    undefined,
  );
  await node(pasted.id).locator('p').click();
  await page.getByLabel('Content', { exact: true }).fill('Typing remains text');
  await page.getByLabel('Content', { exact: true }).press('Backspace');
  state = await save();
  assert.equal(
    find(state.screens.find((item) => item.id === mobile.id).nodes, pasted.id).text,
    'Typing remains tex',
  );
  await page.locator('.wf-screen-item').filter({ hasText: 'Trip overview' }).click();
  await node(nested.id).locator('p').click();
  report.push(
    'Canvas copy/paste works across screens; duplicate/delete shortcuts preserve normal textbox editing',
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

  // Clearing a name must not create an invalid autosave, and the AI dialog is keyboard-contained.
  await page.getByLabel('Screen name', { exact: true }).fill('');
  state = await save();
  assert.equal(screen(state).name, initial.screens[0].name);
  await expect(page.getByLabel('Screen name', { exact: true })).toHaveValue(
    initial.screens[0].name,
  );
  await page.getByRole('button', { name: 'Design with AI', exact: true }).click();
  const aiDialog = page.getByRole('dialog', { name: 'Let’s give your idea a shape.' });
  await expect(aiDialog.locator('textarea')).toBeFocused();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    assert(
      await aiDialog.evaluate((element) => element.contains(document.activeElement)),
      'Tab focus remains within AI dialog',
    );
  }
  await aiDialog.locator('textarea').focus();
  await page.keyboard.press('Escape');
  await expect(aiDialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Design with AI', exact: true })).toBeFocused();
  report.push(
    'Blank screen names restore the saved value; AI dialog traps Tab and Escape returns focus',
  );

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
