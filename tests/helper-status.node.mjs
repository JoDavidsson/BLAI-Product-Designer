import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../bridge/start.mjs', import.meta.url));
const job = {
  id: 'fixture_job',
  projectId: 'fixture_project',
  kind: 'plan.assist',
  instruction: 'Private fixture content.',
  baseRevision: 1,
  context: { id: 'fixture_project', plan: {}, screens: [] },
  leaseToken: 'fixture_lease',
  leaseExpiresAt: new Date(Date.now() + 45000).toISOString(),
};

async function withHelper(claim, run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'designer-ipc-'));
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        body.action === 'claim'
          ? claim
          : body.action === 'heartbeat'
            ? { ok: true, cancelled: false }
            : { ok: true },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let child;
  try {
    const filename = path.join(directory, 'config.json');
    await writeFile(
      filename,
      JSON.stringify({
        site: `http://127.0.0.1:${server.address().port}`,
        bridgeSecret: 'private-fixture-key'.repeat(3),
        codexPath: path.join(directory, 'nonexistent-codex'),
      }),
      { mode: 0o600 },
    );
    child = fork(entry, [filename], {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, HOME: directory },
    });
    const messages = [];
    child.on('message', (message) => messages.push(message));
    const waitFor = (state) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Missing IPC state: ${state}`)), 5000);
        function finish(error) {
          clearTimeout(timer);
          child.removeListener('message', check);
          error ? reject(error) : resolve();
        }
        function check() {
          if (messages.some((message) => message.state === state)) finish();
        }
        child.on('message', check);
        check();
      });
    await run({ child, messages, waitFor });
    for (const message of messages) {
      assert.deepEqual(Object.keys(message).sort(), ['state', 'type']);
      assert.equal(message.type, 'blai-helper-status');
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('IPC reports connected and busy only after a designer claim, then stopping without content', () =>
  withHelper({ protocolVersion: 1, job }, async ({ child, messages, waitFor }) => {
    await waitFor('busy');
    assert.deepEqual(
      messages.slice(0, 2).map((message) => message.state),
      ['connected', 'busy'],
    );
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Worker IPC prevented graceful shutdown')),
        5000,
      );
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    child.kill('SIGTERM');
    await waitFor('stopping');
    assert.equal(await exited, 0);
    assert.equal(messages.at(-1).state, 'stopping');
  }));

test('an incompatible claim reports offline without reporting connected', () =>
  withHelper({ unexpected: true }, async ({ child, messages, waitFor }) => {
    await waitFor('offline');
    assert.equal(
      messages.some((message) => message.state === 'connected'),
      false,
    );
    child.kill('SIGTERM');
    await waitFor('stopping');
  }));

test('losing the manager IPC connection shuts down the worker', () =>
  withHelper({ protocolVersion: 1, job: null }, async ({ child, waitFor }) => {
    await waitFor('connected');
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Worker did not stop after IPC disconnect')),
        5000,
      );
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    child.disconnect();
    assert.equal(await exited, 0);
  }));
