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
const errors = [];
const externalRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (request.url().includes('pele-test.invalid')) externalRequests.push(request.url());
});
// Any unexpected fetch fails the assertion without contacting an external service.
await page.route('https://pele-test.invalid/**', (route) => route.abort());
let projectId, otherProjectId;

async function readProject(id = projectId) {
  const response = await context.request.get(`${baseURL}/api/projects/${id}`);
  assert.equal(response.status(), 200);
  return (await response.json()).project;
}
async function openFlows() {
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'See how it all connects.' })).toBeVisible();
}
async function previewReady() {
  await expect(page.locator('.flow-render-status')).toHaveText('Preview ready');
  await expect(page.locator('.flow-svg > svg')).toBeVisible();
}
async function checkZoom({ keyboard = false } = {}) {
  const svg = page.locator('.flow-svg > svg');
  await expect(page.locator('.flow-svg .pele-zoom')).toHaveCount(1);
  const original = await svg.getAttribute('viewBox');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(svg).not.toHaveAttribute('viewBox', original);
  await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
  await expect(svg).toHaveAttribute('viewBox', original);
  if (keyboard) {
    await svg.focus();
    await svg.press('+');
    await expect(svg).not.toHaveAttribute('viewBox', original);
    await svg.press('0');
    await expect(svg).toHaveAttribute('viewBox', original);
  }
}

try {
  for (const title of ['Pele browser verification', 'Pele project isolation']) {
    const response = await context.request.post(`${baseURL}/api/projects`, {
      data: { title, sample: true },
    });
    assert.equal(response.status(), 201);
    const id = (await response.json()).project.id;
    if (!projectId) projectId = id;
    else otherProjectId = id;
  }
  await context.addInitScript((id) => {
    localStorage.setItem('blai-project', id);
    window.__peleInjected = false;
  }, projectId);
  await page.goto(baseURL);
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(projectId);
  await openFlows();
  await expect(
    page.getByRole('heading', { name: 'Every great product has a path.' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'New user flow', exact: true }).click();
  await previewReady();
  await expect(page.locator('.flow-svg .pele-node')).toHaveCount(6);
  await expect(page.locator('.flow-svg')).toContainText('Explore options');
  const flowSource =
    'flowchart LR\n  explore[Explore cafés] --> choice{Save a place?}\n  choice -->|Yes| saved[Saved places]\n  choice -->|Later| explore\n';
  await page.getByLabel('Diagram name', { exact: true }).fill('Discover and save');
  await page.getByLabel('User flow source', { exact: true }).fill(flowSource);
  await previewReady();
  await expect(page.locator('.flow-svg')).toContainText('Explore cafés');
  await expect.poll(async () => (await readProject()).diagrams?.[0]?.source).toBe(flowSource);
  const flowId = (await readProject()).diagrams[0].id;

  // A temporarily blank name must be editable without overwriting the saved title.
  const name = page.getByLabel('Diagram name', { exact: true });
  await name.fill('');
  await expect(name).toHaveValue('');
  assert.equal((await readProject()).diagrams[0].title, 'Discover and save');
  await page.getByLabel('User flow source', { exact: true }).focus();
  await expect(name).toHaveValue('Discover and save');
  await name.fill('   ');
  await name.press('Tab');
  await expect(name).toHaveValue('Discover and save');

  // A larger drawing stays explorable, and rerenders cannot leak controls/listeners.
  const longSource =
    'flowchart TD\n' +
    Array.from(
      { length: 11 },
      (_, index) => `  step${index}[Step ${index + 1}] --> step${index + 1}[Step ${index + 2}]`,
    ).join('\n');
  await page.getByLabel('User flow source', { exact: true }).fill(longSource);
  await previewReady();
  await expect(page.locator('.flow-svg .pele-node')).toHaveCount(12);
  await checkZoom({ keyboard: true });
  await page.getByLabel('User flow source', { exact: true }).fill(flowSource);
  await previewReady();
  await checkZoom();

  await page.getByRole('button', { name: 'New screen states', exact: true }).click();
  await previewReady();
  await checkZoom();
  await expect(page.locator('.flow-svg')).toContainText('Request failed');
  const stateSource =
    'stateDiagram-v2\n  [*] --> Loading\n  Loading --> Ready: Places found\n  Loading --> Empty: No places yet\n  Loading --> Error: Connection lost\n  Error --> Loading: Retry\n';
  await page.getByLabel('Diagram name', { exact: true }).fill('Saved places states');
  await page.getByLabel('Screen states source', { exact: true }).fill(stateSource);
  await previewReady();
  await expect(page.locator('.flow-svg')).toContainText('Connection lost');
  await expect.poll(async () => (await readProject()).diagrams?.[1]?.source).toBe(stateSource);
  const stateId = (await readProject()).diagrams[1].id;

  await page.reload();
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(projectId);
  await openFlows();
  await expect(page.getByLabel('User flow source', { exact: true })).toHaveValue(flowSource);
  await page.getByRole('button', { name: 'Saved places states', exact: true }).click();
  await expect(page.getByLabel('Screen states source', { exact: true })).toHaveValue(stateSource);
  await previewReady();
  await checkZoom();
  await page.getByRole('button', { name: 'Discover and save', exact: true }).click();
  await previewReady();
  await checkZoom({ keyboard: true });
  await page.getByRole('button', { name: 'Saved places states', exact: true }).click();
  await previewReady();
  await expect(page.locator('.flow-svg .pele-zoom')).toHaveCount(1);

  // Invalid drafts are preserved, but must not masquerade as a valid preview.
  const invalidSource = 'stateDiagram-v2\n  state "unfinished';
  await page.getByLabel('Screen states source', { exact: true }).fill(invalidSource);
  await expect(page.locator('.flow-render-error')).toBeVisible();
  await expect(page.locator('.flow-render-error')).toContainText('Your source is kept');
  await expect(page.locator('.flow-svg')).toHaveCount(0);
  await expect.poll(async () => (await readProject()).diagrams[1].source).toBe(invalidSource);

  // The handoff preserves exact Mermaid source, including incomplete drafts.
  await page.getByRole('button', { name: 'Handoff', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download specification', exact: true }).click();
  const zip = unzipSync(await fs.readFile(await (await downloading).path()));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  assert.equal(manifest.diagrams.length, 2);
  assert.equal(strFromU8(zip[`diagrams/${flowId}.mmd`]), flowSource);
  assert.equal(strFromU8(zip[`diagrams/${stateId}.mmd`]), invalidSource);
  assert.deepEqual(
    manifest.diagrams.map(({ id, path }) => ({ id, path })),
    [
      { id: flowId, path: `diagrams/${flowId}.mmd` },
      { id: stateId, path: `diagrams/${stateId}.mmd` },
    ],
  );
  assert.match(strFromU8(zip['CODEX.md']), /incomplete or invalid drafts/);
  await openFlows();
  await page.getByRole('button', { name: 'Saved places states', exact: true }).click();
  await expect(page.getByLabel('Screen states source', { exact: true })).toHaveValue(invalidSource);
  await page.getByLabel('Screen states source', { exact: true }).fill(stateSource);
  await previewReady();
  await expect(page.locator('.flow-render-error')).toHaveCount(0);

  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByLabel('Diagram name', { exact: true })).toHaveValue(
    'Saved places states (copy)',
  );
  await expect(page.getByLabel('Screen states source', { exact: true })).toHaveValue(stateSource);
  await expect.poll(async () => (await readProject()).diagrams.length).toBe(3);
  const duplicated = (await readProject()).diagrams[2];
  assert.notEqual(duplicated.id, stateId);
  await page.getByRole('button', { name: 'Delete diagram', exact: true }).click();
  await expect(page.getByRole('button', { name: duplicated.title, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo last edit', exact: true }).click();
  await expect(page.getByRole('button', { name: duplicated.title, exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      (await readProject()).diagrams.some((diagram) => diagram.id === duplicated.id),
    )
    .toBe(true);

  // A queued edit is flushed before switching projects, and never leaks to the next one.
  await page.getByRole('button', { name: 'Discover and save', exact: true }).click();
  const switchedSource = flowSource + '  saved --> return[Return tomorrow]\n';
  await page.getByLabel('User flow source', { exact: true }).fill(switchedSource);
  await page.getByLabel('Current project', { exact: true }).selectOption(otherProjectId);
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(otherProjectId);
  await openFlows();
  await expect(
    page.getByRole('heading', { name: 'Every great product has a path.' }),
  ).toBeVisible();
  assert.equal((await readProject(otherProjectId)).diagrams?.length ?? 0, 0);
  assert.equal((await readProject()).diagrams[0].source, switchedSource);
  await page.getByRole('button', { name: 'New user flow', exact: true }).click();
  await page.getByLabel('Diagram name', { exact: true }).fill('Only in second project');
  await page.getByLabel('Current project', { exact: true }).selectOption(projectId);
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(projectId);
  await openFlows();
  await expect(page.getByLabel('User flow source', { exact: true })).toHaveValue(switchedSource);
  await expect(
    page.getByRole('button', { name: 'Only in second project', exact: true }),
  ).toHaveCount(0);

  // These labels, click targets, and node images must remain inert in the actual DOM.
  const hostileSource = `flowchart LR
  A["<img src='https://pele-test.invalid/label.png' onerror='window.__peleInjected=true'>"]
  B["</text><script>window.__peleInjected=true</script>"]
  A --> B
  C@{ img: "https://pele-test.invalid/node.png", label: "External image" }
  B --> C
  click A "javascript:window.__peleInjected=true"
  click B "https://pele-test.invalid/click"`;
  await page.getByLabel('User flow source', { exact: true }).fill(hostileSource);
  await previewReady();
  await expect(
    page.locator(
      '.flow-svg script, .flow-svg foreignObject, .flow-svg img, .flow-svg image, .flow-svg a[href]',
    ),
  ).toHaveCount(0);
  assert.equal(
    await page
      .locator('.flow-svg')
      .evaluate((root) =>
        [...root.querySelectorAll('*')].some((element) =>
          [...element.attributes].some((attribute) => /^on/i.test(attribute.name)),
        ),
      ),
    false,
    'rendered SVG must not contain event handler attributes',
  );
  await page.locator('.flow-svg').click();
  assert.equal(await page.evaluate(() => window.__peleInjected), false);
  assert.deepEqual(externalRequests, []);
  await page.getByLabel('User flow source', { exact: true }).fill(switchedSource);
  await previewReady();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('User flow source', { exact: true })).toBeVisible();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    true,
    'the diagram workspace must fit a narrow viewport without page-level horizontal overflow',
  );
  await page.locator('.flow-preview-panel').scrollIntoViewIfNeeded();
  await expect(page.locator('.flow-svg > svg')).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    'Flows browser checks passed: real Pele flow and state SVGs, autosave/reload, blank-name recovery, button/keyboard zoom and reset across rerenders and tabs, invalid draft handling and recovery, exact Mermaid ZIP export, duplicate/delete/undo, project isolation, inert untrusted source, narrow layout.',
  );
} finally {
  await page.close();
  if (projectId) await context.request.delete(`${baseURL}/api/projects/${projectId}`);
  if (otherProjectId) await context.request.delete(`${baseURL}/api/projects/${otherProjectId}`);
  await browser.close();
}
