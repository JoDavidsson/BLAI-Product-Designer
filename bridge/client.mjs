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
  async function request(action, fields = {}, signal) {
    signal?.throwIfAborted();
    const response = await fetcher(new URL('/api/codex', config.site), {
      method: 'POST',
      headers: bridgeHeaders(config),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
        : AbortSignal.timeout(12_000),
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
    async claim({ signal } = {}) {
      const state = await request('claim', { capabilities: [...CAPABILITIES] }, signal);
      if (
        !state ||
        state.protocolVersion !== PROTOCOL_VERSION ||
        !Object.hasOwn(state, 'job') ||
        Object.keys(state).some((key) => !['protocolVersion', 'job'].includes(key))
      )
        throw new Error('protocol');
      return state.job === null ? null : validateJob(state.job);
    },
    async heartbeat(job, { signal } = {}) {
      const state = await request(
        'heartbeat',
        { jobId: job.id, leaseToken: job.leaseToken },
        signal,
      );
      if (
        state?.ok !== true ||
        typeof state.cancelled !== 'boolean' ||
        Object.keys(state).some((key) => !['ok', 'cancelled', 'leaseExpiresAt'].includes(key)) ||
        (state.leaseExpiresAt !== undefined && !Number.isFinite(Date.parse(state.leaseExpiresAt)))
      )
        throw new Error('protocol');
      return state;
    },
    async complete(job, outcome, { signal } = {}) {
      if ((outcome.result !== undefined) === (outcome.error !== undefined))
        throw new Error('protocol');
      const state = await request(
        'complete',
        { jobId: job.id, leaseToken: job.leaseToken, ...outcome },
        signal,
      );
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
  let missed = 0;
  let activeHeartbeat = null;
  const abort = () => control.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const heartbeat = setInterval(() => {
    if (activeHeartbeat || control.signal.aborted) return;
    activeHeartbeat = (async () => {
      try {
        const state = await client.heartbeat(job, { signal: control.signal });
        missed = 0;
        if (state.cancelled) abort();
      } catch (error) {
        if (++missed >= 2 || [401, 403, 409].includes(error.status)) abort();
      }
    })().finally(() => {
      activeHeartbeat = null;
    });
  }, heartbeatMs);
  try {
    let outcome;
    try {
      if (control.signal.aborted) return 'cancelled';
      outcome = { result: await run(job, { workDir, command, signal: control.signal }) };
    } catch (error) {
      if (!control.signal.aborted)
        outcome = {
          error: ['timeout', 'login', 'limit', 'invalid'].includes(error.message)
            ? error.message
            : 'unavailable',
        };
    }
    clearInterval(heartbeat);
    // A pending renewal can still report cancellation. Drain it before issuing
    // the final ownership check, and keep shutdown connected through completion.
    await activeHeartbeat;
    if (!outcome || control.signal.aborted) return 'cancelled';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const state = await client.heartbeat(job, { signal: control.signal });
        if (state.cancelled || control.signal.aborted) return 'cancelled';
        break;
      } catch (error) {
        if (control.signal.aborted) return 'cancelled';
        if ([401, 403, 409].includes(error.status) || attempt === 1) throw error;
        await wait(retryMs, control.signal);
        if (control.signal.aborted) return 'cancelled';
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (control.signal.aborted) return 'cancelled';
      try {
        await client.complete(job, outcome, { signal: control.signal });
        return outcome.error ?? 'completed';
      } catch (error) {
        if (control.signal.aborted) return 'cancelled';
        if ([400, 401, 403, 409, 413].includes(error.status) || attempt === 2) throw error;
        await wait(retryMs, control.signal);
      }
    }
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', abort);
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
