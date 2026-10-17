# Validation

Validated in the managed Linux development environment with Node 24.19.0 and system Chromium. The environment was installed from the frozen lockfile, the local D1 migration was applied twice to confirm repeatability, and the development server was restarted.

## Passed

- `npm ci`: clean dependency installation.
- `npm test`: 65 tests across nine files, including real local Worker/D1/R2 integration.
- `npm run test:helper`: 19 tests for protocol, schemas, cancellation, timeouts, credentials handling, and Linux setup.
- `npm run build`: TypeScript and both client and Worker production bundles.
- `npm run format:check`: source formatting.
- `npm audit`: zero reported vulnerabilities in the installed dependency tree (2026-10-17).
- `npm run test:e2e`: five browser workflows, each using temporary projects that are deleted afterward.

The browser workflows cover planning/autosave, blocked editing during project transitions, checkpoints/restore, synchronized annotation/requirement decisions, actual ZIP downloads, GitHub configuration states, project creation, honest offline-AI states, and mobile planning layout. They also exercise nested drag reordering, stable pinned comments, navigation previews, state variants, real R2 image uploads, screenshot review, replies, acceptance links, and reload persistence. Delayed upload regressions cover both changing views and switching projects while an upload finishes.

The second iteration additionally covers undo/redo across autosaves, an older save arriving after undo, revision-conflict download/reload recovery, keyboard focus containment, proposal plan/design/component inspection, stale proposals, checkpoint responses arriving during project switches, and a late upload being explicitly rejected during checkpoint restoration. Canvas checks cover cross-screen copy/paste, keyboard editing, real empty-container drops, layout conversion, annotation attachment after reparenting, and blank-name validation. Board checks cover Escape-close persistence and invalid source URL drafts.

Backend regressions verify UTF-8 storage limits, complete-project AI validation, 100-image ownership checks, and GitHub destination ownership/symlink/stale-file handling. Helper regressions include cancellation through heartbeat and completion races, streamed Unicode, and a real subprocess that requires SIGKILL after ignoring SIGTERM. GitHub Actions now includes a browser job; its hosted run is separate from the local validation recorded here.

The Pele experiment additionally verifies both diagram renderers, bounded source and flowchart work, disabled links/images, autosave and legacy project compatibility, invalid-draft recovery, keyboard/button zoom, diagram undo/duplication/deletion, project isolation, exact Mermaid ZIP bytes and checksums, and GitHub stale diagram cleanup. All five browser workflows passed on this branch. The renderer workspace is a separate 158.88 kB JavaScript chunk (58.94 kB gzip), loaded only when Flows is opened; no Pele renderer is bundled into the Worker. License notices are included in the built static assets.

Screenshots in `docs/screenshots/` show the actual application using the editable Wayfinder example.

## External operations not validated

- No live Cloudflare deployment: account credentials and new resource IDs are not configured in this workspace.
- No end-to-end request through the user's Linux Codex helper. The dedicated helper implementation and server protocol are tested; the user must pair and start the new helper to validate their subscription session.
- No real GitHub specification export from the application. Its atomic API behavior is tested with fixtures; a server-side token and chosen destination are required.
- No successful image-generation artifact integration. Official Codex source confirms native subscription support, but a bounded CLI probe could not initialize its read-only app-server runtime here. The image capability remains disabled. No API-key fallback is used.
- Real remote image imports were not exercised against an external image host. URL/DNS/redirect validation and image handling have fixture coverage, and actual uploaded image handling was tested through local R2.

Source-code publication through the existing Git proxy is a separate operation from the application's GitHub export and from Cloudflare deployment.
