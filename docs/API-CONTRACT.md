# Implementation contract

All API responses are JSON except image downloads and ZIP exports. Errors are `{error: string, code?: string}` with meaningful HTTP status. Every project operation is scoped to the authenticated owner. Local development authentication is explicitly local-only; production fails closed without Access settings. Shared frontend/backend types are in `shared/model.ts`.

## Browser endpoints

- `GET /api/health` -> `{ok:true}` (public readiness only).
- `GET /api/session` -> `{email:string, local:boolean, githubConfigured:boolean}`.
- `GET /api/helper/status` -> `HelperStatus`.
- `GET /api/projects` -> `{projects: ProjectSummary[]}`.
- `POST /api/projects` body `{title?:string, sample?:boolean}` -> `{project:Project}`. `sample:true` creates the curated sample project.
- `GET /api/projects/:id` -> `{project:Project}`.
- `PUT /api/projects/:id` body `{project:Project, expectedRevision:number}` -> `{project:Project}`; atomic optimistic concurrency; conflict 409. Server owns id, owner, revision, timestamps.
- `DELETE /api/projects/:id` -> `{ok:true}`.
- `GET /api/projects/:id/versions` -> `{versions:ProjectVersion[]}`.
- `POST /api/projects/:id/versions` body `{label:string}` -> `{version:ProjectVersion}`.
- `POST /api/projects/:id/versions/:versionId/restore` body `{expectedRevision:number}` -> `{project:Project}`.
- `GET /api/projects/:id/jobs` -> `{jobs:AIJob[]}`.
- `POST /api/projects/:id/jobs` body `{kind:JobKind,instruction:string,screenId?:string}` -> `{job:AIJob}`. Take a bounded snapshot of project context. Reject with 503 when compatible helper is offline. No fake AI fallback.
- `DELETE /api/projects/:id/jobs/:jobId` -> `{ok:true}`.
- `GET /api/projects/:id/proposals` -> `{proposals:AIProposal[]}`.
- `POST /api/projects/:id/proposals/:proposalId/apply` body `{expectedRevision:number}` -> `{project:Project}`. Reject stale proposals with 409. Wireframe refine replaces only requested screen(s); generate replaces the screen draft with explicit review. Apply plan fields selectively. Requirements get stable IDs. AI conversation reply is appended on apply. Proposal storage is separate from editable project revision.
- `POST /api/projects/:id/proposals/:proposalId/dismiss` -> `{ok:true}`.
- `POST /api/projects/:id/assets` multipart `file`, `kind` (`reference` or `screenshot`), `title` -> `{asset:BoardAsset}`. Upload does not mutate project JSON; UI adds the returned asset through normal project save. Validate image content/MIME/size (10 MB maximum), disallow uploaded SVG. Store opaque key in R2 with owner/project metadata.
- `POST /api/projects/:id/assets/import` JSON `{url:string,title?:string,kind?:'reference'|'screenshot'}` -> `{asset:BoardAsset}`. Remote import allows HTTPS public image URLs or stores a webpage reference with no image; block private/local destinations and revalidate redirects. Return actionable error rather than scraping arbitrary pages unsafely.
- `GET /api/assets/:key` -> authenticated image stream scoped to owner (key contains no `/`).
- `GET /api/projects/:id/export` -> ZIP archive with product spec Markdown, structured project JSON, screens SVG, requirements, and bundled uploaded images with a manifest. Accepted vs open notes and unresolved questions remain explicit.
- `POST /api/projects/:id/export/github` body `{repository:'owner/repo',branch:string,path:string}` -> `{url:string,commit:string}`. Explicit user action. Uses configured server-side `GITHUB_TOKEN`, validates destination/path, writes only handoff package paths using atomic Git tree/commit API with non-force branch update. Preserve other repository files. Missing token -> actionable 503.

## Helper protocol

Agent implementing worker and agent implementing helper must agree exact envelope directly. Shared version=1 and job kinds above. Reference pattern: outbound `POST /api/codex` with `x-designer-bridge-key` and Cloudflare Access service-token headers. Actions claim/heartbeat/complete, strict schemas, lease+worker ownership, cancellation and timeouts. Helper receives bounded product context and returns `AIResult`, validated both sides. Never run generated code. Separate service/config from writing tool.

## Frontend component contracts

Root owns App, API client, global project state, planner, settings, handoff and shared CSS. Feature components receive `project:Project`, `onChange:(project:Project)=>void`, `onToast:(message:string)=>void`. Export defaults:

- `src/components/WireframeWorkspace.tsx`: additionally `onGenerate:(kind:JobKind,instruction:string,screenId?:string)=>void`, `helperOnline:boolean`. Own all nested canvas/prototype controls and `wireframe.css`. No own API calls.
- `src/components/BoardWorkspace.tsx`: additionally `mode:'reference'|'screenshot'`, `onGenerate:(kind:JobKind,instruction:string,screenId?:string)=>void`, `helperOnline:boolean`. Own moodboard/review controls and `board.css`. Upload/import uses shared `api` (`src/lib/api.ts`) or typed fetch to endpoints above; notify state via onChange.
- `src/components/AnnotationPanel.tsx`: shared feature owned by board agent; props `project`, `onChange`, `target?:AnnotationTarget`, `onClose?:()=>void`, `onToast`, `filter?:{screenId?:string,assetId?:string}`. Render threads, replies, accept-as-requirement, resolve/reopen; `target` opens new comment composer. `AnnotationOverlay.tsx` props `{comments:Annotation[],onSelect:(comment:Annotation)=>void,selectedId?:string,onAdd?:(x:number,y:number)=>void,adding?:boolean}`. Absolute overlay with normalized coordinate pins and dotted SVG leader lines to labels. Pointer-events off except pins/composer interaction. Canvas agent can use this or their own target-aware wrapper.

Available dependencies: React 19, lucide-react, @dnd-kit/core/sortable/utilities, fflate, zod, date-fns. Root will install. Keep accessible controls and no inert buttons. Icons from lucide-react. Tokens: ink #232833, muted #858993, line #e9e8ed, accent #7360df, canvas #f6f5f2, white panels. Font system sans; use careful hierarchy/spacing and a polished light studio.
