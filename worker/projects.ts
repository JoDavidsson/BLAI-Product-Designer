import {
  createProject,
  reconcileReferences,
  uid,
  type AIProposal,
  type Project,
  type ProjectSummary,
  type ProjectVersion,
} from '../shared/model';
import { createSampleProject } from '../shared/seed';
import { projectSchema } from '../shared/validation';
import { AppError, type Env } from './types';

export async function getProject(env: Env, owner: string, id: string): Promise<Project> {
  const row = await env.DB.prepare('SELECT data FROM projects WHERE id = ? AND owner = ?')
    .bind(id, owner)
    .first<{ data: string }>();
  if (!row) throw new AppError(404, 'project_not_found', 'This project could not be found.');
  return JSON.parse(row.data) as Project;
}
export async function listProjects(env: Env, owner: string): Promise<ProjectSummary[]> {
  const rows = await env.DB.prepare(
    "SELECT id,title,summary,platform,updated_at AS updatedAt,revision,json_array_length(data,'$.screens') AS screenCount FROM projects WHERE owner = ? ORDER BY updated_at DESC LIMIT 100",
  )
    .bind(owner)
    .all<ProjectSummary>();
  return rows.results;
}
export async function newProject(
  env: Env,
  owner: string,
  title?: string,
  sample = false,
): Promise<Project> {
  const p = sample ? createSampleProject() : createProject(title);
  if (title) p.title = title;
  projectSchema.parse(p);
  await env.DB.prepare(
    'INSERT INTO projects(id,owner,title,summary,platform,revision,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      p.id,
      owner,
      p.title,
      p.summary,
      p.platform,
      p.revision,
      p.createdAt,
      p.updatedAt,
      JSON.stringify(p),
    )
    .run();
  return p;
}
export async function saveProject(
  env: Env,
  owner: string,
  current: Project,
  proposed: Project,
  expectedRevision: number,
  label = 'Saved revision',
  proposalId?: string,
): Promise<Project> {
  const reconciled = reconcileReferences({ ...proposed, id: current.id }, current);
  const p = projectSchema.parse({
    ...reconciled,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    revision: expectedRevision + 1,
  });
  // An asset URL is an opaque reference, but still cannot attach someone else's uploaded asset.
  for (const a of p.assets)
    if (a.imageUrl.startsWith('/api/assets/')) {
      const asset = await env.DB.prepare(
        'SELECT key FROM assets WHERE key=? AND owner=? AND project_id=?',
      )
        .bind(a.imageUrl.slice('/api/assets/'.length), owner, p.id)
        .first();
      if (!asset)
        throw new AppError(
          400,
          'asset_not_owned',
          'An image does not belong to this project. Upload it here first.',
        );
    }
  const encoded = JSON.stringify(p);
  if (encoded.length > 1500000)
    throw new AppError(
      413,
      'project_too_large',
      'This project is too large. Split it into smaller projects.',
    );
  const predicate = proposalId
    ? " AND EXISTS(SELECT 1 FROM proposals WHERE id=? AND project_id=projects.id AND owner=projects.owner AND status='pending' AND base_revision=?)"
    : '';
  const values = [
    p.title,
    p.summary,
    p.platform,
    p.revision,
    p.updatedAt,
    encoded,
    p.id,
    owner,
    expectedRevision,
    ...(proposalId ? [proposalId, expectedRevision] : []),
  ];
  const operations = [
    env.DB.prepare(
      `UPDATE projects SET title=?,summary=?,platform=?,revision=?,updated_at=?,data=? WHERE id=? AND owner=? AND revision=?${predicate} RETURNING data`,
    ).bind(...values),
    env.DB.prepare(
      'INSERT INTO versions(id,project_id,owner,revision,label,created_at,data) SELECT ?,id,owner,revision,?,updated_at,data FROM projects WHERE id=? AND owner=? AND changes()=1',
    ).bind(uid('version'), label, p.id, owner),
  ];
  if (proposalId)
    operations.push(
      env.DB.prepare(
        "UPDATE proposals SET status='applied' WHERE id=? AND owner=? AND status='pending' AND changes()=1",
      ).bind(proposalId, owner),
    );
  // Keep routine autosave history bounded while preserving named/AI/restore checkpoints.
  operations.push(
    env.DB.prepare(
      "DELETE FROM versions WHERE project_id=? AND owner=? AND label='Saved revision' AND id NOT IN (SELECT id FROM versions WHERE project_id=? AND owner=? AND label='Saved revision' ORDER BY created_at DESC LIMIT 50)",
    ).bind(p.id, owner, p.id, owner),
  );
  const result = await env.DB.batch(operations);
  if (!result[0].results.length)
    throw new AppError(
      409,
      'revision_conflict',
      'The project changed since this edit began. Reload before applying changes. Your draft has not overwritten the saved project.',
    );
  return p;
}
export async function listVersions(
  env: Env,
  owner: string,
  projectId: string,
): Promise<ProjectVersion[]> {
  const rows = await env.DB.prepare(
    'SELECT id,revision,created_at AS createdAt,label FROM versions WHERE owner=? AND project_id=? ORDER BY created_at DESC LIMIT 100',
  )
    .bind(owner, projectId)
    .all<ProjectVersion>();
  return rows.results;
}
export async function snapshot(
  env: Env,
  owner: string,
  projectId: string,
  label: string,
): Promise<ProjectVersion> {
  const p = await getProject(env, owner, projectId);
  const version = {
    id: uid('version'),
    revision: p.revision,
    createdAt: new Date().toISOString(),
    label,
  };
  await env.DB.prepare(
    'INSERT INTO versions(id,project_id,owner,revision,label,created_at,data) VALUES(?,?,?,?,?,?,?)',
  )
    .bind(version.id, p.id, owner, p.revision, label, version.createdAt, JSON.stringify(p))
    .run();
  return version;
}
export async function restoreVersion(
  env: Env,
  owner: string,
  projectId: string,
  versionId: string,
  expectedRevision: number,
): Promise<Project> {
  const current = await getProject(env, owner, projectId);
  const row = await env.DB.prepare(
    'SELECT data FROM versions WHERE id=? AND project_id=? AND owner=?',
  )
    .bind(versionId, projectId, owner)
    .first<{ data: string }>();
  if (!row) throw new AppError(404, 'version_not_found', 'This saved version could not be found.');
  return saveProject(
    env,
    owner,
    current,
    JSON.parse(row.data),
    expectedRevision,
    'Restored version',
  );
}
export async function deleteProject(env: Env, owner: string, projectId: string): Promise<void> {
  await getProject(env, owner, projectId);
  const images = await env.DB.prepare('SELECT key FROM assets WHERE owner=? AND project_id=?')
    .bind(owner, projectId)
    .all<{ key: string }>();
  await env.DB.prepare('DELETE FROM projects WHERE id=? AND owner=?').bind(projectId, owner).run();
  // References disappear first; a failed object cleanup cannot expose deleted project data.
  if (images.results.length) await env.ASSETS_BUCKET.delete(images.results.map((r) => r.key));
}
export function proposalToProject(
  project: Project,
  proposal: AIProposal,
  _instruction: string,
  screenId?: string,
): Project {
  const next = structuredClone(project);
  const r = proposal.result;
  if (proposal.kind === 'plan.assist' || proposal.kind === 'plan.review')
    next.plan = { ...next.plan, ...r.plan };
  if (proposal.kind === 'wireframe.generate' && r.screens) next.screens = r.screens;
  if (proposal.kind === 'wireframe.refine') {
    if (!screenId || !r.screens?.length || r.screens.some((s) => s.id !== screenId))
      throw new AppError(
        400,
        'invalid_refinement',
        'A screen refinement can only replace its requested screen.',
      );
    if (!next.screens.some((s) => s.id === screenId))
      throw new AppError(
        409,
        'screen_missing',
        'The screen this proposal refines no longer exists.',
      );
    next.screens = next.screens.map((s) => (s.id === screenId ? r.screens![0] : s));
  }
  if (
    r.design &&
    (proposal.kind === 'moodboard.direction' || proposal.kind === 'wireframe.generate')
  )
    next.design = r.design;
  next.requirements.push(
    ...r.requirements.map((item) => ({ ...item, id: uid('req'), status: 'accepted' as const })),
  );
  const now = new Date().toISOString();
  // The browser saves the user's message before enqueueing. Applying a proposal
  // records only its accepted reply; the original instruction remains in jobs.
  next.chat = [
    ...next.chat,
    { id: uid('chat'), role: 'assistant', text: r.reply, createdAt: now },
  ].slice(-200) as Project['chat'];
  return reconcileReferences(next, project);
}
