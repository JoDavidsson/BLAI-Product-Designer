import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// Run against an already-started, locally authenticated Vite/Worker environment.
// Uses a dedicated sample project and an isolated browser context.
const baseURL = process.env.BLAI_TEST_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: process.env.BLAI_CHROMIUM || '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let projectId;
let otherProjectId;

try {
  const created = await context.request.post(`${baseURL}/api/projects`, {
    data: { title: 'Board browser verification', sample: true },
  });
  assert.equal(created.status(), 201);
  projectId = (await created.json()).project.id;
  const otherCreated = await context.request.post(`${baseURL}/api/projects`, {
    data: { title: 'Upload switch verification' },
  });
  assert.equal(otherCreated.status(), 201);
  otherProjectId = (await otherCreated.json()).project.id;
  await context.addInitScript((id) => localStorage.setItem('blai-project', id), projectId);
  await page.goto(baseURL);
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(projectId);

  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 640;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f1ede6';
      ctx.fillRect(0, 0, 960, 640);
      ctx.fillStyle = '#ece2d4';
      ctx.fillRect(560, 0, 400, 640);
      ctx.fillStyle = '#343f37';
      ctx.font = '22px Georgia';
      ctx.fillText('A LITTLE ROOM TO EXPLORE', 56, 84);
      ctx.font = '54px Georgia';
      ctx.fillText('Take the', 56, 232);
      ctx.fillText('scenic route.', 56, 294);
      ctx.fillStyle = '#7b8578';
      ctx.font = '18px sans-serif';
      ctx.fillText('Thoughtful trips. A slower pace.', 59, 352);
      ctx.fillStyle = '#82977e';
      ctx.beginPath();
      ctx.roundRect(56, 398, 190, 53, 27);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '16px sans-serif';
      ctx.fillText('Find your next place', 80, 430);
      ctx.fillStyle = '#c0b69f';
      ctx.beginPath();
      ctx.ellipse(760, 360, 130, 230, -0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#799181';
      ctx.beginPath();
      ctx.ellipse(800, 310, 116, 160, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ddcfb4';
      ctx.beginPath();
      ctx.ellipse(720, 430, 120, 100, 0.2, 0, Math.PI * 2);
      ctx.fill();
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );

  async function readProject() {
    return (await (await context.request.get(`${baseURL}/api/projects/${projectId}`)).json())
      .project;
  }
  async function upload(name, kind) {
    await page
      .getByRole('button', {
        name: kind === 'reference' ? 'Add reference' : 'Add screenshots',
        exact: true,
      })
      .click();
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name, mimeType: 'image/png', buffer: png });
    await expect(page.locator('.board-add-dialog')).not.toBeVisible();
    await expect
      .poll(async () =>
        (await readProject()).assets.some(
          (asset) => asset.kind === kind && asset.title === name.replace('.png', ''),
        ),
      )
      .toBeTruthy();
  }
  async function pinComment(body) {
    await page.getByRole('button', { name: 'Pin a comment', exact: true }).click();
    const image = await page.locator('.board-image-wrapper').boundingBox();
    assert.ok(image);
    await page.mouse.click(image.x + image.width * 0.38, image.y + image.height * 0.44);
    await page.getByRole('textbox', { name: 'New comment', exact: true }).fill(body);
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.locator('.annotation-body').filter({ hasText: body })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Moodboard', exact: true }).click();
  await upload('Warm direction.png', 'reference');
  await page.getByRole('button', { name: 'Open Warm direction', exact: true }).click();
  await expect(page.locator('.board-viewer')).toBeVisible();
  await expect(page.locator('.board-image-wrapper > img')).toHaveJSProperty('naturalWidth', 960);
  await pinComment('Keep the warm paper background and the generous breathing room.');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Reply to comment', exact: true })
    .fill('Use this direction on the trip overview.');
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await expect(
    page.getByText('Use this direction on the trip overview.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Linked requirement' })).toBeVisible();

  await page
    .getByRole('textbox', { name: 'Reference title', exact: true })
    .fill('Quiet confidence');
  await page.getByRole('textbox', { name: 'Reference note', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Reference note', exact: true })
    .fill('Natural colors and deliberate whitespace.');
  await page.getByRole('textbox', { name: 'Reference source URL', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Reference source URL', exact: true })
    .fill('https://example.com/design-reference');
  await page.getByRole('textbox', { name: 'Reference source URL', exact: true }).press('Tab');
  await expect
    .poll(async () => {
      const project = await readProject(),
        asset = project.assets.find((asset) => asset.title === 'Quiet confidence');
      return Boolean(
        asset?.title === 'Quiet confidence' &&
        asset.note === 'Natural colors and deliberate whitespace.' &&
        asset.sourceUrl === 'https://example.com/design-reference' &&
        project.comments.some(
          (comment) =>
            comment.target.assetId === asset.id &&
            comment.status === 'accepted' &&
            comment.replies.length === 1,
        ),
      );
    })
    .toBeTruthy();
  let saved = await readProject();
  const referenceId = saved.assets.find((asset) => asset.title === 'Quiet confidence').id;
  const comment = saved.comments.find((comment) => comment.target.assetId === referenceId);
  assert.ok(Math.abs(comment.target.x - 0.38) < 0.01 && Math.abs(comment.target.y - 0.44) < 0.01);
  assert.equal(
    saved.requirements.find((requirement) => requirement.id === comment.requirementId)
      .sourceCommentId,
    comment.id,
  );
  await page.screenshot({ path: '/tmp/blai-board.png', fullPage: true });
  await page.getByRole('link', { name: 'Linked requirement' }).click();
  await expect(page.locator(`#requirement-${comment.requirementId}`)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(projectId);
  await page.getByRole('button', { name: 'Moodboard', exact: true }).click();
  await page.getByRole('button', { name: 'Open Quiet confidence', exact: true }).click();
  await expect(
    page.getByText('Use this direction on the trip overview.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Reference note', exact: true })).toHaveValue(
    'Natural colors and deliberate whitespace.',
  );
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readProject()).requirements.find(
          (requirement) => requirement.id === comment.requirementId,
        )?.status,
    )
    .toBe('proposed');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.locator('.annotation-thread')).toHaveCount(0);
  await page.getByLabel('Show resolved (1)').check();
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.getByRole('button', { name: 'Close reference', exact: true }).click();

  await page.getByRole('button', { name: 'Build review', exact: true }).click();
  await upload('Implementation screenshot.png', 'screenshot');
  await page.getByRole('button', { name: 'Open Implementation screenshot', exact: true }).click();
  await pinComment('Increase the spacing above the primary action.');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect
    .poll(async () =>
      (await readProject()).comments.some(
        (comment) =>
          comment.body === 'Increase the spacing above the primary action.' &&
          comment.status === 'accepted',
      ),
    )
    .toBeTruthy();
  saved = await readProject();
  const screenshotId = saved.assets.find((asset) => asset.title === 'Implementation screenshot').id;
  const screenshotComment = saved.comments.find(
    (comment) => comment.target.assetId === screenshotId,
  );
  await page.getByRole('button', { name: 'Remove reference', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm remove reference', exact: true }).click();
  await expect(page.locator('.board-viewer')).not.toBeVisible();
  await expect
    .poll(async () => !(await readProject()).assets.some((asset) => asset.id === screenshotId))
    .toBeTruthy();
  saved = await readProject();
  assert.equal(
    saved.comments.find((comment) => comment.id === screenshotComment.id).target.kind,
    'project',
  );
  assert.ok(
    saved.comments
      .find((comment) => comment.id === screenshotComment.id)
      .previousLocation.includes('Implementation screenshot'),
  );
  assert.equal(
    saved.requirements.find((requirement) => requirement.id === screenshotComment.requirementId)
      .sourceCommentId,
    screenshotComment.id,
  );
  assert.equal(
    saved.requirements.find((requirement) => requirement.id === screenshotComment.requirementId)
      .status,
    'accepted',
  );
  assert.equal(
    saved.requirements.filter((requirement) => requirement.id === comment.requirementId).length,
    1,
  );

  // A slow response must never restore the Board's older project after navigating
  // away and making a newer plan edit. Pause a real R2 upload response to exercise it.
  await page.getByRole('button', { name: 'Moodboard', exact: true }).click();
  let releaseUpload;
  let markUploadReady;
  const uploadReady = new Promise((resolve) => {
    markUploadReady = resolve;
  });
  const uploadGate = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const delayedUrl = `${baseURL}/api/projects/${projectId}/assets`;
  await page.route(delayedUrl, async (route) => {
    const response = await route.fetch();
    markUploadReady();
    await uploadGate;
    try {
      await route.fulfill({ response });
    } catch {
      /* The Board intentionally aborts on unmount. */
    }
  });
  // Setting the input directly has the same non-modal transfer behavior as dropping a file.
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'Late upload.png', mimeType: 'image/png', buffer: png });
  await uploadReady;
  await page.getByRole('button', { name: 'Product plan', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Image transfer cancelled');
  const newerProblem = 'This newer plan edit must survive a delayed moodboard upload response.';
  await page
    .getByRole('textbox', { name: 'Problem & opportunity', exact: true })
    .fill(newerProblem);
  releaseUpload();
  await expect.poll(async () => (await readProject()).plan.problem).toBe(newerProblem);
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(projectId);
  assert.equal(
    (await readProject()).assets.some((asset) => asset.title === 'Late upload'),
    false,
  );
  await page.unroute(delayedUrl);

  // Switching projects during a transfer must also leave both projects intact.
  await page.getByRole('button', { name: 'Moodboard', exact: true }).click();
  let releaseSwitchUpload;
  let markSwitchUploadReady;
  const switchUploadReady = new Promise((resolve) => {
    markSwitchUploadReady = resolve;
  });
  const switchUploadGate = new Promise((resolve) => {
    releaseSwitchUpload = resolve;
  });
  await page.route(delayedUrl, async (route) => {
    const response = await route.fetch();
    markSwitchUploadReady();
    await switchUploadGate;
    try {
      await route.fulfill({ response });
    } catch {
      /* Navigation has cancelled this transfer. */
    }
  });
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'Old project upload.png', mimeType: 'image/png', buffer: png });
  await switchUploadReady;
  await page.getByLabel('Current project', { exact: true }).selectOption(otherProjectId);
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(otherProjectId);
  await page
    .getByRole('textbox', { name: 'Project summary', exact: true })
    .fill('New project edits stay in the new project.');
  releaseSwitchUpload();
  await expect
    .poll(
      async () =>
        (await (await context.request.get(`${baseURL}/api/projects/${otherProjectId}`)).json())
          .project.summary,
    )
    .toBe('New project edits stay in the new project.');
  await expect(page.getByLabel('Current project', { exact: true })).toHaveValue(otherProjectId);
  assert.equal(
    (await readProject()).assets.some((asset) => asset.title === 'Old project upload'),
    false,
  );
  assert.equal((await readProject()).plan.problem, newerProblem);
  await page.unroute(delayedUrl);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        projectId,
        screenshot: '/tmp/blai-board.png',
        checks: [
          'upload',
          'image decoding',
          'normalized pins',
          'comments',
          'replies',
          'acceptance links',
          'metadata persistence',
          'reload persistence',
          'resolve/reopen synchronizes requirement',
          'screenshot review',
          'delete preserving requirements',
          'delayed upload cannot overwrite newer plan edits',
          'delayed upload cannot switch or overwrite another project',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  // This project is a fixture only; uploaded objects are removed with it.
  if (projectId) await context.request.delete(`${baseURL}/api/projects/${projectId}`);
  if (otherProjectId) await context.request.delete(`${baseURL}/api/projects/${otherProjectId}`);
  await browser.close();
}
