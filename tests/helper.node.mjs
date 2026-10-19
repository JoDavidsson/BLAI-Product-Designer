import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm, readFile, writeFile, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  CAPABILITIES,
  CANVAS_CAPABILITY,
  PLAN_KEYS,
  validateJob,
  validateResult,
  validateTelemetry,
  usageFromCodex,
  DESIGNER_HELPER_VERSION,
} from '../bridge/schema.mjs';
import { helperVersion } from '../bridge/start.mjs';
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
  assert.throws(
    () => validateJob(job({ context: { id: 'project_1', screens: [], plan: null } })),
    /protocol/,
  );
});

function canvasDraft() {
  const pathNode = {
    ...node('drawn_line'),
    type: 'path',
    frame: { x: -5, y: 12, width: 90, height: 30, rotation: 15 },
    points: [
      { x: 0, y: 1 },
      { x: 0.5, y: 0 },
      { x: 1, y: 1 },
    ],
    style: { ...node().style, stroke: '#123456', strokeWidth: 2, opacity: 0.7, fontWeight: null },
  };
  return {
    ...result(),
    screens: [
      {
        ...screen(),
        canvas: { width: 390, height: 844 },
        nodes: [
          {
            ...node('group_one'),
            type: 'group',
            frame: { x: 24, y: 60, width: 340, height: 600, rotation: -3 },
            layout: 'free',
            locked: false,
            hidden: false,
            children: [
              pathNode,
              {
                ...node('photo'),
                type: 'image',
                frame: { x: 0, y: 50, width: 340, height: 400, rotation: 0 },
                image: { assetId: 'owned_photo', fit: 'cover' },
              },
            ],
          },
        ],
      },
    ],
  };
}
function canvasJob(kind = 'wireframe.generate') {
  return job({
    kind,
    ...(kind === 'wireframe.refine' ? { screenId: 'screen_1' } : {}),
    context: {
      id: 'project_1',
      plan: {},
      screens: [],
      assets: [{ id: 'owned_photo', imageUrl: '/api/assets/photo' }],
    },
  });
}

test('freeform output preserves editable geometry and validates shape, bounds and owned image references', () => {
  const request = canvasJob();
  const draft = canvasDraft();
  const normalized = validateResult(draft, request, { canvas: true });
  assert.deepEqual(normalized.screens[0].canvas, { width: 390, height: 844 });
  assert.deepEqual(normalized.screens[0].nodes[0].frame, draft.screens[0].nodes[0].frame);
  assert.deepEqual(
    normalized.screens[0].nodes[0].children[0].points,
    draft.screens[0].nodes[0].children[0].points,
  );
  assert.equal(normalized.screens[0].nodes[0].locked, false);
  assert.equal(normalized.screens[0].nodes[0].children[0].style.fontWeight, undefined);
  assert.deepEqual(draft, canvasDraft(), 'validation must not mutate the proposal');
  for (const corrupt of [
    (s) => {
      delete s.canvas;
    },
    (s) => {
      s.canvas.width = 99;
    },
    (s) => {
      delete s.nodes[0].children[0].frame;
    },
    (s) => {
      s.nodes[0].frame.width = 0;
    },
    (s) => {
      s.nodes[0].frame.x = 20001;
    },
    (s) => {
      s.nodes[0].frame.rotation = 361;
    },
    (s) => {
      s.nodes[0].frame.transform = 'translate(20px)';
    },
    (s) => {
      s.nodes[0].hidden = 'yes';
    },
    (s) => {
      s.nodes[0].children[0].points = [{ x: 0, y: 0 }];
    },
    (s) => {
      s.nodes[0].children[0].points[0].x = -0.1;
    },
    (s) => {
      s.nodes[0].children[0].points = Array.from({ length: 257 }, () => ({ x: 0, y: 0 }));
    },
    (s) => {
      s.nodes[0].children[0].style.opacity = 1.01;
    },
    (s) => {
      s.nodes[0].children[0].style.fontWeight = 900;
    },
    (s) => {
      s.nodes[0].children[0].layout = 'row';
    },
    (s) => {
      s.nodes[0].children[0].type = 'line';
    },
    (s) => {
      s.nodes[0].children[1].image.assetId = 'foreign_photo';
    },
    (s) => {
      s.nodes[0].children[1].image.src = 'https://example.com/photo.png';
    },
    (s) => {
      s.nodes[0].children[1].type = 'rectangle';
    },
  ]) {
    const invalid = canvasDraft();
    corrupt(invalid.screens[0]);
    assert.throws(() => validateResult(invalid, request, { canvas: true }), /invalid/);
  }
  assert.throws(
    () =>
      validateResult(draft, {
        ...request,
        context: { ...request.context, assets: [{ id: 'owned_photo', imageUrl: '' }] },
      }),
    /invalid/,
  );
  const legacy = { ...result(), screens: [screen()] };
  assert.deepEqual(
    validateResult(legacy, job({ kind: 'wireframe.generate' })),
    validateResult(legacy, job({ kind: 'wireframe.generate' }), { canvas: false }),
  );
  assert.throws(() => validateResult(draft, request, { canvas: false }), /invalid/);
  const existing = { ...request, context: { ...request.context, screens: normalized.screens } };
  assert.throws(() => validateResult(legacy, existing), /invalid/);
});

test('runner chooses negotiated output schema and never strips an existing canvas for a legacy server', async () =>
  temporary(async (dir) => {
    for (const canvas of [false, true]) {
      const request = canvasJob();
      const expected = canvas ? canvasDraft() : { ...result(), screens: [screen()] };
      let schema;
      const output = await runCodex(request, {
        workDir: dir,
        canvas,
        spawnProcess: spawnFixture(
          [
            {
              type: 'item.completed',
              item: { type: 'agent_message', text: JSON.stringify(expected) },
            },
          ],
          {
            onSpawn(_command, args) {
              schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
              assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
              assert.ok(args.includes('model_reasoning_effort="medium"'));
              assert.ok(args.includes('model_context_window=872000'));
            },
          },
        ),
      });
      assert.equal(Object.hasOwn(schema.$defs.screen.properties, 'canvas'), canvas);
      assert.equal(schema.$defs.node.properties.type.enum.includes('path'), canvas);
      assert.equal(!!output.screens[0].canvas, canvas);
    }
    const request = canvasJob('wireframe.refine');
    request.context.screens = canvasDraft().screens;
    await assert.rejects(
      runCodex(request, {
        workDir: dir,
        canvas: false,
        spawnProcess() {
          assert.fail('Legacy workers must never launch a canvas rewrite');
        },
      }),
      /invalid/,
    );
  }));

test('canvas support requires a server acknowledgement and old Workers receive legacy requests', async () => {
  for (const server of ['canvas', 'legacy', 'no-ack']) {
    const calls = [];
    let captured;
    const client = createClient(config(), {
      fetcher: async (_url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body);
        if (server === 'legacy' && body.capabilities?.includes(CANVAS_CAPABILITY))
          return Response.json({ error: 'unknown capability' }, { status: 400 });
        if (body.action === 'claim')
          return Response.json({
            protocolVersion: 1,
            job: job(),
            ...(server === 'canvas' ? { canvasVersion: 1 } : {}),
          });
        return Response.json(
          body.action === 'heartbeat' ? { ok: true, cancelled: false } : { ok: true },
        );
      },
    });
    const claimed = await client.claim();
    assert.equal(client.canvasSupported, server === 'canvas');
    await processJob(client, claimed, {
      run: async (_job, options) => {
        captured = options.canvas;
        return result();
      },
    });
    assert.equal(captured, server === 'canvas');
    if (server === 'legacy') {
      assert.deepEqual(calls[1].capabilities, [...CAPABILITIES]);
      await client.claim();
      assert.deepEqual(calls.at(-1).capabilities, [...CAPABILITIES]);
    }
  }
  const source = canvasJob();
  source.context.screens = canvasDraft().screens;
  await assert.rejects(
    createClient(config(), {
      fetcher: async () => Response.json({ protocolVersion: 1, job: source }),
    }).claim(),
    /protocol/,
  );
  await assert.rejects(
    createClient(config(), {
      fetcher: async () => Response.json({ protocolVersion: 1, job: null, canvasVersion: 2 }),
    }).claim(),
    /protocol/,
  );
});

test('ordinary validation failures preserve acknowledged canvas support for later jobs', async () => {
  for (const rejectedAction of ['heartbeat', 'complete']) {
    const calls = [];
    const client = createClient(config(), {
      fetcher: async (_url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body);
        if (body.action === 'claim')
          return Response.json({ protocolVersion: 1, canvasVersion: 1, job: job() });
        return Response.json(
          { code: 'invalid_result', error: 'Project limit exceeded.' },
          { status: 400 },
        );
      },
    });
    const claimed = await client.claim();
    const options = { telemetry: { stage: 'validating' } };
    const operation =
      rejectedAction === 'complete'
        ? client.complete(claimed, { result: result() }, options)
        : client.heartbeat(claimed, options);
    await assert.rejects(operation, (error) => error.status === 400);
    assert.equal(
      calls.filter((call) => call.action === rejectedAction).length,
      1,
      'Validation failures must not retry with metadata removed',
    );
    assert.equal(client.canvasSupported, true);
    await client.claim();
    assert.ok(calls.at(-1).capabilities.includes(CANVAS_CAPABILITY));
    assert.equal(client.canvasSupported, true);
  }
});

test('diagram context remains compatible without expanding the AI output contract', () => {
  const diagrams = [
    { id: 'diagram_1', title: 'Journey', kind: 'flowchart', source: 'flowchart LR\n  A --> B' },
  ];
  const request = job({ context: { id: 'project_1', plan: {}, screens: [], diagrams } });
  assert.deepEqual(validateJob(request).context.diagrams, diagrams);
  assert.equal(validateResult(result(), request).title, result().title);
  assert.deepEqual(request.context.diagrams, diagrams);
  assert.throws(() => validateResult({ ...result(), diagrams }, request), /invalid/);
});

test('refinement and generation cannot reuse identifiers that survive in the project', () => {
  const request = job({
    kind: 'wireframe.refine',
    screenId: 'screen_1',
    context: {
      id: 'project_1',
      plan: {},
      screens: [screen(), { ...screen([node('node_other')]), id: 'screen_other' }],
      assets: [{ id: 'asset_1' }],
      diagrams: [{ id: 'diagram_1', title: 'Journey', kind: 'flowchart', source: '' }],
    },
  });
  for (const id of ['screen_other', 'node_other', 'asset_1', 'diagram_1'])
    assert.throws(
      () => validateResult({ ...result(), screens: [screen([node(id)])] }, request),
      /invalid/,
    );
  assert.equal(validateResult({ ...result(), screens: [screen()] }, request).screens.length, 1);
  assert.throws(
    () =>
      validateResult(
        { ...result(), screens: [{ ...screen(), id: 'asset_1' }] },
        { ...request, kind: 'wireframe.generate' },
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      validateResult(
        { ...result(), screens: [{ ...screen(), id: 'diagram_1' }] },
        { ...request, kind: 'wireframe.generate' },
      ),
    /invalid/,
  );
});

test('streamed Unicode product text survives UTF-8 boundaries in CLI output', async () =>
  temporary(async (dir) => {
    const expected = { ...result(), reply: 'Räksmörgås — 東京 🧭' };
    const output = await runCodex(job(), {
      workDir: dir,
      spawnProcess: spawnFixture([], {
        hang: true,
        onSpawn(_command, _args, _options, child) {
          setImmediate(() => {
            const bytes = Buffer.from(
              JSON.stringify({
                type: 'item.completed',
                item: { type: 'agent_message', text: JSON.stringify(expected) },
              }) + '\n',
            );
            for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
            child.emit('close', 0);
          });
        },
      }),
    });
    assert.equal(output.reply, expected.reply);
  }));

test('real subprocess cancellation escalates when the process ignores SIGTERM', async () =>
  temporary(async (dir) => {
    const controller = new AbortController();
    let exitSignal;
    await assert.rejects(
      runCodex(job(), {
        workDir: dir,
        signal: controller.signal,
        spawnProcess(_command, _args, options) {
          const child = spawn(
            process.execPath,
            [
              '-e',
              `process.on('SIGTERM', () => {});
              process.stdin.resume();
              setInterval(() => {}, 1000);
              process.stdout.write(JSON.stringify({type: 'thread.started'}) + '\\n');`,
            ],
            options,
          );
          child.stdout.once('data', () => controller.abort());
          child.on('exit', (_code, signal) => {
            exitSignal = signal;
          });
          return child;
        },
      }),
      /cancelled/,
    );
    assert.equal(exitSignal, 'SIGKILL');
    assert.deepEqual(await readdir(dir), []);
  }));

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
            assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
            assert.ok(args.includes('forced_login_method="chatgpt"'));
            assert.ok(args.includes('model_provider="openai"'));
            assert.ok(args.includes('model_context_window=872000'));
            assert.ok(!args.some((arg) => arg.startsWith('model_auto_compact_token_limit=')));
            assert.ok(args.includes('model_reasoning_effort="medium"'));
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
      AZURE_OPENAI_API_KEY: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      CODEX_API_KEY: 'secret',
      DESIGNER_BRIDGE_SECRET: 'secret',
    });
    assert.deepEqual(env, { HOME: '/private', HTTPS_PROXY: 'proxy', SSL_CERT_FILE: '/ca' });
  }));

for (const kind of CAPABILITIES) {
  test(`runner continues ${kind} after non-fatal Codex startup warnings`, async () =>
    temporary(async (dir) => {
      const request = job({
        kind,
        ...(kind === 'wireframe.refine'
          ? {
              screenId: 'screen_1',
              context: { id: 'project_1', plan: {}, screens: [screen()] },
            }
          : {}),
      });
      const expected = {
        ...result(),
        screens: kind.startsWith('wireframe.') ? [screen()] : null,
      };
      let killed = false;
      const output = await runCodex(request, {
        workDir: dir,
        spawnProcess: spawnFixture(
          [
            // This is the documented JSONL representation of ConfigWarning,
            // DeprecationNotice and model-rerouting notifications. These are
            // non-fatal even when their message mentions a usage limit.
            {
              type: 'item.completed',
              item: {
                id: 'warning_1',
                type: 'error',
                message: 'A configuration key is deprecated.',
              },
            },
            { type: 'thread.started', thread_id: 'fixture_thread' },
            { type: 'turn.started' },
            {
              type: 'item.completed',
              item: {
                id: 'warning_2',
                type: 'error',
                message: 'Model rerouted after reaching a usage limit.',
              },
            },
            {
              type: 'item.completed',
              item: { id: 'result_1', type: 'agent_message', text: JSON.stringify(expected) },
            },
            { type: 'turn.completed', usage: {} },
          ],
          {
            onSpawn(_command, args, options, child) {
              assert.equal(args.filter((arg) => arg === '--model').length, 1);
              assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
              assert.ok(args.includes('model_reasoning_effort="medium"'));
              assert.ok(args.includes('model_provider="openai"'));
              assert.ok(args.includes('model_context_window=872000'));
              assert.ok(!args.some((arg) => arg.startsWith('model_auto_compact_token_limit=')));
              assert.ok(args.includes('forced_login_method="chatgpt"'));
              assert.ok(args.includes('--ignore-user-config'));
              assert.equal(options.env.OPENAI_API_KEY, undefined);
              assert.equal(options.env.AZURE_OPENAI_API_KEY, undefined);
              assert.equal(options.env.CODEX_API_KEY, undefined);
              assert.equal(options.env.DESIGNER_BRIDGE_SECRET, undefined);
              const originalKill = child.kill;
              child.kill = (...args) => {
                killed = true;
                return originalKill(...args);
              };
            },
          },
        ),
      });
      assert.equal(killed, false);
      assert.equal(output.reply, expected.reply);
      assert.equal(output.plan.problem, expected.plan.problem);
      assert.equal(output.screens?.[0].id ?? null, expected.screens?.[0].id ?? null);
      assert.deepEqual(await readdir(dir), []);
    }));
}

test('non-fatal warning support preserves fatal errors and rejects malformed warning items', async () =>
  temporary(async (dir) => {
    const warning = {
      type: 'item.completed',
      item: { type: 'error', message: 'A configuration key is deprecated.' },
    };
    const final = {
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(result()) },
    };
    for (const [event, expected] of [
      [{ type: 'error', message: 'Authentication required: sign in.' }, /login/],
      [{ type: 'turn.failed', error: { message: 'Rate limit reached.' } }, /limit/],
      [{ type: 'error', message: 'The server could not complete the request.' }, /unavailable/],
    ]) {
      await assert.rejects(
        runCodex(job(), { workDir: dir, spawnProcess: spawnFixture([warning, event, final]) }),
        expected,
      );
    }
    for (const item of [
      { type: 'error' },
      { type: 'error', message: null },
      { type: 'error', message: { text: 'not a warning string' } },
      { type: 'unknown_item', message: 'not a documented warning' },
      { type: 'command_execution', message: 'not a warning', command: 'anything' },
    ]) {
      await assert.rejects(
        runCodex(job(), {
          workDir: dir,
          spawnProcess: spawnFixture([warning, { type: 'item.completed', item }, final]),
        }),
        /invalid/,
      );
    }
    assert.deepEqual(await readdir(dir), []);
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
    capabilities: [...CAPABILITIES, CANVAS_CAPABILITY],
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

test('client interrupts in-flight requests when the helper shuts down', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const client = createClient(config(), {
    fetcher: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      }),
  });
  const pending = client.claim({ signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('shutdown during final ownership check or completion retry cannot publish again', async () => {
  for (const phase of ['heartbeat', 'retry', 'before-run']) {
    const controller = new AbortController();
    let attempts = 0;
    let runs = 0;
    if (phase === 'before-run') controller.abort();
    const client = {
      heartbeat: async () => {
        if (phase === 'heartbeat') controller.abort();
        return { ok: true, cancelled: false };
      },
      complete: async () => {
        attempts++;
        setImmediate(() => controller.abort());
        throw new Error('offline');
      },
    };
    assert.equal(
      await processJob(client, job(), {
        signal: controller.signal,
        retryMs: 1000,
        run: async () => {
          runs++;
          return result();
        },
      }),
      'cancelled',
    );
    assert.equal(attempts, phase === 'retry' ? 1 : 0);
    assert.equal(runs, phase === 'before-run' ? 0 : 1);
  }
});

test('pending renewal cancellation is drained before the completion ownership check', async () => {
  let releaseRun, releaseHeartbeat, heartbeatStarted;
  const ready = new Promise((resolve) => {
    heartbeatStarted = resolve;
  });
  const generated = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const renewal = new Promise((resolve) => {
    releaseHeartbeat = resolve;
  });
  let heartbeats = 0,
    completions = 0;
  const pending = processJob(
    {
      heartbeat: async () => {
        heartbeats++;
        heartbeatStarted();
        return renewal;
      },
      complete: async () => {
        completions++;
      },
    },
    job(),
    { heartbeatMs: 1, run: () => generated },
  );
  await ready;
  releaseRun(result());
  await new Promise(setImmediate);
  assert.equal(heartbeats, 1);
  releaseHeartbeat({ ok: true, cancelled: true });
  assert.equal(await pending, 'cancelled');
  assert.equal(completions, 0);
});

test('a transient final heartbeat failure retries ownership before publishing', async () => {
  let heartbeats = 0,
    completions = 0;
  assert.equal(
    await processJob(
      {
        heartbeat: async () => {
          if (++heartbeats === 1) throw new Error('offline');
          return { ok: true, cancelled: false };
        },
        complete: async () => {
          completions++;
        },
      },
      job(),
      { retryMs: 1, run: async () => result() },
    ),
    'completed',
  );
  assert.equal(heartbeats, 2);
  assert.equal(completions, 1);
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

test('telemetry accepts only bounded reported counts and closed progress stages', () => {
  assert.deepEqual(
    usageFromCodex({
      input_tokens: 123,
      output_tokens: 0,
      cached_input_tokens: 20,
      secret: 'discard',
    }),
    {
      inputTokens: 123,
      cachedInputTokens: 20,
      outputTokens: 0,
    },
  );
  assert.equal(usageFromCodex({}), undefined);
  assert.equal(
    usageFromCodex({ input_tokens: -1, output_tokens: '20', cached_input_tokens: Infinity }),
    undefined,
  );
  assert.equal(usageFromCodex({ input_tokens: Number.MAX_SAFE_INTEGER + 1 }), undefined);
  assert.deepEqual(validateTelemetry({ stage: 'model-started', usage: { outputTokens: 0 } }), {
    stage: 'model-started',
    usage: { outputTokens: 0 },
  });
  for (const value of [
    {},
    { stage: 'thinking about private contents' },
    { stage: 'launching', text: 'private' },
    { usage: {} },
    { usage: { outputTokens: -1 } },
    { usage: { inputTokens: 1.5 } },
    { usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { usage: { outputTokens: 4, privateContent: 'discard' } },
    { usage: null },
  ])
    assert.throws(() => validateTelemetry(value), /protocol/);
});

test('runner reports real CLI stages and completed-turn usage without model text or invented counts', async () =>
  temporary(async (dir) => {
    const telemetry = [];
    await runCodex(job(), {
      workDir: dir,
      onTelemetry: (value) => telemetry.push(value),
      spawnProcess: spawnFixture([
        { type: 'thread.started', thread_id: 'fixture' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } },
        { type: 'item.completed', item: { type: 'error', message: 'private warning' } },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result()) } },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 120,
            cached_input_tokens: 20,
            output_tokens: 30,
            private: 'never send',
          },
        },
      ]),
    });
    assert.deepEqual(telemetry, [
      { stage: 'launching' },
      { stage: 'model-started' },
      { stage: 'response-received' },
      { usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 } },
      { stage: 'validating' },
    ]);
    assert.equal(JSON.stringify(telemetry).includes('private'), false);
    const missing = [];
    await runCodex(job(), {
      workDir: dir,
      onTelemetry: (value) => missing.push(value),
      spawnProcess: spawnFixture([
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result()) } },
      ]),
    });
    assert.ok(missing.every((value) => !Object.hasOwn(value, 'usage')));
  }));

test('client carries validated telemetry and release version without changing the protocol', async () => {
  const calls = [];
  const client = createClient(config(), {
    workerId: 'worker_1',
    helperVersion: '1.0.2',
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      return Response.json(
        body.action === 'claim'
          ? { protocolVersion: 1, job: null }
          : body.action === 'heartbeat'
            ? { ok: true, cancelled: false }
            : { ok: true },
      );
    },
  });
  await client.claim();
  const telemetry = { stage: 'validating', usage: { inputTokens: 100, outputTokens: 0 } };
  await client.heartbeat(job(), { telemetry });
  await client.complete(job(), { error: 'invalid' }, { telemetry });
  assert.equal(calls[0].helperVersion, '1.0.2');
  assert.equal(calls[0].protocolVersion, 1);
  assert.deepEqual(calls[1].telemetry, telemetry);
  assert.deepEqual(calls[2].telemetry, telemetry);
  assert.equal(calls[1].leaseToken, job().leaseToken);
  const count = calls.length;
  await assert.rejects(
    client.heartbeat(job(), { telemetry: { stage: 'private text' } }),
    /protocol/,
  );
  await assert.rejects(
    client.complete(job(), { error: 'invalid' }, { telemetry: null }),
    /protocol/,
  );
  assert.equal(calls.length, count);
  assert.throws(() => createClient(config(), { helperVersion: 'private\nversion' }), /protocol/);
  assert.equal(await helperVersion(), DESIGNER_HELPER_VERSION);
});

test('new helpers fall back once to legacy protocol-1 bodies without optional metadata', async () => {
  const calls = [];
  const client = createClient(config(), {
    helperVersion: '1.0.2',
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.helperVersion || body.telemetry)
        return Response.json({ error: 'unknown field' }, { status: 400 });
      return Response.json(
        body.action === 'claim'
          ? { protocolVersion: 1, job: null }
          : body.action === 'heartbeat'
            ? { ok: true, cancelled: false }
            : { ok: true },
      );
    },
  });
  await client.claim();
  await client.heartbeat(job(), { telemetry: { stage: 'launching' } });
  await client.complete(job(), { error: 'invalid' }, { telemetry: { usage: { outputTokens: 8 } } });
  await client.claim();
  assert.equal(calls.length, 5);
  assert.equal(calls[0].helperVersion, '1.0.2');
  assert.ok(
    calls
      .slice(1)
      .every(
        (value) => !Object.hasOwn(value, 'helperVersion') && !Object.hasOwn(value, 'telemetry'),
      ),
  );
  let unauthorizedCalls = 0;
  const unauthorized = createClient(config(), {
    helperVersion: '1.0.2',
    fetcher: async () => {
      unauthorizedCalls++;
      return Response.json({ error: 'denied' }, { status: 403 });
    },
  });
  await assert.rejects(unauthorized.claim(), (error) => error.status === 403);
  assert.equal(unauthorizedCalls, 1);
});

test('job progress is sent immediately, serialized, and retained through completion', async () => {
  const calls = [];
  let releaseFirst;
  let inFlight = 0;
  let peak = 0;
  const client = {
    async heartbeat(_job, options) {
      calls.push({ action: 'heartbeat', telemetry: structuredClone(options.telemetry) });
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (calls.length === 1)
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      inFlight--;
      return { ok: true, cancelled: false };
    },
    async complete(_job, outcome, options) {
      calls.push({
        action: 'complete',
        telemetry: structuredClone(options.telemetry),
        error: outcome.error,
      });
    },
  };
  const status = await processJob(client, job(), {
    heartbeatMs: 60_000,
    run: async (_job, { onTelemetry }) => {
      onTelemetry({ stage: 'launching' });
      assert.equal(calls.length, 1, 'launch is visible before the ordinary heartbeat interval');
      onTelemetry({ stage: 'model-started' });
      onTelemetry({ usage: { inputTokens: 100, outputTokens: 25 } });
      onTelemetry({ stage: 'validating' });
      onTelemetry({ stage: 'launching', usage: { inputTokens: 1 } });
      releaseFirst();
      throw new Error('invalid');
    },
  });
  assert.equal(status, 'invalid');
  assert.equal(peak, 1);
  assert.deepEqual(calls.at(-1), {
    action: 'complete',
    telemetry: { stage: 'validating', usage: { inputTokens: 100, outputTokens: 25 } },
    error: 'invalid',
  });
});

test('cancellation during a telemetry heartbeat cannot publish a result or later telemetry', async () => {
  let complete = 0;
  let heartbeats = 0;
  let lateTelemetry;
  const status = await processJob(
    {
      async heartbeat() {
        heartbeats++;
        return { ok: true, cancelled: true };
      },
      async complete() {
        complete++;
      },
    },
    job(),
    {
      run: async (_job, { onTelemetry }) => {
        lateTelemetry = onTelemetry;
        onTelemetry({ stage: 'launching' });
        await new Promise((resolve) => setImmediate(resolve));
        return result();
      },
    },
  );
  assert.equal(status, 'cancelled');
  assert.equal(complete, 0);
  const previous = heartbeats;
  lateTelemetry({ stage: 'validating' });
  assert.equal(heartbeats, previous);
});
