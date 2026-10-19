import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

// Synthetic, disposable projects only. This workflow must never target production.
const base = new URL(process.env.BLAI_TEST_URL || 'http://127.0.0.1:5173');
assert.ok(
  base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
  'Freeform E2E requires a loopback development server.',
);
const screenshots = process.env.BLAI_QA_DIR || path.join(os.tmpdir(), 'blai-freeform-qa');
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || process.env.BLAI_CHROMIUM || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1720, height: 1120 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const client = context.request;
const ids = [];
const errors = [];
const report = [];
const releaseGates = [];
page.on('pageerror', (error) => errors.push(error.message));
let projectId;
const screenId = 'qa_canvas',
  legacyId = 'qa_legacy',
  swipeId = 'qa_swipe';
const node = (id) => page.locator(`.freeform-canvas [data-node-id="${id}"]`);
const canvas = () => page.locator('.freeform-canvas');
const find = (nodes, id) => {
  for (const item of nodes) {
    if (item.id === id) return item;
    const nested = find(item.children, id);
    if (nested) return nested;
  }
};
const flatten = (nodes) => nodes.flatMap((item) => [item, ...flatten(item.children)]);
const layer = (id, type, name, frame, extra = {}) => ({
  id,
  type,
  name,
  text: '',
  style: {},
  children: [],
  ...(frame ? { frame } : {}),
  ...extra,
});
const frame = (x, y, width, height, rotation = 0) => ({ x, y, width, height, rotation });
const screen = (data, id = screenId) => data.screens.find((item) => item.id === id);
const annotation = (id, screenId, nodeId, body) => ({
  id,
  target: { kind: 'node', screenId, nodeId, x: 0.8, y: 0.25 },
  body,
  status: 'open',
  replies: [],
  createdAt: '2026-01-01T00:00:00.000Z',
});

async function getProject() {
  const response = await client.get(new URL(`/api/projects/${projectId}`, base).href);
  assert.equal(response.status(), 200);
  return (await response.json()).project;
}
async function save() {
  await page.locator('.save-indicator').click();
  await expect(page.locator('.save-indicator')).toHaveText('All changes saved');
  return getProject();
}
async function writeProject(data) {
  const response = await client.put(new URL(`/api/projects/${projectId}`, base).href, {
    data: { project: data, expectedRevision: data.revision },
  });
  assert.equal(response.status(), 200, await response.text());
  return (await response.json()).project;
}
async function openScreen(name) {
  await page.locator('.wf-screen-item').filter({ hasText: name }).click();
}
async function select(name, modifiers = []) {
  await page.locator('.canvas-layer-name').filter({ hasText: name }).click({ modifiers });
}
async function point(x, y) {
  const bounds = await canvas().boundingBox();
  const size = await canvas().evaluate((element) => ({
    width: element.offsetWidth,
    height: element.offsetHeight,
  }));
  assert.ok(bounds && size.width && size.height, 'Canvas has a measurable frame');
  return {
    x: bounds.x + (x * bounds.width) / size.width,
    y: bounds.y + (y * bounds.height) / size.height,
  };
}
async function pointerDrag(from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}
async function draw(tool, from, to) {
  await page.getByRole('button', { name: `${tool} tool`, exact: true }).click();
  await pointerDrag(await point(...from), await point(...to));
  return save();
}
async function uploadPng(name, png) {
  await page.getByRole('button', { name: 'Place image', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload an image', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: png });
}
async function holdResponse(pattern, method) {
  let release,
    started = false;
  const gate = new Promise((resolve) => {
    release = resolve;
    releaseGates.push(resolve);
  });
  const handler = async (route) => {
    if (route.request().method() !== method) return route.continue();
    const response = await route.fetch();
    started = true;
    await gate;
    await route.fulfill({ response });
  };
  await page.route(pattern, handler);
  return {
    ready: () =>
      expect
        .poll(() => started, {
          timeout: 15000,
          message: 'Real local response reached the controlled latency gate',
        })
        .toBe(true),
    release,
    remove: () => page.unroute(pattern, handler),
  };
}
async function assertFitted() {
  await expect
    .poll(
      async () => {
        const bounds = await canvas().boundingBox();
        const viewport = await page.locator('.wf-canvas-scroll').boundingBox();
        const margin =
          viewport.width >= 720 ? await page.locator('.wf-comment-margin').boundingBox() : null;
        const right = margin ? margin.x + margin.width : bounds.x + bounds.width;
        return Math.abs((bounds.x + right) / 2 - viewport.x - viewport.width / 2);
      },
      { message: 'Fit centers the artboard and its visible comment margin' },
    )
    .toBeLessThan(3);
}
function near(actual, expected, message, tolerance = 1.2) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} versus ${expected}`);
}
function compose(a, b) {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}
function matrix(f) {
  const angle = (f.rotation * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  return {
    a: c,
    b: s,
    c: -s,
    d: c,
    e: f.x + f.width / 2 - (c * f.width) / 2 + (s * f.height) / 2,
    f: f.y + f.height / 2 - (s * f.width) / 2 - (c * f.height) / 2,
  };
}
function worldCorners(nodes, id, parent = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) {
  for (const item of nodes) {
    const m = compose(parent, matrix(item.frame));
    if (item.id === id)
      return [
        [0, 0],
        [item.frame.width, 0],
        [item.frame.width, item.frame.height],
        [0, item.frame.height],
      ].map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
    const child = worldCorners(item.children, id, m);
    if (child) return child;
  }
}
function sameCorners(before, after, description) {
  before.forEach((corner, index) => {
    near(after[index].x, corner.x, description + ' x', 0.03);
    near(after[index].y, corner.y, description + ' y', 0.03);
  });
}
async function assertComment(comment, f) {
  const pin = page.locator(`.freeform-canvas .wf-comment-pin[data-comment-id="${comment.id}"]`);
  await expect(pin).toBeVisible();
  const localX = f.width * (comment.target.x - 0.5),
    localY = f.height * (comment.target.y - 0.5);
  const angle = (f.rotation * Math.PI) / 180;
  const expected = await point(
    f.x + f.width / 2 + localX * Math.cos(angle) - localY * Math.sin(angle),
    f.y + f.height / 2 + localX * Math.sin(angle) + localY * Math.cos(angle),
  );
  await expect
    .poll(
      async () => {
        const bounds = await pin.boundingBox();
        return Math.max(
          Math.abs(bounds.x + bounds.width / 2 - expected.x),
          Math.abs(bounds.y + bounds.height / 2 - expected.y),
        );
      },
      { message: 'Pin uses the actual rotated layer coordinates' },
    )
    .toBeLessThan(2);
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const line = document.querySelector(
            `.wf-comment-connectors path[data-comment-id="${id}"]`,
          );
          const pin = document.querySelector(
            `.freeform-canvas .wf-comment-pin[data-comment-id="${id}"]`,
          );
          const card = document.querySelector(`[data-comment-card="${id}"]`);
          if (!line || !pin || !card) return 9999;
          const p = pin.getBoundingClientRect(),
            c = card.getBoundingClientRect();
          const start = line.getPointAtLength(0).matrixTransform(line.getScreenCTM());
          const end = line
            .getPointAtLength(line.getTotalLength())
            .matrixTransform(line.getScreenCTM());
          return Math.max(
            Math.abs(start.x - p.left - p.width / 2),
            Math.abs(start.y - p.top - p.height / 2),
            Math.abs(end.x - c.left),
            end.y < c.top || end.y > c.bottom ? 9999 : 0,
            getComputedStyle(line).strokeDasharray === 'none' ? 9999 : 0,
          );
        }, comment.id),
      { message: 'Dotted margin connector follows the rotated pin' },
    )
    .toBeLessThan(2);
}

try {
  const session = await client.get(new URL('/api/session', base).href);
  assert.equal(session.status(), 200);
  assert.equal((await session.json()).local, true, 'Synthetic E2E requires local authentication');
  const created = await client.post(new URL('/api/projects', base).href, {
    data: { title: 'Freeform synthetic QA' },
  });
  assert.equal(created.status(), 201);
  let initial = (await created.json()).project;
  projectId = initial.id;
  ids.push(projectId);
  const comment = annotation(
    'qa_rotated_note',
    screenId,
    'qa_card',
    'Keep this note attached while the card moves and rotates.',
  );
  const legacyComment = annotation(
    'qa_legacy_note',
    legacyId,
    'qa_legacy_button',
    'Keep this action and its location when converting.',
  );
  initial = await writeProject({
    ...initial,
    screens: [
      {
        id: screenId,
        name: 'Canvas QA',
        platform: 'desktop',
        state: 'default',
        description: 'Synthetic geometry fixture',
        canvas: { width: 900, height: 700 },
        nodes: [
          layer('qa_card', 'rectangle', 'QA card', frame(90, 90, 140, 90), {
            style: { background: '#728c7a', radius: 12 },
          }),
          layer('qa_orb', 'ellipse', 'QA orb', frame(330, 110, 120, 100), {
            style: { background: '#d5ad6c' },
          }),
          layer('qa_copy', 'text', 'QA copy', frame(90, 340, 280, 56), {
            text: 'Editable layers, real geometry.',
            style: { fontSize: 22 },
          }),
        ],
      },
      {
        id: legacyId,
        name: 'Legacy QA',
        platform: 'desktop',
        state: 'default',
        description: 'Synthetic legacy flow fixture',
        nodes: [
          layer('qa_legacy_section', 'section', 'Legacy section', null, {
            style: { padding: 24, gap: 16 },
            children: [
              layer('qa_legacy_heading', 'heading', 'Legacy heading', null, {
                text: 'Keep this layout and its IDs.',
              }),
              layer('qa_legacy_button', 'button', 'Legacy action', null, {
                text: 'Open canvas',
                action: { screenId },
              }),
            ],
          }),
        ],
      },
    ],
    comments: [comment, legacyComment],
  });
  await page.addInitScript((id) => localStorage.setItem('blai-project', id), projectId);
  await page.goto(base.href);
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('button', { name: 'Wireframes' })
    .click();
  await expect(canvas()).toBeVisible();
  const revisionBefore = (await getProject()).revision;
  await expect(page.locator('.save-indicator')).toHaveText('All changes saved');
  assert.equal(
    (await getProject()).revision,
    revisionBefore,
    'Opening a canvas does not rewrite it',
  );
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click();
  await assertFitted();
  const viewport = page.locator('.wf-canvas-scroll');
  const beforePan = await viewport.evaluate((element) => ({
    x: element.scrollLeft,
    y: element.scrollTop,
  }));
  await page.getByRole('button', { name: 'Pan tool', exact: true }).click();
  const panStart = await point(650, 450);
  await pointerDrag(panStart, { x: panStart.x - 40, y: panStart.y + 40 });
  const afterPan = await viewport.evaluate((element) => ({
    x: element.scrollLeft,
    y: element.scrollTop,
  }));
  near(afterPan.x - beforePan.x, 40, 'Pan moves the viewport horizontally at fit zoom', 3);
  near(afterPan.y - beforePan.y, -40, 'Pan moves the viewport vertically at fit zoom', 3);
  await page.getByRole('button', { name: 'Select tool', exact: true }).click();
  const viewportBounds = await viewport.boundingBox();
  await viewport.click({ position: { x: 15, y: 15 } });
  await page.keyboard.down('Space');
  await pointerDrag(
    { x: viewportBounds.x + 20, y: viewportBounds.y + 20 },
    { x: viewportBounds.x - 10, y: viewportBounds.y + 45 },
  );
  await page.keyboard.up('Space');
  const outsidePan = await viewport.evaluate((element) => ({
    x: element.scrollLeft,
    y: element.scrollTop,
  }));
  near(outsidePan.x - afterPan.x, 30, 'Space-pan also works in the surrounding canvas margin', 3);
  near(outsidePan.y - afterPan.y, -25, 'Space-pan preserves viewport scale', 3);
  assert.deepEqual(
    screen(await getProject()).nodes,
    screen(initial).nodes,
    'Viewport panning never edits the scene',
  );
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click();
  await assertFitted();
  report.push(
    'Fit centers the artboard; hand and Space-pan work at fit zoom without changing the document',
  );
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const zoom = await canvas().evaluate(
    (element) => element.getBoundingClientRect().width / element.offsetWidth,
  );
  assert.ok(Math.abs(zoom - 1) > 0.05, 'Pointer transforms are exercised at a non-default zoom');

  const baseline = structuredClone(screen(initial).nodes);
  await pointerDrag(await point(160, 135), await point(210, 165));
  let state = await save(),
    current = find(screen(state).nodes, 'qa_card');
  near(current.frame.x, 140, 'Drag stores canvas X independently of zoom');
  near(current.frame.y, 120, 'Drag stores canvas Y independently of zoom');
  const moved = structuredClone(current.frame);
  await page.getByRole('button', { name: 'Undo last edit', exact: true }).click();
  state = await save();
  assert.deepEqual(screen(state).nodes, baseline, 'One undo reverses the complete drag gesture');
  await page.getByRole('button', { name: 'Redo last edit', exact: true }).click();
  state = await save();
  assert.deepEqual(find(screen(state).nodes, 'qa_card').frame, moved);
  report.push('Real drag at zoom persists exact canvas deltas and commits one undoable gesture');

  await select('QA card');
  const handle = await page.locator('[data-resize-handle="se"]').boundingBox();
  assert.ok(handle);
  await pointerDrag(
    { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
    { x: handle.x + handle.width / 2 + 48 * zoom, y: handle.y + handle.height / 2 + 26 * zoom },
  );
  state = await save();
  current = find(screen(state).nodes, 'qa_card');
  near(current.frame.width, 188, 'Resize width follows zoomed pointer');
  near(current.frame.height, 116, 'Resize height follows zoomed pointer');
  const beforeRotation = structuredClone(current.frame);
  const rotateHandle = await page.locator('[data-rotate-handle]').boundingBox();
  const pivot = await point(
    current.frame.x + current.frame.width / 2,
    current.frame.y + current.frame.height / 2,
  );
  const start = {
    x: rotateHandle.x + rotateHandle.width / 2,
    y: rotateHandle.y + rotateHandle.height / 2,
  };
  const dx = start.x - pivot.x,
    dy = start.y - pivot.y,
    angle = Math.PI / 6;
  await pointerDrag(start, {
    x: pivot.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: pivot.y + dx * Math.sin(angle) + dy * Math.cos(angle),
  });
  state = await save();
  current = find(screen(state).nodes, 'qa_card');
  near(current.frame.rotation, 30, 'Rotation stores degrees from actual pointer movement', 1.5);
  near(
    current.frame.x + current.frame.width / 2,
    beforeRotation.x + beforeRotation.width / 2,
    'Rotation retains centre X',
  );
  near(
    current.frame.y + current.frame.height / 2,
    beforeRotation.y + beforeRotation.height / 2,
    'Rotation retains centre Y',
  );
  await assertComment(comment, current.frame);
  report.push(
    'Resize/rotation retain stored geometry; rotated comment pin and dotted leader stay attached',
  );

  const cancelled = structuredClone(current.frame);
  await page.mouse.move(pivot.x, pivot.y);
  await page.mouse.down();
  await page.mouse.move(pivot.x + 40, pivot.y + 25, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  state = await save();
  assert.deepEqual(
    find(screen(state).nodes, 'qa_card').frame,
    cancelled,
    'Escape cancels pointer preview',
  );

  const corners = Object.fromEntries(
    ['qa_card', 'qa_orb'].map((id) => [id, worldCorners(screen(state).nodes, id)]),
  );
  await select('QA card');
  await select('QA orb', ['Shift']);
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  state = await save();
  const group = screen(state).nodes.find((item) => item.type === 'group');
  assert.ok(group && find(group.children, 'qa_card') && find(group.children, 'qa_orb'));
  for (const id of Object.keys(corners))
    sameCorners(
      corners[id],
      worldCorners(screen(state).nodes, id),
      'Grouping retains world corners',
    );
  const groupedBaseline = structuredClone(screen(state).nodes);
  const sourceIds = new Set(flatten(groupedBaseline).map((item) => item.id));
  await canvas().focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  state = await save();
  const pastedGroup = screen(state).nodes.find((item) => !sourceIds.has(item.id));
  assert.equal(pastedGroup?.type, 'group', 'A root group can be copied and pasted into the scene');
  assert.deepEqual(
    pastedGroup.children.map((item) => item.type),
    group.children.map((item) => item.type),
  );
  assert.ok(
    flatten([pastedGroup]).every((item) => !sourceIds.has(item.id)),
    'Pasted descendants receive new IDs',
  );
  near(
    pastedGroup.frame.x,
    group.frame.x + 24,
    'Paste retains geometry with a small position offset',
  );
  near(pastedGroup.frame.y, group.frame.y + 24, 'Paste retains vertical geometry');
  const pastedIds = new Set(flatten(screen(state).nodes).map((item) => item.id));
  await canvas().focus();
  await page.keyboard.press('Control+d');
  state = await save();
  const duplicate = screen(state).nodes.find((item) => !pastedIds.has(item.id));
  assert.equal(duplicate?.type, 'group', 'Ctrl+D duplicates the selected pasted group');
  assert.ok(
    flatten([duplicate]).every((item) => !pastedIds.has(item.id)),
    'Duplicated descendants receive distinct IDs',
  );
  const allIds = flatten(screen(state).nodes).map((item) => item.id);
  assert.equal(
    new Set(allIds).size,
    allIds.length,
    'Copy and duplicate never collide with existing scene IDs',
  );
  near(
    duplicate.frame.x,
    pastedGroup.frame.x + 24,
    'Duplicate retains geometry with its own offset',
  );
  for (let edit = 0; edit < 2; edit++) {
    await page.getByRole('button', { name: 'Undo last edit', exact: true }).click();
    state = await save();
  }
  assert.deepEqual(
    screen(state).nodes,
    groupedBaseline,
    'Copy/paste and duplicate each undo as a single edit',
  );
  report.push(
    'Root copy/paste and Ctrl+D preserve nested geometry while generating distinct layer IDs',
  );

  const childBounds = (item) => {
    const points = worldCorners([item], item.id);
    return {
      left: Math.min(...points.map((p) => p.x)),
      right: Math.max(...points.map((p) => p.x)),
      top: Math.min(...points.map((p) => p.y)),
    };
  };
  const assertRow = (container) => {
    assert.equal(container.layout, 'row');
    const first = childBounds(container.children[0]),
      second = childBounds(container.children[1]);
    near(first.left, container.style.padding ?? 16, 'Automatic row starts at stored padding', 0.05);
    near(
      second.left - first.right,
      container.style.gap ?? 16,
      'Automatic row persists a visible gap',
      0.05,
    );
    near(second.top, first.top, 'Automatic row aligns rotated visible bounds', 0.05);
  };
  await select(group.name);
  const layoutControl = () =>
    page
      .locator('.canvas-properties label')
      .filter({ has: page.getByText('Layout', { exact: true }) })
      .locator('select');
  await layoutControl().selectOption('row');
  state = await save();
  let arranged = find(screen(state).nodes, group.id);
  assertRow(arranged);
  const nextSiblingX = find(arranged.children, 'qa_orb').frame.x;
  const childWidth = find(arranged.children, 'qa_card').frame.width;
  await select('QA card');
  await page.getByLabel('WIDTH', { exact: true }).fill(String(childWidth + 24));
  await page.getByLabel('WIDTH', { exact: true }).press('Enter');
  state = await save();
  arranged = find(screen(state).nodes, group.id);
  assertRow(arranged);
  near(
    find(arranged.children, 'qa_card').frame.width,
    childWidth + 24,
    'Automatic layout retains the edited child width',
  );
  assert.ok(
    find(arranged.children, 'qa_orb').frame.x > nextSiblingX + 12,
    'Resizing a child recomputes the next sibling position',
  );
  await page.getByRole('button', { name: 'Bring to front', exact: true }).click();
  state = await save();
  arranged = find(screen(state).nodes, group.id);
  assert.deepEqual(
    arranged.children.map((item) => item.id),
    ['qa_orb', 'qa_card'],
  );
  assertRow(arranged);
  await node('qa_card').dblclick();
  const beforeAutoDrag = structuredClone(screen(state).nodes);
  let childCorners = worldCorners(screen(state).nodes, 'qa_card');
  let childCenter = await point(
    (childCorners[0].x + childCorners[2].x) / 2,
    (childCorners[0].y + childCorners[2].y) / 2,
  );
  await pointerDrag(childCenter, { x: childCenter.x + 18 * zoom, y: childCenter.y + 12 * zoom });
  state = await save();
  assert.deepEqual(
    screen(state).nodes,
    beforeAutoDrag,
    'Automatic layout prevents direct child movement',
  );
  await select(group.name);
  await layoutControl().selectOption('free');
  state = await save();
  const freeGroup = structuredClone(find(screen(state).nodes, group.id));
  await select('QA card');
  childCorners = worldCorners(screen(state).nodes, 'qa_card');
  childCenter = await point(
    (childCorners[0].x + childCorners[2].x) / 2,
    (childCorners[0].y + childCorners[2].y) / 2,
  );
  await pointerDrag(childCenter, { x: childCenter.x + 18 * zoom, y: childCenter.y + 12 * zoom });
  state = await save();
  const movedChild = find(screen(state).nodes, 'qa_card');
  near(
    movedChild.frame.x,
    find(freeGroup.children, 'qa_card').frame.x + 18,
    'Switching to free layout permits independent child movement',
  );
  near(
    movedChild.frame.y,
    find(freeGroup.children, 'qa_card').frame.y + 12,
    'Free layout retains the pointer Y delta',
  );
  assert.deepEqual(
    find(screen(state).nodes, group.id).frame,
    freeGroup.frame,
    'Moving a free child leaves its group in place',
  );
  for (let edit = 0; edit < 5; edit++) {
    await page.getByRole('button', { name: 'Undo last edit', exact: true }).click();
    state = await save();
  }
  assert.deepEqual(
    screen(state).nodes,
    groupedBaseline,
    'Persistent layout edits restore cleanly through history',
  );
  report.push(
    'Persistent automatic row layout recomputes after resize/reorder, blocks direct dragging, and switches back to free movement',
  );
  await select(group.name);
  await page.getByRole('button', { name: 'Ungroup', exact: true }).click();
  state = await save();
  for (const id of Object.keys(corners))
    sameCorners(
      corners[id],
      worldCorners(screen(state).nodes, id),
      'Ungrouping retains world corners',
    );
  assert.equal(state.comments.find((item) => item.id === comment.id).target.nodeId, 'qa_card');
  report.push('Group/ungroup preserve rotated world placement, stable IDs, and annotations');

  await select('QA card');
  await page.getByRole('button', { name: 'Bring to front', exact: true }).click();
  state = await save();
  assert.equal(screen(state).nodes.at(-1).id, 'qa_card');
  await page.getByRole('button', { name: 'Send to back', exact: true }).click();
  state = await save();
  assert.equal(screen(state).nodes[0].id, 'qa_card');
  await page.getByRole('button', { name: 'Lock QA card', exact: true }).click();
  state = await save();
  const locked = structuredClone(find(screen(state).nodes, 'qa_card').frame);
  assert.equal(find(screen(state).nodes, 'qa_card').locked, true);
  const centre = await point(locked.x + locked.width / 2, locked.y + locked.height / 2);
  await pointerDrag(centre, { x: centre.x + 50, y: centre.y + 25 });
  state = await save();
  assert.deepEqual(
    find(screen(state).nodes, 'qa_card').frame,
    locked,
    'Locked layers cannot be dragged',
  );
  await page.getByRole('button', { name: 'Unlock QA card', exact: true }).click();
  await page.getByRole('button', { name: 'Hide QA card', exact: true }).click();
  state = await save();
  assert.equal(find(screen(state).nodes, 'qa_card').hidden, true);
  await expect(node('qa_card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show QA card', exact: true }).click();
  await save();
  await expect(node('qa_card')).toBeVisible();
  report.push(
    'Layer ordering, locking, and visibility persist and affect actual canvas interaction',
  );

  state = await draw('Rectangle', [530, 250], [665, 320]);
  const rectangle = screen(state).nodes.find(
    (item) => item.type === 'rectangle' && item.id !== 'qa_card',
  );
  assert.ok(rectangle);
  near(rectangle.frame.width, 135, 'Drawn rectangle width');
  state = await draw('Ellipse', [540, 400], [650, 490]);
  assert.equal(screen(state).nodes.filter((item) => item.type === 'ellipse').length, 2);
  state = await draw('Line', [510, 570], [680, 590]);
  assert.ok(screen(state).nodes.some((item) => item.type === 'line' && item.frame.width > 160));
  await page.getByRole('button', { name: 'Freehand tool', exact: true }).click();
  const points = [
    [540, 70],
    [590, 95],
    [550, 125],
    [615, 145],
  ];
  const first = await point(...points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const next = await point(...p);
    await page.mouse.move(next.x, next.y, { steps: 7 });
  }
  await page.mouse.up();
  state = await save();
  const pathLayer = screen(state).nodes.find((item) => item.type === 'path');
  assert.ok(
    pathLayer?.points.length > 3 &&
      pathLayer.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1),
  );
  const beforeText = new Set(flatten(screen(state).nodes).map((item) => item.id));
  state = await draw('Text', [90, 525], [340, 585]);
  const text = screen(state).nodes.find((item) => item.type === 'text' && !beforeText.has(item.id));
  assert.ok(text);
  if (!(await page.locator('.fc-inline-editor').count())) await node(text.id).dblclick();
  await page.locator('.fc-inline-editor').fill('Unsaved inline text draft.');
  assert.equal(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
    'Dirty inline text protects navigation',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('.fc-inline-editor')).toHaveCount(0);
  assert.equal(
    find(screen(await getProject()).nodes, text.id).text,
    text.text,
    'Escape retains the prior committed text',
  );
  await node(text.id).dblclick();
  await page.locator('.fc-inline-editor').fill('Text stays editable on the canvas.');
  await page.keyboard.press('Control+Enter');
  state = await save();
  assert.equal(find(screen(state).nodes, text.id).text, 'Text stays editable on the canvas.');
  report.push(
    'Pointer tools create editable rectangle, ellipse, line, normalized path, and inline text',
  );

  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 450;
      const g = c.getContext('2d'),
        gradient = g.createLinearGradient(0, 0, 400, 450);
      gradient.addColorStop(0, '#93b7b4');
      gradient.addColorStop(0.55, '#ecdfbd');
      gradient.addColorStop(1, '#bc866f');
      g.fillStyle = gradient;
      g.fillRect(0, 0, 400, 450);
      g.fillStyle = '#faf3d5';
      g.beginPath();
      g.arc(295, 115, 50, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#5f7970';
      g.beginPath();
      g.moveTo(0, 400);
      g.lineTo(130, 220);
      g.lineTo(280, 450);
      g.fill();
      g.fillStyle = '#385850';
      g.beginPath();
      g.moveTo(100, 450);
      g.lineTo(315, 235);
      g.lineTo(400, 350);
      g.lineTo(400, 450);
      g.fill();
      return c.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  await uploadPng('synthetic-landscape.png', png);
  await expect(page.getByRole('dialog', { name: 'Place an image', exact: true })).not.toBeVisible();
  state = await save();
  const image = screen(state).nodes.find((item) => item.type === 'image');
  const asset = state.assets.find((item) => item.id === image?.image?.assetId);
  assert.ok(asset && asset.imageUrl.startsWith('/api/assets/'));
  await expect(node(image.id).locator('img')).toHaveJSProperty('naturalWidth', 400);
  const assetResponse = await client.get(new URL(asset.imageUrl, base).href);
  assert.equal(assetResponse.status(), 200);
  assert.match(assetResponse.headers()['content-type'], /image\/png/);
  report.push(
    'Private raster upload is stored as an owned project asset and rendered as an editable image layer',
  );

  await select('Rectangle');
  const rectangleBefore = structuredClone(find(screen(state).nodes, rectangle.id).frame);
  const heldSave = await holdResponse(`**/api/projects/${projectId}`, 'PUT');
  await page.getByLabel('X', { exact: true }).fill(String(rectangleBefore.x + 1));
  await page.getByLabel('X', { exact: true }).press('Enter');
  await heldSave.ready();
  const duringSave = find(screen(await getProject()).nodes, rectangle.id).frame;
  const dragStart = await point(
    duringSave.x + duringSave.width / 2,
    duringSave.y + duringSave.height / 2,
  );
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 10 * zoom, dragStart.y, { steps: 4 });
  const saveReturned = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/projects/${projectId}`,
  );
  heldSave.release();
  await saveReturned;
  await expect(page.locator('.save-indicator')).toHaveText('All changes saved');
  await page.mouse.move(dragStart.x + 40 * zoom, dragStart.y + 20 * zoom, { steps: 7 });
  await page.mouse.up();
  await heldSave.remove();
  state = await save();
  near(
    find(screen(state).nodes, rectangle.id).frame.x,
    duringSave.x + 40,
    'A matching delayed autosave response does not interrupt the pointer gesture',
  );
  near(
    find(screen(state).nodes, rectangle.id).frame.y,
    duringSave.y + 20,
    'The entire delayed-save drag remains intact',
  );

  const heldUndoUpload = await holdResponse(`**/api/projects/${projectId}/assets`, 'POST');
  await uploadPng('undo-race.png', png);
  await heldUndoUpload.ready();
  await page.getByRole('button', { name: 'Close image chooser', exact: true }).click();
  await page.getByRole('button', { name: 'Undo last edit', exact: true }).click();
  await save();
  heldUndoUpload.release();
  await expect(
    page.getByRole('button', { name: 'Upload an image', exact: true, includeHidden: true }),
  ).toBeEnabled();
  await heldUndoUpload.remove();
  state = await save();
  assert.equal(
    state.assets.some((item) => item.title === 'undo-race'),
    false,
    'A late canvas upload cannot reapply itself after undo',
  );
  near(
    find(screen(state).nodes, rectangle.id).frame.x,
    duringSave.x,
    'Undo retains the scene from before the pending upload',
  );

  const checkpointResponse = await client.post(
    new URL(`/api/projects/${projectId}/versions`, base).href,
    { data: { label: 'Before delayed canvas upload' } },
  );
  assert.equal(checkpointResponse.status(), 201);
  const version = (await checkpointResponse.json()).version;
  const restoreBaseline = structuredClone(screen(state));
  const heldRestoreUpload = await holdResponse(`**/api/projects/${projectId}/assets`, 'POST');
  const heldRestore = await holdResponse(
    `**/api/projects/${projectId}/versions/${version.id}/restore`,
    'POST',
  );
  await uploadPng('restore-race.png', png);
  await heldRestoreUpload.ready();
  await page.getByRole('button', { name: 'Close image chooser', exact: true }).click();
  await page.getByRole('button', { name: 'Project checkpoints', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .locator('.version-row')
    .filter({ hasText: 'Before delayed canvas upload' })
    .getByRole('button', { name: 'Restore', exact: true })
    .click();
  await heldRestore.ready();
  heldRestoreUpload.release();
  await expect(
    page.getByRole('button', { name: 'Upload an image', exact: true, includeHidden: true }),
  ).toBeEnabled();
  heldRestore.release();
  await expect(page.locator('.modal[role="dialog"]')).toHaveCount(0);
  await heldRestoreUpload.remove();
  await heldRestore.remove();
  state = await save();
  assert.equal(
    state.assets.some((item) => item.title === 'restore-race'),
    false,
    'A late upload cannot enter a checkpoint replacement',
  );
  assert.deepEqual(screen(state), restoreBaseline);
  report.push(
    'Inline drafts protect navigation; delayed save responses preserve gestures; undo/restore reject late image insertion',
  );

  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('button', { name: 'Moodboard' })
    .click();
  await page.getByRole('button', { name: `Open ${asset.title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Remove reference', exact: true }).click();
  await expect(
    page.getByText(
      'This image is used on a canvas. Remove its image layers before removing the reference.',
      { exact: true },
    ),
  ).toBeVisible();
  state = await getProject();
  assert.ok(
    state.assets.some((item) => item.id === asset.id),
    'Board removal cannot delete an asset used by a canvas image',
  );
  await page.getByRole('button', { name: 'Close reference', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('button', { name: 'Wireframes' })
    .click();
  await openScreen('Canvas QA');
  report.push('Moodboard deletion preserves images referenced by editable canvas layers');
  await page.screenshot({ path: path.join(screenshots, 'freeform-desktop.png'), fullPage: true });

  await openScreen('Legacy QA');
  const beforeConversion = await getProject();
  assert.equal(screen(beforeConversion, legacyId).canvas, undefined);
  await page.getByRole('button', { name: 'Edit freely', exact: true }).click();
  state = await save();
  const converted = screen(state, legacyId),
    legacy = screen(beforeConversion, legacyId);
  assert.ok(converted.canvas);
  assert.deepEqual(
    flatten(converted.nodes).map((item) => item.id),
    flatten(legacy.nodes).map((item) => item.id),
  );
  for (const item of flatten(legacy.nodes)) {
    const changed = find(converted.nodes, item.id);
    assert.ok(changed.frame);
    assert.equal(changed.text, item.text);
    assert.deepEqual(changed.action, item.action);
  }
  assert.deepEqual(
    state.comments.find((item) => item.id === legacyComment.id),
    legacyComment,
  );
  await page.getByRole('button', { name: 'Undo last edit', exact: true }).click();
  state = await save();
  assert.deepEqual(
    screen(state, legacyId),
    legacy,
    'One undo restores the untouched legacy flow screen',
  );
  await page.getByRole('button', { name: 'Redo last edit', exact: true }).click();
  state = await save();
  assert.deepEqual(screen(state, legacyId), converted);
  report.push(
    'Explicit legacy conversion saves valid geometry, preserves IDs/actions/comments, and reverses in one undo',
  );

  const card = (id, name, x, y, rotation) =>
    layer(id, 'group', name, frame(x, y, 286, 410, rotation), {
      children: [
        layer(id + '_paper', 'rectangle', name + ' paper', frame(0, 0, 286, 410), {
          style: { background: '#ffffff', radius: 22 },
        }),
        layer(id + '_image', 'image', name + ' image', frame(12, 12, 262, 300), {
          image: { assetId: asset.id, fit: 'cover' },
          style: { radius: 15 },
        }),
        layer(id + '_title', 'heading', name + ' title', frame(22, 326, 245, 35), {
          text: 'Your next adventure',
          style: { fontSize: 21, color: '#233d35' },
        }),
        layer(id + '_copy', 'text', name + ' copy', frame(22, 369, 242, 24), {
          text: 'A small escape. A fresh perspective.',
          style: { fontSize: 12, color: '#6f7973' },
        }),
      ],
    });
  state = await writeProject({
    ...state,
    screens: [
      ...state.screens,
      {
        id: swipeId,
        name: 'Swipe composition QA',
        platform: 'mobile',
        state: 'default',
        description: 'Synthetic overlapping editable image cards',
        canvas: { width: 390, height: 720 },
        nodes: [
          layer('qa_swipe_background', 'rectangle', 'Swipe background', frame(0, 0, 390, 720), {
            locked: true,
            style: { background: '#edf3ee' },
          }),
          layer('qa_swipe_brand', 'text', 'Swipe brand', frame(28, 34, 260, 25), {
            text: 'WANDER / DISCOVER',
            style: { fontSize: 12, color: '#547467', fontWeight: 600 },
          }),
          layer('qa_swipe_heading', 'heading', 'Swipe heading', frame(28, 72, 335, 42), {
            text: 'Somewhere new.',
            style: { fontSize: 30, color: '#233d35' },
          }),
          card('qa_swipe_back', 'Swipe back card', 48, 140, -7),
          card('qa_swipe_middle', 'Swipe middle card', 56, 133, 5),
          card('qa_swipe_front', 'Swipe front card', 52, 125, 0),
          layer('qa_swipe_no', 'button', 'Dislike control', frame(98, 580, 76, 76), {
            text: '×',
            style: {
              background: '#ffffff',
              color: '#b67669',
              fontSize: 38,
              radius: 38,
              align: 'center',
            },
          }),
          layer('qa_swipe_yes', 'button', 'Like control', frame(216, 580, 76, 76), {
            text: '♥',
            style: {
              background: '#557d67',
              color: '#ffffff',
              fontSize: 31,
              radius: 38,
              align: 'center',
            },
          }),
          layer('qa_swipe_footer', 'text', 'Swipe footer', frame(55, 676, 280, 20), {
            text: 'TAKE YOUR TIME. FOLLOW YOUR CURIOSITY.',
            style: { fontSize: 9, color: '#6f7973', align: 'center' },
          }),
        ],
      },
    ],
  });
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('button', { name: 'Wireframes' })
    .click();
  await openScreen('Swipe composition QA');
  const swipeBefore = screen(await getProject(), swipeId);
  await pointerDrag(await point(195, 280), await point(205, 285));
  state = await save();
  const front = find(screen(state, swipeId).nodes, 'qa_swipe_front');
  near(front.frame.x, 62, 'Overlapping image card remains freely draggable');
  near(front.frame.y, 130, 'Overlapping image card retains parent-local Y');
  assert.equal(find(screen(state, swipeId).nodes, 'qa_swipe_front_image').image.assetId, asset.id);
  assert.notDeepEqual(front.frame, find(swipeBefore.nodes, 'qa_swipe_front').frame);
  await expect(node('qa_swipe_front_image').locator('img')).toHaveJSProperty('naturalWidth', 400);
  await canvas().screenshot({ path: path.join(screenshots, 'synthetic-swipe-cards.png') });
  await page.screenshot({
    path: path.join(screenshots, 'synthetic-swipe-editor.png'),
    fullPage: true,
  });
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('button', { name: 'Wireframes' })
    .click();
  await openScreen('Swipe composition QA');
  assert.deepEqual(
    screen(await getProject(), swipeId),
    screen(state, swipeId),
    'Scene geometry and asset references survive reload',
  );
  await page.setViewportSize({ width: 430, height: 900 });
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click();
  await assertFitted();
  await expect(page.getByRole('toolbar', { name: 'Canvas tools' })).toBeVisible();
  await page.getByRole('button', { name: 'Place image', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Place image', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'freeform-mobile.png'), fullPage: true });
  report.push(
    'Synthetic swipe composition keeps overlapping image cards editable; save/reload and mobile tools work',
  );
  assert.deepEqual(errors, [], 'No browser runtime errors');
  await rm(path.join(screenshots, 'freeform-failure.png'), { force: true });
  console.log(report.map((item) => 'PASS ' + item).join('\n'));
  console.log('Freeform screenshots: ' + screenshots);
} catch (error) {
  await page
    .screenshot({ path: path.join(screenshots, 'freeform-failure.png'), fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  releaseGates.forEach((release) => release());
  for (const id of ids) {
    const response = await client.delete(new URL(`/api/projects/${id}`, base).href);
    assert.ok(response.ok(), 'Disposable synthetic project cleanup succeeded');
  }
  await context.close();
  await browser.close();
}
