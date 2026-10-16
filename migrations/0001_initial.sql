PRAGMA foreign_keys = ON;
CREATE TABLE projects (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
  platform TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX projects_owner ON projects(owner, updated_at DESC);
CREATE TABLE versions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner TEXT NOT NULL, revision INTEGER NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX versions_project ON versions(project_id, created_at DESC);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner TEXT NOT NULL, kind TEXT NOT NULL, base_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  instruction TEXT NOT NULL, screen_id TEXT, context TEXT NOT NULL, created_at TEXT NOT NULL,
  worker_id TEXT, lease_token TEXT, lease_expires_at INTEGER, started_at INTEGER,
  error TEXT, proposal_id TEXT
);
CREATE INDEX jobs_claim ON jobs(owner, status, created_at);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner TEXT NOT NULL,
  kind TEXT NOT NULL, base_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','applied','dismissed')), result TEXT NOT NULL
);
CREATE INDEX proposals_project ON proposals(project_id, created_at DESC);
CREATE TABLE helpers (
  owner TEXT NOT NULL, worker_id TEXT NOT NULL, protocol_version INTEGER NOT NULL,
  capabilities TEXT NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(owner, worker_id)
);
CREATE TABLE assets (
  key TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mime TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX assets_project ON assets(project_id);
