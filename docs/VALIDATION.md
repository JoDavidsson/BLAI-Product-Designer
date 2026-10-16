# First-pass validation

Validated in the managed Linux development environment with Node 24.19.0 and system Chromium. The environment was installed from the frozen lockfile, the local D1 migration was applied twice to confirm repeatability, and the development server was restarted.

## Passed

- `npm ci`: clean dependency installation.
- `npm test`: 38 tests across five files, including real local Worker/D1/R2 integration.
- `npm run test:helper`: 11 tests for protocol, schemas, cancellation, timeouts, credentials handling, and Linux setup.
- `npm run build`: TypeScript and both client and Worker production bundles.
- `npm run format:check`: source formatting.
- `npm run test:e2e`: three browser workflows, each using temporary projects that are deleted afterward.

The browser workflows cover planning/autosave, blocked editing during project transitions, checkpoints/restore, synchronized annotation/requirement decisions, actual ZIP downloads, GitHub configuration states, project creation, honest offline-AI states, and mobile planning layout. They also exercise nested drag reordering, stable pinned comments, navigation previews, state variants, real R2 image uploads, screenshot review, replies, acceptance links, and reload persistence. Delayed upload regressions cover both changing views and switching projects while an upload finishes.

Screenshots in `docs/screenshots/` show the actual application using the editable Wayfinder example.

## External operations not validated

- No live Cloudflare deployment: account credentials and new resource IDs are not configured in this workspace.
- No end-to-end request through the user's Linux Codex helper. The dedicated helper implementation and server protocol are tested; the user must pair and start the new helper to validate their subscription session.
- No real GitHub specification export from the application. Its atomic API behavior is tested with fixtures; a server-side token and chosen destination are required.
- No successful image-generation artifact integration. Official Codex source confirms native subscription support, but a bounded CLI probe could not initialize its read-only app-server runtime here. The image capability remains disabled. No API-key fallback is used.
- Real remote image imports were not exercised against an external image host. URL/DNS/redirect validation and image handling have fixture coverage, and actual uploaded image handling was tested through local R2.

Source-code publication through the existing Git proxy is a separate operation from the application's GitHub export and from Cloudflare deployment.
