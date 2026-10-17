import { z } from 'zod';
import { jobKindSchema, projectSchema, revisionSchema } from '../shared/validation';
import { authenticate, authenticateBridge, enforceSameOrigin } from './auth';
import { AppError, type Env } from './types';
import { body, json, noCache } from './http';
import {
  getProject,
  listProjects,
  newProject,
  saveProject,
  listVersions,
  snapshot,
  restoreVersion,
  deleteProject,
} from './projects';
import {
  helperStatus,
  listJobs,
  enqueueJob,
  cancelJob,
  listProposals,
  applyProposal,
  dismissProposal,
  bridgeSchema,
  bridgeOperation,
} from './jobs';
import { uploadImage, importImage, serveAsset } from './assets';
import { buildProjectExport, publishGithubExport } from './export';

const revisionBody = z.object({ expectedRevision: revisionSchema }).strict();
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (path === '/api/health' && (method === 'GET' || method === 'HEAD')) return json({ ok: true });
  if (!path.startsWith('/api/'))
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  try {
    enforceSameOrigin(request);
    const identity = await authenticate(request, env);
    if (path === '/api/codex' && method === 'POST') {
      const owner = await authenticateBridge(request, env);
      return json(await bridgeOperation(env, owner, await body(request, bridgeSchema, 650000)));
    }
    if (!identity) throw new AppError(401, 'sign_in_required', 'Sign in to continue.');
    const owner = identity.owner;
    if (path === '/api/session' && method === 'GET')
      return json({
        email: identity.email,
        local: identity.local,
        githubConfigured: !!env.GITHUB_TOKEN,
      });
    if (path === '/api/helper/status' && method === 'GET')
      return json(await helperStatus(env, owner));
    if (path === '/api/helper/setup' && method === 'GET') {
      if (!identity.local && env.DESIGNER_OWNER_EMAIL?.trim().toLowerCase() !== identity.email)
        throw new AppError(
          403,
          'helper_owner_only',
          'Only the configured designer owner can download helper settings.',
        );
      const accessRequired =
        !identity.local || !!env.DESIGNER_ACCESS_CLIENT_ID || !!env.DESIGNER_ACCESS_CLIENT_SECRET;
      const accessReady = [env.DESIGNER_ACCESS_CLIENT_ID, env.DESIGNER_ACCESS_CLIENT_SECRET].every(
        (value) => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value),
      );
      if (
        !env.DESIGNER_BRIDGE_SECRET ||
        !/^[\x21-\x7e]{32,200}$/.test(env.DESIGNER_BRIDGE_SECRET) ||
        (accessRequired && !accessReady)
      )
        throw new AppError(
          503,
          'helper_setup_missing',
          'Configure this Worker’s DESIGNER_BRIDGE_SECRET (32–200 printable ASCII characters), DESIGNER_OWNER_EMAIL, DESIGNER_ACCESS_CLIENT_ID, and DESIGNER_ACCESS_CLIENT_SECRET before downloading helper settings. Keep these separate from your writing tool.',
        );
      const settings = {
        site: url.origin,
        bridgeSecret: env.DESIGNER_BRIDGE_SECRET,
        ...(env.DESIGNER_ACCESS_CLIENT_ID && env.DESIGNER_ACCESS_CLIENT_SECRET
          ? {
              accessClientId: env.DESIGNER_ACCESS_CLIENT_ID,
              accessClientSecret: env.DESIGNER_ACCESS_CLIENT_SECRET,
            }
          : {}),
      };
      return new Response(JSON.stringify(settings, null, 2), {
        headers: {
          ...noCache,
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="blai-designer-helper.json"',
        },
      });
    }
    if (path === '/api/projects') {
      if (method === 'GET') return json({ projects: await listProjects(env, owner) });
      if (method === 'POST') {
        const input = await body(
          request,
          z
            .object({
              title: z.string().trim().min(1).max(200).optional(),
              sample: z.boolean().optional(),
            })
            .strict(),
        );
        return json({ project: await newProject(env, owner, input.title, input.sample) }, 201);
      }
    }
    const asset = path.match(/^\/api\/assets\/([a-zA-Z0-9_-]+)$/);
    if (asset && method === 'GET') return await serveAsset(env, owner, asset[1]);
    const route = path.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
    if (!route) throw new AppError(404, 'not_found', 'This endpoint does not exist.');
    const projectId = route[1],
      tail = route[2] ?? '';
    const project = await getProject(env, owner, projectId);
    if (!tail) {
      if (method === 'GET') return json({ project });
      if (method === 'PUT') {
        const input = await body(
          request,
          z.object({ project: projectSchema, expectedRevision: revisionSchema }).strict(),
        );
        return json({
          project: await saveProject(env, owner, project, input.project, input.expectedRevision),
        });
      }
      if (method === 'DELETE') {
        await deleteProject(env, owner, projectId);
        return json({ ok: true });
      }
    }
    if (tail === 'versions') {
      if (method === 'GET') return json({ versions: await listVersions(env, owner, projectId) });
      if (method === 'POST') {
        const input = await body(
          request,
          z.object({ label: z.string().trim().min(1).max(200) }).strict(),
        );
        return json({ version: await snapshot(env, owner, projectId, input.label) }, 201);
      }
    }
    const restore = tail.match(/^versions\/([a-zA-Z0-9_-]+)\/restore$/);
    if (restore && method === 'POST') {
      const input = await body(request, revisionBody);
      return json({
        project: await restoreVersion(env, owner, projectId, restore[1], input.expectedRevision),
      });
    }
    if (tail === 'jobs') {
      if (method === 'GET') return json({ jobs: await listJobs(env, owner, projectId) });
      if (method === 'POST') {
        const input = await body(
          request,
          z
            .object({
              kind: jobKindSchema,
              instruction: z.string().trim().min(1).max(12000),
              screenId: z
                .string()
                .regex(/^[a-zA-Z0-9_-]+$/)
                .max(100)
                .optional(),
            })
            .strict(),
        );
        return json({ job: await enqueueJob(env, owner, project, input) }, 201);
      }
    }
    const job = tail.match(/^jobs\/([a-zA-Z0-9_-]+)$/);
    if (job && method === 'DELETE') {
      await cancelJob(env, owner, projectId, job[1]);
      return json({ ok: true });
    }
    if (tail === 'proposals' && method === 'GET')
      return json({ proposals: await listProposals(env, owner, projectId) });
    const proposal = tail.match(/^proposals\/([a-zA-Z0-9_-]+)\/(apply|dismiss)$/);
    if (proposal && method === 'POST') {
      if (proposal[2] === 'apply') {
        const input = await body(request, revisionBody);
        return json({
          project: await applyProposal(env, owner, projectId, proposal[1], input.expectedRevision),
        });
      }
      await dismissProposal(env, owner, projectId, proposal[1]);
      return json({ ok: true });
    }
    if (tail === 'assets' && method === 'POST')
      return json({ asset: await uploadImage(request, env, owner, projectId) }, 201);
    if (tail === 'assets/import' && method === 'POST') {
      const input = await body(
        request,
        z
          .object({
            url: z.string().url().max(2048),
            title: z.string().max(200).optional(),
            kind: z.enum(['reference', 'screenshot']).optional(),
          })
          .strict(),
      );
      return json({ asset: await importImage(env, owner, projectId, input) }, 201);
    }
    if (tail === 'export' && method === 'GET') {
      const exported = await buildProjectExport(project, { bucket: env.ASSETS_BUCKET, owner });
      return new Response(new Uint8Array(exported.zip).buffer, {
        headers: {
          ...noCache,
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="blai-${project.id}.zip"`,
        },
      });
    }
    if (tail === 'export/github' && method === 'POST') {
      if (!env.GITHUB_TOKEN)
        throw new AppError(
          503,
          'github_not_configured',
          'Add a fine-grained GITHUB_TOKEN secret to this designer Worker with contents write access to your destination repository.',
        );
      const input = await body(
        request,
        z
          .object({
            repository: z.string().min(3).max(200),
            branch: z.string().min(1).max(200),
            path: z.string().min(1).max(200),
          })
          .strict(),
      );
      const exported = await buildProjectExport(project, {
        bucket: env.ASSETS_BUCKET,
        owner,
        includeZip: false,
      });
      return json(await publishGithubExport(exported.files, { token: env.GITHUB_TOKEN, ...input }));
    }
    throw new AppError(404, 'not_found', 'This endpoint does not exist.');
  } catch (error) {
    if (error instanceof AppError)
      return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError)
      return json(
        {
          error: 'The document does not match the supported project structure.',
          code: 'invalid_document',
        },
        400,
      );
    // Log only error category. Request bodies, JWTs, secret headers, and remote responses stay private.
    console.error('designer_request_failed', error instanceof Error ? error.name : 'unknown');
    return json(
      { error: 'The request could not be completed. Try again.', code: 'internal_error' },
      500,
    );
  }
}
export default { fetch: handleRequest };
