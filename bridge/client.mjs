import { randomUUID } from 'node:crypto';
import { bridgeHeaders, validateConfig } from './config.mjs';
import {
  CAPABILITIES,
  CANVAS_CAPABILITY,
  PROTOCOL_VERSION,
  PROGRESS_STAGES,
  jobNeedsCanvas,
  validateJob,
  validateTelemetry,
} from './schema.mjs';
import { runCodex } from './codex-runner.mjs';

export class ConnectionError extends Error {
  constructor(status = 0) {
    super('connection');
    this.status = status;
  }
}
export function createClient(
  config,
  { fetcher = fetch, workerId = randomUUID(), helperVersion } = {},
) {
  validateConfig(config);
  if (
    helperVersion !== undefined &&
    (typeof helperVersion !== 'string' ||
      helperVersion.length > 64 ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(helperVersion))
  )
    throw new Error('protocol');
  let extensions = true;
  let canvasSupported = false;
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
  async function compatibleRequest(action, fields, signal) {
    const legacy = { ...fields };
    delete legacy.helperVersion;
    delete legacy.telemetry;
    if (Array.isArray(legacy.capabilities))
      legacy.capabilities = legacy.capabilities.filter(
        (capability) => capability !== CANVAS_CAPABILITY,
      );
    const optional =
      Object.hasOwn(fields, 'helperVersion') ||
      Object.hasOwn(fields, 'telemetry') ||
      fields.capabilities?.includes(CANVAS_CAPABILITY);
    try {
      return await request(action, extensions ? fields : legacy, signal);
    } catch (error) {
      // Negotiate compatibility only when claiming work. A rejected result or
      // telemetry update says nothing about server capabilities and must not
      // disable a previously acknowledged canvas connection.
      if (action !== 'claim' || !extensions || !optional || error.status !== 400) throw error;
      extensions = false;
      canvasSupported = false;
      return request(action, legacy, signal);
    }
  }
  return {
    workerId,
    get canvasSupported() {
      return canvasSupported;
    },
    async claim({ signal } = {}) {
      const state = await compatibleRequest(
        'claim',
        {
          capabilities: [...CAPABILITIES, CANVAS_CAPABILITY],
          ...(helperVersion ? { helperVersion } : {}),
        },
        signal,
      );
      if (
        !state ||
        state.protocolVersion !== PROTOCOL_VERSION ||
        !Object.hasOwn(state, 'job') ||
        Object.keys(state).some(
          (key) => !['protocolVersion', 'job', 'canvasVersion'].includes(key),
        ) ||
        (state.canvasVersion !== undefined && state.canvasVersion !== 1)
      )
        throw new Error('protocol');
      canvasSupported = extensions && state.canvasVersion === 1;
      const job = state.job === null ? null : validateJob(state.job);
      if (job && !canvasSupported && jobNeedsCanvas(job)) throw new Error('protocol');
      return job;
    },
    async heartbeat(job, { signal, telemetry } = {}) {
      const state = await compatibleRequest(
        'heartbeat',
        {
          jobId: job.id,
          leaseToken: job.leaseToken,
          ...(telemetry !== undefined ? { telemetry: validateTelemetry(telemetry) } : {}),
        },
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
    async complete(job, outcome, { signal, telemetry } = {}) {
      if ((outcome.result !== undefined) === (outcome.error !== undefined))
        throw new Error('protocol');
      const state = await compatibleRequest(
        'complete',
        {
          jobId: job.id,
          leaseToken: job.leaseToken,
          ...outcome,
          ...(telemetry !== undefined ? { telemetry: validateTelemetry(telemetry) } : {}),
        },
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
  let finishing = false;
  let telemetry;
  let telemetryRevision = 0;
  let sentRevision = 0;
  const abort = () => control.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const heartbeatOptions = () => ({
    signal: control.signal,
    ...(telemetry ? { telemetry: structuredClone(telemetry) } : {}),
  });
  function renew() {
    if (activeHeartbeat || control.signal.aborted) return;
    sentRevision = telemetryRevision;
    activeHeartbeat = (async () => {
      try {
        const state = await client.heartbeat(job, heartbeatOptions());
        missed = 0;
        if (state.cancelled) abort();
      } catch (error) {
        if (++missed >= 2 || [401, 403, 409].includes(error.status)) abort();
      }
    })().finally(() => {
      activeHeartbeat = null;
      if (!finishing && !control.signal.aborted && telemetryRevision > sentRevision) renew();
    });
  }
  function onTelemetry(value) {
    if (finishing || control.signal.aborted) return;
    const next = validateTelemetry(value);
    const merged = { ...telemetry };
    if (next.stage && PROGRESS_STAGES.indexOf(next.stage) > PROGRESS_STAGES.indexOf(merged.stage))
      merged.stage = next.stage;
    if (next.usage) {
      merged.usage = { ...merged.usage };
      for (const [key, count] of Object.entries(next.usage))
        merged.usage[key] = Math.max(merged.usage[key] ?? 0, count);
    }
    if (JSON.stringify(merged) === JSON.stringify(telemetry)) return;
    telemetry = merged;
    telemetryRevision += 1;
    renew();
  }
  const heartbeat = setInterval(renew, heartbeatMs);
  try {
    let outcome;
    try {
      if (control.signal.aborted) return 'cancelled';
      outcome = {
        result: await run(job, {
          workDir,
          command,
          signal: control.signal,
          onTelemetry,
          canvas: client.canvasSupported === true,
        }),
      };
    } catch (error) {
      if (!control.signal.aborted)
        outcome = {
          error: ['timeout', 'login', 'limit', 'invalid'].includes(error.message)
            ? error.message
            : 'unavailable',
        };
    }
    finishing = true;
    clearInterval(heartbeat);
    // A pending renewal can still report cancellation. Drain it before issuing
    // the final ownership check, and keep shutdown connected through completion.
    await activeHeartbeat;
    if (!outcome || control.signal.aborted) return 'cancelled';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const state = await client.heartbeat(job, heartbeatOptions());
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
        await client.complete(job, outcome, heartbeatOptions());
        return outcome.error ?? 'completed';
      } catch (error) {
        if (control.signal.aborted) return 'cancelled';
        if ([400, 401, 403, 409, 413].includes(error.status) || attempt === 2) throw error;
        await wait(retryMs, control.signal);
      }
    }
  } finally {
    finishing = true;
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
