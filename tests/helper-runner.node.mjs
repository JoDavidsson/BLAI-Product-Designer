import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
}
