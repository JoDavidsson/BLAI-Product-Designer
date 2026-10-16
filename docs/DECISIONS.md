# First-pass decisions

Agreed with Johannes through 16 questions on 2026-10-17 (Europe/Stockholm).

1. A personal workspace; public signups and multiplayer are outside this first pass.
2. Styled, editable wireframes with realistic content, typography, and color.
3. Design responsive websites and native-style mobile apps.
4. Chat beside an editable product specification; AI edits are proposals.
5. Layout-aware editing with rows, columns, sections, and reusable components.
6. Review and accept AI changes before applying them; preserve manual edits.
7. Moodboards accept uploaded images and image/webpage references.
8. Hosting is Cloudflare. This supersedes the earlier local-app-first preference.
9. AI uses the user's Codex subscription on Linux through a dedicated adaptation of Codex Helper; no API-key dependency for text/design jobs.
10. Reference implementation: https://github.com/JoDavidsson/ai-writing-tool at 655415110c8b23e0b9b83f2ec5b19b9cd3c4c62f. Preserve its app, database, helper configuration, and service.
11. The designer itself uses a light studio aesthetic.
12. Handoff includes a downloadable package and GitHub export to a chosen repository.
13. Wireframe previews support clickable navigation and explicit loading/empty/error/success states.
14. Generate one coherent design draft, then refine selected screens.
15. Image generation must stay within the Codex subscription. Investigate actual support; if unavailable, deliver imported/uploaded references and written visual directions, and report the limitation honestly.
16. Upload implementation screenshots, annotate them with dotted connectors, and convert accepted feedback to requirements.

## Connected product model

The plan, wireframes, references, comments, accepted requirements, and handoff belong to one project. Stable element identifiers connect annotations to editable components. AI sees structured project context and returns validated data, never arbitrary executable UI code. Proposed changes carry the source revision and cannot silently overwrite subsequent edits.

## Scope and validation

Build and validate the end-to-end workflow locally with Cloudflare's Worker/D1/R2 runtime. Live subscription AI requires the user to run the designer helper on Linux; Cloudflare publication requires the new app's deployment and Access configuration. Simulated protocol fixtures are tests, not evidence of live AI generation.

The user authorized handling Git commits and pushes at coherent milestones. No additional product approval is required before implementation.
