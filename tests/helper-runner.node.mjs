import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runCodex } from '../bridge/codex-runner.mjs';

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
const result = {
  title: 'A completed fixture',
  summary: 'A private test result.',
  reply: 'Review the proposal.',
  plan: null,
  screens: null,
  design: null,
  requirements: [],
};
const finalEvent = (text = JSON.stringify(result)) => ({
  type: 'item.completed',
  item: { type: 'agent_message', text },
});
const completedEvent = { type: 'turn.completed', usage: { output_tokens: 100 } };

async function fixture(t, { closeOnKill = true, request = job, ...options } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = await mkdtemp(path.join(tmpdir(), 'designer-runner-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (closeOnKill) setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  let spawned;
  const started = new Promise((resolve) => {
    spawned = resolve;
  });
  const pending = runCodex(request, {
    workDir: directory,
    ...options,
    spawnProcess() {
      spawned();
      return child;
    },
  });
  // Tests may advance a deadline before asserting on the rejected promise.
  pending.catch(() => {});
  await Promise.race([started, pending]);
  return {
    pending,
    signals,
    child,
    send(event) {
      child.stdout.write(JSON.stringify(event) + '\n');
    },
  };
}

for (const kind of [
  'plan.assist',
  'plan.review',
  'wireframe.generate',
  'wireframe.refine',
  'moodboard.direction',
]) {
  test(`${kind} keeps its generation deadline below the corresponding server budget`, async (t) => {
    const { pending, signals } = await fixture(t, {
      request: {
        ...job,
        kind,
        ...(kind === 'wireframe.refine'
          ? { screenId: 'screen_1', context: { ...job.context, screens: [{ id: 'screen_1' }] } }
          : {}),
      },
    });
    const expected = (kind === 'wireframe.generate' ? 19 : 9) * 60_000;
    t.mock.timers.tick(expected - 1);
    assert.deepEqual(signals, []);
    t.mock.timers.tick(1);
    await assert.rejects(pending, /timeout/);
    assert.deepEqual(signals, ['SIGTERM']);
  });
}

for (const lateCompletion of [false, true]) {
  test(`an explicit deadline rejects a final message ${lateCompletion ? 'with a late completed turn' : 'without a completed turn'}`, async (t) => {
    const { pending, signals, child, send } = await fixture(t, {
      timeoutMs: 30,
      closeOnKill: false,
    });
    send(finalEvent());
    t.mock.timers.tick(29);
    assert.deepEqual(signals, []);
    t.mock.timers.tick(1);
    assert.deepEqual(signals, ['SIGTERM']);
    if (lateCompletion) send(completedEvent);
    child.emit('close', null, 'SIGTERM');
    await assert.rejects(pending, /timeout/);
  });
}

test('a completed turn gets a bounded normal shutdown window before terminating the CLI', async (t) => {
  const { pending, signals, child, send } = await fixture(t, { timeoutMs: 30 });
  send(finalEvent());
  send(completedEvent);
  t.mock.timers.tick(999);
  assert.deepEqual(signals, []);
  child.emit('close', 0);
  assert.deepEqual(await pending, result);
  t.mock.timers.tick(10_000);
  assert.deepEqual(signals, []);
});

for (const afterCleanupSignal of [false, true]) {
  test(`a nonzero CLI exit ${afterCleanupSignal ? 'after' : 'before'} cleanup remains a failure`, async (t) => {
    const { pending, signals, child, send } = await fixture(t, { closeOnKill: false });
    send(finalEvent());
    send(completedEvent);
    if (afterCleanupSignal) t.mock.timers.tick(1000);
    assert.deepEqual(signals, afterCleanupSignal ? ['SIGTERM'] : []);
    child.emit('close', 1);
    await assert.rejects(pending, /unavailable/);
  });
}

test('cancellation while terminating a completed CLI still cancels the result', async (t) => {
  const controller = new AbortController();
  const { pending, child, send } = await fixture(t, {
    signal: controller.signal,
    closeOnKill: false,
  });
  send(finalEvent());
  send(completedEvent);
  t.mock.timers.tick(1000);
  controller.abort();
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(pending, /cancelled/);
});

for (const [name, event, error] of [
  ['fatal error', { type: 'turn.failed', error: { message: 'Rate limit reached.' } }, /limit/],
  [
    'forbidden tool',
    { type: 'item.started', item: { type: 'command_execution', command: 'not executed' } },
    /invalid/,
  ],
  ['replacement final', finalEvent(), /invalid/],
]) {
  test(`a ${name} during completed-turn cleanup still rejects the result`, async (t) => {
    const { pending, send } = await fixture(t);
    send(finalEvent());
    send(completedEvent);
    send(event);
    await assert.rejects(pending, error);
  });
}

test('malformed events and authentication stderr cannot be accepted during cleanup', async (t) => {
  for (const kind of ['malformed', 'login']) {
    await t.test(kind, async (subtest) => {
      const { pending, child, send } = await fixture(subtest);
      send(finalEvent());
      send(completedEvent);
      if (kind === 'malformed') child.stdout.write('not json\n');
      else child.stderr.write('Authentication token expired.');
      await assert.rejects(pending, kind === 'malformed' ? /invalid/ : /login/);
    });
  }
});

test('a completed turn still undergoes full result validation after CLI cleanup', async (t) => {
  const { pending, send } = await fixture(t);
  send(finalEvent('{"unexpected":"private invalid output"}'));
  send(completedEvent);
  t.mock.timers.tick(1000);
  await assert.rejects(pending, /invalid/);
});

for (const managed of [false, true]) {
  test(`${managed ? 'managed' : 'standalone'} designer cancels a real subprocess that ignores SIGTERM`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'designer-runner-'));
    const previous = process.env.BLAI_HELPER_MANAGED;
    if (managed) process.env.BLAI_HELPER_MANAGED = '1';
    else delete process.env.BLAI_HELPER_MANAGED;
    const controller = new AbortController();
    let child, exitSignal;
    try {
      await assert.rejects(
        runCodex(job, {
          workDir: directory,
          signal: controller.signal,
          spawnProcess(_command, _args, options) {
            assert.equal(
              options.detached,
              !managed && process.platform !== 'win32' && !process.connected,
            );
            child = spawn(
              process.execPath,
              [
                '-e',
                `
            process.on('SIGTERM', () => {});
            process.stdin.resume();
            setInterval(() => {}, 1000);
            process.stdout.write(JSON.stringify({ type: 'thread.started' }) + '\\n');
          `,
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
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (previous === undefined) delete process.env.BLAI_HELPER_MANAGED;
      else process.env.BLAI_HELPER_MANAGED = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`${managed ? 'managed' : 'standalone'} designer preserves a completed result while reaping a CLI that ignores SIGTERM`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'designer-completed-runner-'));
    const previous = process.env.BLAI_HELPER_MANAGED;
    if (managed) process.env.BLAI_HELPER_MANAGED = '1';
    else delete process.env.BLAI_HELPER_MANAGED;
    let child,
      exitSignal,
      closed = false;
    const stages = [];
    try {
      const actual = await runCodex(job, {
        workDir: directory,
        timeoutMs: 1000,
        onTelemetry(value) {
          if (value.stage) stages.push(value.stage);
        },
        spawnProcess(_command, _args, options) {
          child = spawn(
            process.execPath,
            [
              '-e',
              `
                process.on('SIGTERM', () => {});
                process.stdin.resume();
                setInterval(() => {}, 1000);
                for (const event of ${JSON.stringify([finalEvent(), completedEvent])})
                  process.stdout.write(JSON.stringify(event) + '\\n');
              `,
            ],
            options,
          );
          child.on('close', (_code, signal) => {
            closed = true;
            exitSignal = signal;
          });
          return child;
        },
      });
      assert.deepEqual(actual, result);
      assert.equal(closed, true, 'Do not publish a result before its process has closed');
      assert.equal(exitSignal, 'SIGKILL');
      assert.deepEqual(stages, ['launching', 'response-received', 'validating']);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (previous === undefined) delete process.env.BLAI_HELPER_MANAGED;
      else process.env.BLAI_HELPER_MANAGED = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
