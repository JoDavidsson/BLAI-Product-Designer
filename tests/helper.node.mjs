import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm, readFile, writeFile, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAPABILITIES, PLAN_KEYS, validateJob, validateResult } from '../bridge/schema.mjs';
import { runCodex, runnerEnvironment } from '../bridge/codex-runner.mjs';
import { bridgeHeaders, loadConfig, saveConfig, validateConfig } from '../bridge/config.mjs';
import { createClient, processJob } from '../bridge/client.mjs';
import { parseArguments, prepareLinuxHelper } from '../bridge/configure-linux.mjs';
import { serviceContent, SERVICE_NAME } from '../bridge/install-service.mjs';

const config = () => ({
  site: 'https://designer.example.com',
  bridgeSecret: 'a'.repeat(48),
  accessClientId: 'designer-client',
  accessClientSecret: 'designer-access-secret',
});
const result = () => ({
  title: 'A focused first draft',
  summary: 'A proposal for the plan.',
  reply: 'Review these decisions.',
  plan: Object.fromEntries(
    PLAN_KEYS.map((key) => [
      key,
      key === 'problem' ? 'Help people express product intent clearly.' : null,
    ]),
  ),
  screens: null,
  design: null,
  requirements: [{ text: 'Accepted proposals can be reviewed before applying.', screenId: null }],
});
const job = (overrides = {}) => ({
  id: 'job_1',
  projectId: 'project_1',
  kind: 'plan.assist',
  instruction: 'Clarify the opportunity.',
  baseRevision: 1,
  context: { id: 'project_1', plan: {}, screens: [] },
  leaseToken: 'lease_1',
  leaseExpiresAt: new Date(Date.now() + 45000).toISOString(),
  ...overrides,
});
const node = (id = 'node_1') => ({
  id,
  type: 'button',
  name: 'Continue',
  text: 'Continue',
  children: [],
  style: {
    background: null,
    color: null,
    fontSize: null,
    padding: null,
    gap: null,
    radius: null,
    align: null,
  },
  action: null,
});
const screen = (nodes = [node()]) => ({
  id: 'screen_1',
  name: 'Home',
  platform: 'desktop',
  description: 'Product home.',
  state: 'default',
  nodes,
});
async function temporary(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'designer-helper-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function spawnFixture(events, { hang = false, onSpawn } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      setImmediate(() => child.emit('close', 143));
    };
    onSpawn?.(command, args, options, child);
    setImmediate(() => {
      for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
      if (!hang) child.emit('close', 0);
    });
    return child;
  };
}

test('strict structured output is normalized and rejects unknown fields, excessive nesting and invalid links', () => {
  const normalized = validateResult(result(), job());
  assert.deepEqual(Object.keys(normalized.plan), ['problem']);
  assert.deepEqual(normalized.requirements, [
    { text: 'Accepted proposals can be reviewed before applying.' },
  ]);
  assert.throws(() => validateResult({ ...result(), execute: 'rm -rf /' }, job()), /invalid/);
  const generate = job({ kind: 'wireframe.generate' });
  const draft = { ...result(), screens: [screen()] };
  assert.deepEqual(validateResult(draft, generate).screens[0].nodes[0].style, {});
  draft.screens[0].nodes[0].action = { screenId: 'unknown' };
  assert.throws(() => validateResult(draft, generate), /invalid/);
  draft.screens[0].nodes[0].action = null;
  draft.screens[0].nodes.push(node());
  assert.throws(() => validateResult(draft, generate), /invalid/);
  const nested = node();
  let current = nested;
  for (let i = 1; i <= 10; i++) {
    const child = node(`node_${i + 1}`);
    current.children = [child];
    current = child;
  }
  assert.throws(
    () => validateResult({ ...result(), screens: [screen([nested])] }, generate),
    /invalid/,
  );
});

test('refinement can modify only the selected screen and ordinary jobs cannot return screens', () => {
  const request = job({
    kind: 'wireframe.refine',
    screenId: 'screen_1',
    context: { id: 'project_1', plan: {}, screens: [screen()] },
  });
  assert.equal(
    validateResult({ ...result(), screens: [screen()] }, request).screens[0].id,
    'screen_1',
  );
  assert.throws(() => validateResult({ ...result(), screens: [] }, request), /invalid/);
  assert.throws(() => validateResult({ ...result(), screens: [screen()] }, job()), /invalid/);
});

test('job envelope rejects unsupported actions and excessive context', () => {
  assert.equal(validateJob(job()).kind, 'plan.assist');
  assert.throws(() => validateJob(job({ kind: 'shell.execute' })), /protocol/);
  assert.throws(() => validateJob(job({ unexpected: true })), /protocol/);
  assert.throws(
    () => validateJob(job({ context: { id: 'other', screens: [], plan: {} } })),
    /protocol/,
  );
});

test('runner disables executable tools, protects credentials, returns data and removes temporary artifacts', async () =>
  temporary(async (dir) => {
    let invoked = false;
    const output = await runCodex(job(), {
      workDir: dir,
      spawnProcess: spawnFixture(
        [
          {
            type: 'item.completed',
            item: { type: 'agent_message', text: JSON.stringify(result()) },
          },
        ],
        {
          onSpawn(_command, args, options) {
            invoked = true;
            assert.ok(args.includes('--ignore-user-config'));
            assert.ok(args.includes('--ignore-rules'));
            assert.ok(args.includes('--ephemeral'));
            assert.ok(args.includes('read-only'));
            assert.ok(args.includes('forced_login_method="chatgpt"'));
            assert.ok(args.includes('features.shell_tool=false'));
            assert.ok(args.includes('features.image_generation=false'));
            assert.ok(args.includes('features.plugins=false'));
            assert.equal(options.env.OPENAI_API_KEY, undefined);
            assert.equal(options.env.DESIGNER_BRIDGE_SECRET, undefined);
          },
        },
      ),
    });
    assert.ok(invoked);
    assert.equal(output.plan.problem, result().plan.problem);
    assert.deepEqual(await readdir(dir), []);
    const env = runnerEnvironment({
      HOME: '/private',
      HTTPS_PROXY: 'proxy',
      SSL_CERT_FILE: '/ca',
      OPENAI_API_KEY: 'secret',
      DESIGNER_BRIDGE_SECRET: 'secret',
    });
    assert.deepEqual(env, { HOME: '/private', HTTPS_PROXY: 'proxy', SSL_CERT_FILE: '/ca' });
  }));

test('runner rejects tool attempts, malformed output, timeouts and cancellation', async () =>
  temporary(async (dir) => {
    await assert.rejects(
      runCodex(job(), {
        workDir: dir,
        spawnProcess: spawnFixture(
          [{ type: 'item.started', item: { type: 'command_execution', command: 'anything' } }],
          { hang: true },
        ),
      }),
      /invalid/,
    );
    await assert.rejects(
      runCodex(job(), {
        workDir: dir,
        spawnProcess: spawnFixture([
          { type: 'item.completed', item: { type: 'agent_message', text: '{"code":"bad"}' } },
        ]),
      }),
      /invalid/,
    );
    await assert.rejects(
      runCodex(job(), { workDir: dir, spawnProcess: spawnFixture([null]) }),
      /invalid/,
    );
    await assert.rejects(
      runCodex(job(), {
        workDir: dir,
        timeoutMs: 5,
        spawnProcess: spawnFixture([], { hang: true }),
      }),
      /timeout/,
    );
    const controller = new AbortController();
    const pending = runCodex(job(), {
      workDir: dir,
      signal: controller.signal,
      spawnProcess: spawnFixture([], {
        hang: true,
        onSpawn() {
          setTimeout(() => controller.abort(), 5);
        },
      }),
    });
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(await readdir(dir), []);
  }));

test('HTTP helper protocol carries dedicated credentials, version, capabilities and ownership', async () => {
  const calls = [];
  const client = createClient(config(), {
    workerId: 'worker_1',
    fetcher: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      const body = JSON.parse(options.body);
      const response =
        body.action === 'claim'
          ? { protocolVersion: 1, job: job() }
          : body.action === 'heartbeat'
            ? { ok: true, cancelled: false }
            : { ok: true };
      return Response.json(response);
    },
  });
  const claimed = await client.claim();
  await client.heartbeat(claimed);
  await client.complete(claimed, { result: validateResult(result(), claimed) });
  assert.equal(calls[0].url.pathname, '/api/codex');
  assert.deepEqual(calls[0].body, {
    action: 'claim',
    protocolVersion: 1,
    workerId: 'worker_1',
    capabilities: [...CAPABILITIES],
  });
  assert.equal(calls[0].options.headers['x-designer-bridge-key'], config().bridgeSecret);
  assert.equal(calls[0].options.headers['CF-Access-Client-Secret'], config().accessClientSecret);
  assert.equal(calls[0].options.headers['x-writing-bridge-key'], undefined);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[2].body.leaseToken, 'lease_1');
});

test('client rejects mismatched versions and HTML login responses', async () => {
  const client = createClient(config(), {
    fetcher: async () => Response.json({ protocolVersion: 2, job: null }),
  });
  await assert.rejects(client.claim(), /protocol/);
  const login = createClient(config(), {
    fetcher: async () =>
      new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }),
  });
  await assert.rejects(login.claim(), /protocol/);
});

test('cancelled and lost leases stop execution without publishing results', async () => {
  for (const state of ['cancelled', 'lost']) {
    let completed = false;
    const client = {
      heartbeat: async () => {
        if (state === 'lost') throw new Error('offline');
        return { ok: true, cancelled: true };
      },
      complete: async () => {
        completed = true;
      },
    };
    const status = await processJob(client, job(), {
      heartbeatMs: 3,
      run: (_job, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
        ),
    });
    assert.equal(status, 'cancelled');
    assert.equal(completed, false);
  }
});

test('completion retries transient errors and reports a bounded failure category', async () => {
  let attempts = 0,
    outcome;
  const client = {
    heartbeat: async () => ({ ok: true, cancelled: false }),
    complete: async (_job, value) => {
      outcome = value;
      if (++attempts < 2) throw new Error('offline');
    },
  };
  assert.equal(
    await processJob(client, job(), {
      retryMs: 1,
      run: async () => {
        throw new Error('login');
      },
    }),
    'login',
  );
  assert.equal(attempts, 2);
  assert.deepEqual(outcome, { error: 'login' });
});

test('configuration validates HTTPS and service tokens and refuses symlink or public credentials', async () =>
  temporary(async (dir) => {
    assert.equal(validateConfig(config()).site, config().site);
    assert.throws(
      () => validateConfig({ ...config(), site: 'https://user:pass@example.com' }),
      /origin/,
    );
    assert.throws(
      () => validateConfig({ ...config(), site: 'http://remote.example.com' }),
      /HTTPS/,
    );
    assert.throws(() => validateConfig({ ...config(), accessClientSecret: undefined }), /both/);
    const filename = path.join(dir, 'settings.json');
    await saveConfig(filename, config());
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await saveConfig(filename, config());
    await assert.rejects(
      saveConfig(filename, { ...config(), bridgeSecret: 'b'.repeat(48) }),
      /left unchanged/,
    );
    const alias = path.join(dir, 'alias.json');
    await symlink(filename, alias);
    await assert.rejects(loadConfig(alias), /normal JSON/);
    await chmod(filename, 0o644);
    await assert.rejects(loadConfig(filename), /private/);
    assert.deepEqual(bridgeHeaders(config())['x-designer-bridge-key'], config().bridgeSecret);
  }));

test('Linux setup is noninteractive, requires subscription login and keeps a separate service', async () =>
  temporary(async (dir) => {
    const source = path.join(dir, 'download.json');
    await writeFile(source, JSON.stringify(config()), { mode: 0o600 });
    const destination = path.join(dir, '.designer/config.json');
    const run = (_command, args) =>
      args[0] === 'login'
        ? { status: 0, stdout: 'Logged in using ChatGPT' }
        : { status: 0, stdout: '--ignore-user-config --ignore-rules --ephemeral --output-schema' };
    assert.equal(await prepareLinuxHelper(source, { configPath: destination, run }), destination);
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), config());
    await assert.rejects(
      prepareLinuxHelper(source, {
        configPath: destination,
        run: () => ({ status: 0, stdout: 'Logged in using API key' }),
      }),
      /subscription/,
    );
    assert.deepEqual(
      parseArguments(['--settings', source, '--config', destination, '--install-service']),
      { settings: source, config: destination, 'install-service': true },
    );
    assert.equal(SERVICE_NAME, 'blai-designer-codex.service');
    const unit = serviceContent({
      configPath: destination,
      rootDir: '/some/designer',
      executablePath: '/usr/bin',
    });
    assert.ok(unit.includes('bridge/start.mjs'));
    assert.ok(unit.includes('UMask=0077'));
    assert.ok(!unit.includes('writing-partner'));
    assert.throws(
      () => serviceContent({ configPath: '/tmp/injected\nExecStart=bad' }),
      /line breaks/,
    );
  }));
