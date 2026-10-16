import { randomUUID } from 'node:crypto';
import { bridgeHeaders, validateConfig } from './config.mjs';
import { CAPABILITIES, PROTOCOL_VERSION, validateJob } from './schema.mjs';
import { runCodex } from './codex-runner.mjs';

export class ConnectionError extends Error {
  constructor(status = 0) {
    super('connection');
    this.status = status;
  }
}
export function createClient(config, { fetcher = fetch, workerId = randomUUID() } = {}) {
  validateConfig(config);
  async function request(action, fields = {}) {
    const response = await fetcher(new URL('/api/codex', config.site), {
      method: 'POST',
      headers: bridgeHeaders(config),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ action, protocolVersion: PROTOCOL_VERSION, workerId, ...fields }),
    });
    if (!response.ok) throw new ConnectionError(response.status);
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('protocol');
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 1_600_000) throw new Error('protocol');
    if (!response.body) throw new Error('protocol');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_600_000) throw new Error('protocol');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('protocol');
    }
  }
  return {
    workerId,
    async claim() {
      const state = await request('claim', { capabilities: [...CAPABILITIES] });
      if (
        !state ||
        state.protocolVersion !== PROTOCOL_VERSION ||
        !Object.hasOwn(state, 'job') ||
        Object.keys(state).some((key) => !['protocolVersion', 'job'].includes(key))
      )
        throw new Error('protocol');
      return state.job === null ? null : validateJob(state.job);
    },
    async heartbeat(job) {
      const state = await request('heartbeat', { jobId: job.id, leaseToken: job.leaseToken });
      if (
        state?.ok !== true ||
        typeof state.cancelled !== 'boolean' ||
        Object.keys(state).some((key) => !['ok', 'cancelled', 'leaseExpiresAt'].includes(key)) ||
        (state.leaseExpiresAt !== undefined && !Number.isFinite(Date.parse(state.leaseExpiresAt)))
      )
        throw new Error('protocol');
      return state;
    },
    async complete(job, outcome) {
      if ((outcome.result !== undefined) === (outcome.error !== undefined))
        throw new Error('protocol');
      const state = await request('complete', {
        jobId: job.id,
        leaseToken: job.leaseToken,
        ...outcome,
      });
      if (state?.ok !== true || Object.keys(state).length !== 1) throw new Error('protocol');
    },
  };
}

export async function processJob(
  client,
  job,
  { workDir, command, signal, run = runCodex, heartbeatMs = 10_000, retryMs = 1000 } = {},
) {
  const control = new AbortController();
  let cancelled = false,
    leaseLost = false,
    beating = false,
    missed = 0;
  const abort = () => control.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const heartbeat = setInterval(async () => {
    if (beating || control.signal.aborted) return;
    beating = true;
    try {
      const state = await client.heartbeat(job);
      missed = 0;
      if (state.cancelled) {
        cancelled = true;
        abort();
      }
    } catch (error) {
      if (++missed >= 2 || [401, 403, 409].includes(error.status)) {
        leaseLost = true;
        abort();
      }
    } finally {
      beating = false;
    }
  }, heartbeatMs);
  let outcome;
  try {
    outcome = { result: await run(job, { workDir, command, signal: control.signal }) };
  } catch (error) {
    if (!cancelled && !leaseLost && !signal?.aborted)
      outcome = {
        error: ['timeout', 'login', 'limit', 'invalid'].includes(error.message)
          ? error.message
          : 'unavailable',
      };
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', abort);
  }
  if (!outcome || cancelled || leaseLost || signal?.aborted) return 'cancelled';
  // A heartbeat after generation establishes ownership before publishing the result.
  const state = await client.heartbeat(job);
  if (state.cancelled) return 'cancelled';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.complete(job, outcome);
      return outcome.error ?? 'completed';
    } catch (error) {
      if ([401, 403, 409].includes(error.status) || attempt === 2) throw error;
      await wait(retryMs, signal);
    }
  }
}

export function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
