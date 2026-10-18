import { mkdir, open, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createClient, processJob, wait } from './client.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startHelper(configPath = path.join(root, '.blai-designer', 'config.json')) {
  const config = await loadConfig(configPath);
  const workDir = path.join(path.dirname(configPath), 'work');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(workDir);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Use a normal private helper work directory.');
  const lockPath = path.join(path.dirname(configPath), 'helper.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'A helper lock already exists. Stop the designer helper, then remove helper.lock only if that process has ended.',
      );
    throw error;
  }
  await lock.writeFile(String(process.pid));
  const controller = new AbortController();
  let lastStatus;
  let busy = false;
  function reportStatus(state) {
    if (lastStatus === state || lastStatus === 'stopping') return;
    lastStatus = state;
    // IPC is optional; a disconnected manager must not interrupt a standalone job.
    try {
      if (process.connected) process.send?.({ type: 'blai-helper-status', state }, () => {});
    } catch {}
  }
  const stop = () => {
    reportStatus('stopping');
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
  const client = createClient(config);
  for (const operation of ['claim', 'heartbeat', 'complete']) {
    const request = client[operation];
    client[operation] = async (...args) => {
      try {
        const result = await request(...args);
        if (busy && !controller.signal.aborted) reportStatus('busy');
        return result;
      } catch (error) {
        if (!controller.signal.aborted) reportStatus('offline');
        throw error;
      }
    };
  }
  let disconnected = false;
  console.log('BLAI designer helper started. Using the existing ChatGPT Codex sign-in.');
  try {
    while (!controller.signal.aborted) {
      try {
        const job = await client.claim({ signal: controller.signal });
        if (controller.signal.aborted) break;
        reportStatus('connected');
        if (disconnected) console.log('Designer connection restored.');
        disconnected = false;
        if (!job) {
          await wait(5000, controller.signal);
          continue;
        }
        busy = true;
        reportStatus('busy');
        let status;
        try {
          status = await processJob(client, job, {
            workDir,
            command: config.codexPath || 'codex',
            signal: controller.signal,
          });
        } finally {
          busy = false;
        }
        console.log(`Designer request: ${status}.`);
      } catch {
        if (!controller.signal.aborted) reportStatus('offline');
        if (!disconnected)
          console.log(
            'Waiting for the designer connection. Check the site, Access service token, bridge secret, and helper logs in Settings.',
          );
        disconnected = true;
        await wait(10_000, controller.signal);
      }
    }
  } finally {
    reportStatus('stopping');
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('disconnect', stop);
    await lock.close();
    await rm(lockPath, { force: true });
    console.log('Designer helper stopped.');
    if (process.connected) process.disconnect();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startHelper(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
