import { z } from 'zod';
import {
  PROTOCOL_VERSION,
  uid,
  type AIJob,
  type AIProposal,
  type HelperStatus,
  type JobKind,
  type Project,
  type AIResult,
  walkNodes,
} from '../shared/model';
import { idSchema, jobKindSchema, resultSchema, projectSchema } from '../shared/validation';
import { AppError, type Env } from './types';
import { getProject, proposalToProject, saveProject } from './projects';

const LEASE_MS = 45000;
const ONLINE_MS = 35000;
const MAX_RUNTIME_MS = 600000;
type JobRow = {
  id: string;
  project_id: string;
  kind: JobKind;
  base_revision: number;
  status: AIJob['status'];
  instruction: string;
  screen_id: string | null;
  created_at: string;
  error: string | null;
  proposal_id: string | null;
  context: string;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  started_at: number | null;
};
const toJob = (r: JobRow): AIJob => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  baseRevision: r.base_revision,
  status: r.status,
  instruction: r.instruction,
  ...(r.screen_id ? { screenId: r.screen_id } : {}),
  createdAt: r.created_at,
  ...(r.error ? { error: r.error } : {}),
  ...(r.proposal_id ? { proposalId: r.proposal_id } : {}),
});
export async function expireJobs(env: Env, owner: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE jobs SET status='failed',error='The helper stopped responding or exceeded the ten-minute job limit. Start a new job when it is connected.',lease_token=NULL WHERE owner=? AND ((status='running' AND (lease_expires_at<? OR started_at<?)) OR (status='queued' AND created_at<?))",
  )
    .bind(owner, now, now - MAX_RUNTIME_MS, new Date(now - MAX_RUNTIME_MS).toISOString())
    .run();
}
export async function helperStatus(env: Env, owner: string): Promise<HelperStatus> {
  const row = await env.DB.prepare(
    'SELECT worker_id,protocol_version,capabilities,last_seen FROM helpers WHERE owner=? ORDER BY last_seen DESC LIMIT 1',
  )
    .bind(owner)
    .first<{
      worker_id: string;
      protocol_version: number;
      capabilities: string;
      last_seen: number;
    }>();
  return {
    online:
      !!row && row.protocol_version === PROTOCOL_VERSION && row.last_seen > Date.now() - ONLINE_MS,
    lastSeen: row ? new Date(row.last_seen).toISOString() : null,
    workerId: row?.worker_id ?? null,
    protocolVersion: row?.protocol_version ?? PROTOCOL_VERSION,
    capabilities: row ? JSON.parse(row.capabilities) : [],
    imageGeneration: false,
  };
}
export async function listJobs(env: Env, owner: string, projectId: string): Promise<AIJob[]> {
  await expireJobs(env, owner);
  const rows = await env.DB.prepare(
    'SELECT * FROM jobs WHERE owner=? AND project_id=? ORDER BY created_at DESC LIMIT 100',
  )
    .bind(owner, projectId)
    .all<JobRow>();
  return rows.results.map(toJob);
}
export async function enqueueJob(
  env: Env,
  owner: string,
  project: Project,
  input: { kind: JobKind; instruction: string; screenId?: string },
): Promise<AIJob> {
  await expireJobs(env, owner);
  const helpers = await env.DB.prepare(
    'SELECT capabilities FROM helpers WHERE owner=? AND protocol_version=? AND last_seen>?',
  )
    .bind(owner, PROTOCOL_VERSION, Date.now() - ONLINE_MS)
    .all<{ capabilities: string }>();
  if (!helpers.results.some((h) => JSON.parse(h.capabilities).includes(input.kind)))
    throw new AppError(
      503,
      'helper_offline',
      'Connect the BLAI Designer Codex Helper on your Linux computer to run this task. Your edits are still saved normally.',
    );
  if (
    input.kind === 'wireframe.refine' &&
    (!input.screenId || !project.screens.some((s) => s.id === input.screenId))
  )
    throw new AppError(400, 'screen_required', 'Choose an existing screen to refine.');
  const context = JSON.stringify(project);
  if (context.length > 350000)
    throw new AppError(
      413,
      'ai_context_too_large',
      'This project exceeds the AI context limit. Reduce long comments or split the project before generating.',
    );
  const job: AIJob = {
    id: uid('job'),
    projectId: project.id,
    kind: input.kind,
    baseRevision: project.revision,
    status: 'queued',
    instruction: input.instruction,
    ...(input.screenId ? { screenId: input.screenId } : {}),
    createdAt: new Date().toISOString(),
  };
  // This single insert also limits pending jobs atomically under concurrent requests.
  const inserted = await env.DB.prepare(
    "INSERT INTO jobs(id,project_id,owner,kind,base_revision,status,instruction,screen_id,context,created_at) SELECT ?,?,?,?,?,'queued',?,?,?,? WHERE (SELECT COUNT(*) FROM jobs WHERE owner=? AND status IN ('queued','running')) < 3 RETURNING id",
  )
    .bind(
      job.id,
      project.id,
      owner,
      job.kind,
      job.baseRevision,
      job.instruction,
      job.screenId ?? null,
      context,
      job.createdAt,
      owner,
    )
    .all();
  if (!inserted.results.length)
    throw new AppError(
      429,
      'queue_full',
      'Finish or cancel an existing AI task before starting another.',
    );
  return job;
}
export async function cancelJob(
  env: Env,
  owner: string,
  projectId: string,
  jobId: string,
): Promise<void> {
  const existing = await env.DB.prepare(
    'SELECT id FROM jobs WHERE id=? AND owner=? AND project_id=?',
  )
    .bind(jobId, owner, projectId)
    .first();
  if (!existing) throw new AppError(404, 'job_not_found', 'This AI task could not be found.');
  await env.DB.prepare(
    "UPDATE jobs SET status='cancelled',lease_token=NULL WHERE id=? AND owner=? AND project_id=? AND status IN ('queued','running')",
  )
    .bind(jobId, owner, projectId)
    .run();
}
type ProposalRow = {
  id: string;
  job_id: string;
  project_id: string;
  kind: JobKind;
  base_revision: number;
  created_at: string;
  status: AIProposal['status'];
  result: string;
};
const toProposal = (r: ProposalRow): AIProposal => ({
  id: r.id,
  jobId: r.job_id,
  projectId: r.project_id,
  kind: r.kind,
  baseRevision: r.base_revision,
  createdAt: r.created_at,
  status: r.status,
  result: JSON.parse(r.result),
});
export async function listProposals(
  env: Env,
  owner: string,
  projectId: string,
): Promise<AIProposal[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM proposals WHERE owner=? AND project_id=? ORDER BY created_at DESC LIMIT 100',
  )
    .bind(owner, projectId)
    .all<ProposalRow>();
  return rows.results.map(toProposal);
}
export async function applyProposal(
  env: Env,
  owner: string,
  projectId: string,
  proposalId: string,
  expectedRevision: number,
): Promise<Project> {
  const row = await env.DB.prepare(
    'SELECT * FROM proposals WHERE id=? AND owner=? AND project_id=?',
  )
    .bind(proposalId, owner, projectId)
    .first<ProposalRow>();
  if (!row) throw new AppError(404, 'proposal_not_found', 'This AI proposal could not be found.');
  const proposal = toProposal(row),
    project = await getProject(env, owner, projectId);
  if (
    proposal.status !== 'pending' ||
    proposal.baseRevision !== expectedRevision ||
    project.revision !== expectedRevision
  )
    throw new AppError(
      409,
      'stale_proposal',
      'The project changed after this proposal was generated. Regenerate the proposal from the current project to preserve your edits.',
    );
  const job = await env.DB.prepare('SELECT instruction,screen_id FROM jobs WHERE id=? AND owner=?')
    .bind(proposal.jobId, owner)
    .first<{ instruction: string; screen_id: string | null }>();
  if (!job)
    throw new AppError(404, 'job_not_found', 'The task behind this proposal no longer exists.');
  const proposed = proposalToProject(
    project,
    proposal,
    job.instruction,
    job.screen_id ?? undefined,
  );
  const parsed = projectSchema.safeParse(proposed);
  if (!parsed.success)
    throw new AppError(
      400,
      'invalid_proposal',
      'This proposal cannot be safely applied to the current project. Generate a smaller, more focused proposal.',
    );
  return saveProject(
    env,
    owner,
    project,
    parsed.data,
    expectedRevision,
    `Applied AI: ${proposal.kind}`,
    proposalId,
  );
}
export async function dismissProposal(
  env: Env,
  owner: string,
  projectId: string,
  proposalId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "UPDATE proposals SET status='dismissed' WHERE id=? AND owner=? AND project_id=? AND status='pending' RETURNING id",
  )
    .bind(proposalId, owner, projectId)
    .first();
  if (!row) throw new AppError(404, 'proposal_not_pending', 'This proposal is no longer pending.');
}
const base = { protocolVersion: z.literal(1), workerId: idSchema };
export const bridgeSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...base,
      action: z.literal('claim'),
      capabilities: z.array(jobKindSchema).min(1).max(5),
    })
    .strict(),
  z
    .object({ ...base, action: z.literal('heartbeat'), jobId: idSchema, leaseToken: idSchema })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('complete'),
      jobId: idSchema,
      leaseToken: idSchema,
      result: resultSchema.optional(),
      error: z.string().min(1).max(2000).optional(),
    })
    .strict()
    .refine((v) => !!v.result !== !!v.error, 'Send either a result or an error.'),
]);
type BridgeInput = z.infer<typeof bridgeSchema>;
export function validateResultForJob(
  result: AIResult,
  job: { kind: JobKind; screen_id: string | null; context: string },
): void {
  const project = JSON.parse(job.context) as Project;
  if (job.kind === 'wireframe.generate' && !result.screens?.length)
    throw new AppError(400, 'invalid_result', 'Wireframe generation must return screens.');
  if (
    job.kind === 'wireframe.refine' &&
    (result.screens?.length !== 1 || result.screens[0].id !== job.screen_id)
  )
    throw new AppError(
      400,
      'invalid_result',
      'A refinement must return exactly the requested screen with its original identifier.',
    );
  if (
    (job.kind === 'plan.assist' ||
      job.kind === 'plan.review' ||
      job.kind === 'moodboard.direction') &&
    result.screens?.length
  )
    throw new AppError(400, 'invalid_result', 'This job cannot change wireframes.');
  const allowedScreens = new Set(
    (job.kind === 'wireframe.generate' ? (result.screens ?? []) : project.screens).map((s) => s.id),
  );
  for (const s of result.screens ?? [])
    walkNodes(s.nodes, (node) => {
      if (node.action && !allowedScreens.has(node.action.screenId))
        throw new AppError(
          400,
          'invalid_navigation',
          'The AI returned a link to an unknown screen.',
        );
    });
  for (const r of result.requirements)
    if (r.screenId && !allowedScreens.has(r.screenId))
      throw new AppError(
        400,
        'invalid_requirement',
        'The AI returned a requirement for an unknown screen.',
      );
}
export async function bridgeOperation(
  env: Env,
  owner: string,
  input: BridgeInput,
): Promise<unknown> {
  const now = Date.now();
  await expireJobs(env, owner);
  if (input.action === 'claim') {
    await env.DB.prepare(
      'INSERT INTO helpers(owner,worker_id,protocol_version,capabilities,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(owner,worker_id) DO UPDATE SET protocol_version=excluded.protocol_version,capabilities=excluded.capabilities,last_seen=excluded.last_seen',
    )
      .bind(
        owner,
        input.workerId,
        input.protocolVersion,
        JSON.stringify([...new Set(input.capabilities)]),
        now,
      )
      .run();
    const lease = uid('lease');
    const placeholders = input.capabilities.map(() => '?').join(',');
    const row = await env.DB.prepare(
      `UPDATE jobs SET status='running',worker_id=?,lease_token=?,lease_expires_at=?,started_at=? WHERE id=(SELECT id FROM jobs WHERE owner=? AND status='queued' AND kind IN (${placeholders}) AND NOT EXISTS(SELECT 1 FROM jobs WHERE owner=? AND worker_id=? AND status='running') ORDER BY created_at LIMIT 1) AND status='queued' RETURNING *`,
    )
      .bind(
        input.workerId,
        lease,
        now + LEASE_MS,
        now,
        owner,
        ...input.capabilities,
        owner,
        input.workerId,
      )
      .first<JobRow>();
    return {
      protocolVersion: PROTOCOL_VERSION,
      job: row
        ? {
            id: row.id,
            projectId: row.project_id,
            kind: row.kind,
            baseRevision: row.base_revision,
            instruction: row.instruction,
            ...(row.screen_id ? { screenId: row.screen_id } : {}),
            context: JSON.parse(row.context),
            leaseToken: lease,
            leaseExpiresAt: new Date(now + LEASE_MS).toISOString(),
          }
        : null,
    };
  }
  await env.DB.prepare('UPDATE helpers SET last_seen=? WHERE owner=? AND worker_id=?')
    .bind(now, owner, input.workerId)
    .run();
  if (input.action === 'heartbeat') {
    const row = await env.DB.prepare(
      "UPDATE jobs SET lease_expires_at=? WHERE id=? AND owner=? AND worker_id=? AND lease_token=? AND status='running' AND lease_expires_at>=? AND started_at>=? RETURNING id",
    )
      .bind(
        now + LEASE_MS,
        input.jobId,
        owner,
        input.workerId,
        input.leaseToken,
        now,
        now - MAX_RUNTIME_MS,
      )
      .first();
    return {
      ok: true,
      cancelled: !row,
      ...(row ? { leaseExpiresAt: new Date(now + LEASE_MS).toISOString() } : {}),
    };
  }
  const job = await env.DB.prepare(
    'SELECT * FROM jobs WHERE id=? AND owner=? AND worker_id=? AND lease_token=?',
  )
    .bind(input.jobId, owner, input.workerId, input.leaseToken)
    .first<JobRow>();
  // A successful retry with the same token is idempotent, while cancelled/expired leases never publish.
  if (job?.status === 'completed' || job?.status === 'failed') return { ok: true };
  if (
    !job ||
    job.status !== 'running' ||
    (job.lease_expires_at ?? 0) < now ||
    (job.started_at ?? 0) < now - MAX_RUNTIME_MS
  )
    throw new AppError(409, 'lease_expired', 'This job was cancelled or its helper lease expired.');
  if (input.error) {
    await env.DB.prepare(
      "UPDATE jobs SET status='failed',error=? WHERE id=? AND owner=? AND worker_id=? AND lease_token=? AND status='running' AND lease_expires_at>=?",
    )
      .bind(input.error, job.id, owner, input.workerId, input.leaseToken, now)
      .run();
    return { ok: true };
  }
  const result = input.result!;
  validateResultForJob(result, job);
  const proposalId = uid('proposal'),
    createdAt = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE jobs SET status='completed',proposal_id=? WHERE id=? AND owner=? AND worker_id=? AND lease_token=? AND status='running' AND lease_expires_at>=? RETURNING id",
    ).bind(proposalId, job.id, owner, input.workerId, input.leaseToken, now),
    env.DB.prepare(
      "INSERT INTO proposals(id,job_id,project_id,owner,kind,base_revision,created_at,status,result) SELECT ?,id,project_id,owner,kind,base_revision,?,'pending',? FROM jobs WHERE id=? AND owner=? AND changes()=1",
    ).bind(proposalId, createdAt, JSON.stringify(result), job.id, owner),
  ]);
  if (!results[0].results.length)
    throw new AppError(409, 'lease_expired', 'This job is no longer active.');
  return { ok: true };
}
