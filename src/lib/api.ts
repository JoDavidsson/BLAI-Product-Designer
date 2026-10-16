import type {
  Project,
  ProjectSummary,
  AIJob,
  AIProposal,
  JobKind,
  HelperStatus,
  ProjectVersion,
} from '../../shared/model';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const data = (await response
      .json()
      .catch(() => ({ error: `Request failed (${response.status})` }))) as {
      error?: string;
      code?: string;
    };
    throw new ApiError(
      data.error || `Request failed (${response.status})`,
      response.status,
      data.code,
    );
  }
  return response.json() as Promise<T>;
}
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
export const api = {
  session: () =>
    request<{ email: string; local: boolean; githubConfigured: boolean }>('/api/session'),
  projects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  create: (title?: string, sample = false) =>
    request<{ project: Project }>('/api/projects', json('POST', { title, sample })),
  get: (id: string) => request<{ project: Project }>(`/api/projects/${id}`),
  save: (project: Project, expectedRevision: number) =>
    request<{ project: Project }>(
      `/api/projects/${project.id}`,
      json('PUT', { project, expectedRevision }),
    ),
  delete: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, json('DELETE')),
  helper: () => request<HelperStatus>('/api/helper/status'),
  jobs: (id: string) => request<{ jobs: AIJob[] }>(`/api/projects/${id}/jobs`),
  generate: (id: string, kind: JobKind, instruction: string, screenId?: string) =>
    request<{ job: AIJob }>(
      `/api/projects/${id}/jobs`,
      json('POST', { kind, instruction, screenId }),
    ),
  cancel: (id: string, job: string) =>
    request<{ ok: true }>(`/api/projects/${id}/jobs/${job}`, json('DELETE')),
  proposals: (id: string) => request<{ proposals: AIProposal[] }>(`/api/projects/${id}/proposals`),
  apply: (project: Project, proposalId: string) =>
    request<{ project: Project }>(
      `/api/projects/${project.id}/proposals/${proposalId}/apply`,
      json('POST', { expectedRevision: project.revision }),
    ),
  dismiss: (id: string, proposalId: string) =>
    request<{ ok: true }>(`/api/projects/${id}/proposals/${proposalId}/dismiss`, json('POST')),
  versions: (id: string) => request<{ versions: ProjectVersion[] }>(`/api/projects/${id}/versions`),
  checkpoint: (id: string, label: string) =>
    request<{ version: ProjectVersion }>(`/api/projects/${id}/versions`, json('POST', { label })),
  restore: (project: Project, versionId: string) =>
    request<{ project: Project }>(
      `/api/projects/${project.id}/versions/${versionId}/restore`,
      json('POST', { expectedRevision: project.revision }),
    ),
  github: (id: string, body: { repository: string; branch: string; path: string }) =>
    request<{ url: string; commit: string }>(
      `/api/projects/${id}/export/github`,
      json('POST', body),
    ),
};
