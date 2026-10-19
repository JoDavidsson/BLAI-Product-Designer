# Validation

Validated in the managed Linux development environment with Node 24.19.0 and system Chromium. The environment was installed from the frozen lockfile, the local D1 migration was applied twice to confirm repeatability, and the development server was restarted.

## Passed

- `npm ci`: clean dependency installation.
- `npm test`: 122 tests across eleven files, including real local Worker/D1/R2 integration.
- `npm run test:helper`: 40 tests for protocol, schemas, cancellation, timeouts, credentials handling, and Linux setup.
- `npm run build`: TypeScript and both client and Worker production bundles.
- `npm run format:check`: source formatting.
- `npm audit`: zero reported vulnerabilities in the installed dependency tree (2026-10-17).
- `npm run test:e2e`: seven browser workflows, each using temporary projects that are deleted afterward.

The browser workflows cover planning/autosave, blocked editing during project transitions, checkpoints/restore, synchronized annotation/requirement decisions, actual ZIP downloads, GitHub configuration states, project creation, honest offline-AI states, and mobile planning layout. They also exercise nested drag reordering, stable pinned comments, navigation previews, state variants, real R2 image uploads, screenshot review, replies, acceptance links, and reload persistence. Delayed upload regressions cover both changing views and switching projects while an upload finishes.

The second iteration additionally covers undo/redo across autosaves, an older save arriving after undo, revision-conflict download/reload recovery, keyboard focus containment, proposal plan/design/component inspection, stale proposals, checkpoint responses arriving during project switches, and a late upload being explicitly rejected during checkpoint restoration. Canvas checks cover cross-screen copy/paste, keyboard editing, real empty-container drops, layout conversion, annotation attachment after reparenting, and blank-name validation. Board checks cover Escape-close persistence and invalid source URL drafts.

Backend regressions verify UTF-8 storage limits, complete-project AI validation, 100-image ownership checks, and GitHub destination ownership/symlink/stale-file handling. Helper regressions include cancellation through heartbeat and completion races, streamed Unicode, and a real subprocess that requires SIGKILL after ignoring SIGTERM. GitHub Actions now includes a browser job; its hosted run is separate from the local validation recorded here.

The automatic Pele overview additionally verifies real mindmap and flowchart rendering, bounded output, disabled links/images, and inert hostile source text. Tests confirm visualization preserves the full project and revision, makes no AI requests, and provides no diagram authoring interface. Pointer and keyboard inspection link back to exact plan sections, screens, components, requirements, resolved discussions, image references, and conversation messages. Current-source refresh, reloads, project isolation, narrow layouts, complete grouped source coverage, conservative numbered-list handling, and explicit-only screen navigation are covered.

Exports rebuild all three overview files and a full source index from the current project. Tests verify provenance, checksums, legacy draft preservation, safe owned-file cleanup, and destination collision handling. All seven browser workflows passed on this branch. The Overview workspace remains a separate JavaScript chunk, loaded only when Overview is opened; the Worker shares the pure projection but does not bundle Pele. License notices are included in the built static assets.

Screenshots in `docs/screenshots/` show the actual application using the editable Wayfinder example.

## Freeform canvas QA — 2026-10-19

The freeform browser workflow uses disposable synthetic projects and real local D1/R2. It verifies zoomed pointer movement, resizing, rotation, grouping/ungrouping without world-position drift, layer order/lock/hide, root-group copy/paste and duplication with unique descendant IDs, persistent automatic layout after resize/reorder and switching back to free placement, drawing shapes and paths, inline text, image insertion, undo/redo, persistence, and legacy conversion with stable IDs and comments. Rotated comment pins and dotted margin leaders are measured against rendered geometry. Desktop and narrow layouts are inspected visually.

Regression checks cover text drafts before navigation, a delayed autosave response arriving during a drag, late image responses during undo and checkpoint restore, and removal of a reference still used by a canvas image. Proposal review shows an inert spatial preview and fits a narrow viewport without modifying the project. Unit tests additionally cover nested rotation, bounded transforms, persistent automatic layout, strict scene validation, accurate SVG exports, and project-owned images.

[The swipe-card composition](screenshots/freeform-canvas.png) is a hand-authored browser-test fixture demonstrating overlapping, separately editable image cards and controls. It is not an AI-generation quality benchmark. The browser test moves its card group, saves it, and verifies it after reloading.

The shared BLAI manager's 95 tests pass with release version 1.1.0, including packaging and both actual adapters with fixture runners. Designer retains GPT-6 Astra, Medium reasoning, 872000 configured context, and forced ChatGPT authentication. The Writer checkout and its settings are unchanged. The production build and helper archive are prepared locally.

## External operations not validated

- This freeform release has not been deployed to Cloudflare. Deployment waits for review of the local QA result.
- No live model request through BLAI Helper 1.1.0. Geometry output, negotiated fallback, completion, proposal application, and authentication settings are covered by helper fixtures and real local D1 integration. The new helper must be installed on the user's Linux computer before a live subscription request validates this release.
- No real GitHub specification export from the application. Its atomic API behavior is tested with fixtures; a server-side token and chosen destination are required.
- No successful image-generation artifact integration. Official Codex source confirms native subscription support, but a bounded CLI probe could not initialize its read-only app-server runtime here. The image capability remains disabled. No API-key fallback is used.
- Real remote image imports were not exercised against an external image host. URL/DNS/redirect validation and image handling have fixture coverage, and actual uploaded image handling was tested through local R2.

Source-code publication through the existing Git proxy is a separate operation from the application's GitHub export and from Cloudflare deployment.
