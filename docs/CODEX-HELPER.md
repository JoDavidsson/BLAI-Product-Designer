# BLAI Helper: connect Designer on Linux

The manager runs one Linux user service, `blai-helper.service`, with a separate adapter and private settings for each tool. Writer and Designer reuse your existing ChatGPT Codex sign-in. Their queues, access credentials, and work directories stay separate. Keep the computer awake and online for AI requests from any device; normal subscription limits apply.

## Designer model and context

Designer runs **GPT-6 Astra at Medium reasoning** through the existing **ChatGPT Codex subscription**. The Designer adapter explicitly sets `--model gpt-6-astra`, `model_reasoning_effort="medium"`, and `model_context_window=872000` for each request. It uses the local ChatGPT sign-in and its subscription allowance.

The 872,000-token context is the current published maximum for `gpt-6-astra` in [OpenAI's Codex model catalog](https://github.com/openai/codex/blob/d28be12577cf5e267c97d3018a490d76da4d28e7/codex-rs/models-manager/models.json#L34). The catalog's default context is 272,000 tokens; this adapter explicitly selects the larger supported window. The app's bounded project snapshot, request validation, and structured-output limits are enforced separately; configuring the model context does not expand those application limits.

Install **BLAI Helper 1.1.0** on the Linux computer running your helper to apply these Designer settings. The model settings take effect after the local installation succeeds.

## Before installing

Use Linux with a systemd user session, Node.js **22.13 or later**, npm, and an up-to-date official [Codex CLI](https://github.com/openai/codex). On the computer that will run the helper:

```sh
node --version
codex login status
```

If Codex is missing or needs updating, run `npm install -g @openai/codex`. If it is not signed in with ChatGPT, run `codex login` and choose ChatGPT. The manager checks the login and the CLI features required by the configured tools; it does not sign in for you or copy your Codex login to Cloudflare.

## Update your installed helper

If your installed helper includes the built-in updater, run one command from any directory on the Linux computer running it:

```sh
"$HOME/.local/bin/blai-helper" update
```

The helper checks your saved app connections for the newest available release, downloads it, installs dependencies, and reconnects all enabled tools. Your profiles and ChatGPT sign-in are preserved. It updates the permanent installation at `~/.local/share/blai-helper/app`, automatically cleans up temporary update files, and restores the previous installation if the update fails. It never downgrades to an older hosted archive.

To check without installing, or to use a release archive you already have:

```sh
"$HOME/.local/bin/blai-helper" update --check
"$HOME/.local/bin/blai-helper" update --file "$HOME/Downloads/blai-helper.tar.gz"
```

Use the actual downloaded filename with `--file`.

### One-time upgrade for older helpers

Older helpers need one manual installation of a release containing the updater. The currently hosted 1.1.0 download does not include this command. Obtain a newer package when published, or build one from [BLAI/helper](https://github.com/JoDavidsson/BLAI/tree/main/helper). Follow that package's installation instructions using `install` with your existing profiles; no settings download or `add` command is needed. After it installs successfully, future updates use the single command above and the old extraction folders can be removed.

## First installation with the legacy 1.1.0 download

1. Open **Connect Codex** in Designer on your Linux computer.
2. Download **BLAI Helper** and **Designer settings** into Downloads. They should be named `blai-helper-1.1.0.tar.gz` and `blai-designer-helper.json`.
3. Stop any older helper running in a terminal with **Ctrl+C**. The installer handles known background services during migration.
4. Open a terminal and run these commands in order. Stop if any command reports an error.

```sh
blai_helper_dir="$(mktemp -d "$HOME/blai-helper.XXXXXX")"
tar -xzf "$HOME/Downloads/blai-helper-1.1.0.tar.gz" -C "$blai_helper_dir"
cd "$blai_helper_dir/blai-helper"
npm ci --omit=dev
node bin/blai-helper.mjs add designer --adapter designer --settings "$HOME/Downloads/blai-designer-helper.json"
```

### Include an existing Writer helper

To manage both tools together, import Writer before installing. Download **Writer settings** from the writing app's **Connect Codex** page, then run this from the same directory:

```sh
node bin/blai-helper.mjs add writer --adapter writer --settings "$HOME/Downloads/blai-codex-config.json"
```

You can use the full path to your existing `.codex-bridge/config.json` instead of the downloaded file. Importing copies it into the manager's private profile and preserves the original file. Writer and Designer share the Codex account, while keeping their own site credentials and job queues.

### Install and check

```sh
node bin/blai-helper.mjs doctor
node bin/blai-helper.mjs install --migrate
"$HOME/.local/bin/blai-helper" status
```

This legacy 1.1.0 release runs from its extracted directory. Keep that directory and its dependencies until you install a release with the built-in updater.

The installer validates the configured tools before changing services. It can migrate `writing-partner-codex.service` and `blai-designer-codex.service` for tools you have imported. A legacy service whose tool has not been imported stays in place. Existing configuration files are preserved. If the new service fails its connection check, the installer attempts to restore the previous services and reports the failure.

Designer should show connected in the terminal and app. Try a request in the Design assistant: a reply verifies a complete Codex job, while a connected indicator confirms contact with the queue. Once installation succeeds, you can close the terminal. The service starts at Linux sign-in; keeping it running after logout depends on your Linux system's user-service/lingering settings. It cannot run while the computer sleeps or is switched off.

## Add Designer to an installed manager

Download **Designer settings** from **Connect Codex**, then run:

```sh
"$HOME/.local/bin/blai-helper" add designer --adapter designer --settings "$HOME/Downloads/blai-designer-helper.json"
"$HOME/.local/bin/blai-helper" doctor
"$HOME/.local/bin/blai-helper" install --migrate
"$HOME/.local/bin/blai-helper" status
```

Existing configured tools are retained. Identical settings can be imported again; differing settings require an explicit change rather than silent replacement. Each tool has a private profile under `~/.config/blai-helper/profiles/<tool>/config.json`. You can delete downloaded settings copies after successful import. Never share those files in chat or commit them to Git.

## Manage the service

```sh
"$HOME/.local/bin/blai-helper" status
"$HOME/.local/bin/blai-helper" doctor
systemctl --user status blai-helper.service
journalctl --user -u blai-helper.service --follow
```

Restart with `systemctl --user restart blai-helper.service`; stop with `systemctl --user stop blai-helper.service`. These affect all tools managed by the service. The manager isolates adapters so a failed tool can restart without interrupting healthy tools. No inbound Linux port, VPN, or public Linux server is required.

The manager's source, update instructions, and adapter contract live in [BLAI/helper](https://github.com/JoDavidsson/BLAI/tree/main/helper). Future tools can add an adapter while reusing the same service and local account.

## Deployment and developer setup

The private settings download at `/api/helper/setup` requires the signed-in owner. The Worker must have `DESIGNER_OWNER_EMAIL`, `DESIGNER_BRIDGE_SECRET`, `DESIGNER_ACCESS_CLIENT_ID`, and `DESIGNER_ACCESS_CLIENT_SECRET` configured as described in the repository README. Use a Designer-specific Cloudflare Access service token and Service Auth policy. Keep browser access restricted to the allowed Google identity. Do not reuse Writer's bridge secret or put credentials in browser code.

The shared archive contains source and locked dependency manifests only, with no account files or service credentials. Keep current `BLAI`, `ai-writing-tool`, and `BLAI-product-designer` checkouts beside each other, then use `npm run build:release`. This builds the app and puts `blai-helper.tar.gz` in `dist/client/`. `npm run deploy` uses this release build automatically. Each application can serve a packaged manager release. The hosted Designer download currently serves version 1.1.0. Publish a package with the built-in updater before directing older installations to upgrade to that feature. A plain `npm run build` removes generated archives, so use `build:release` for the final production build.

The standalone adapter is still available for development:

```sh
node bridge/configure-linux.mjs --settings /absolute/path/to/designer-settings.json
npm run helper
```

This uses the checkout's `.blai-designer/config.json` rather than a shared-manager profile. Do not run it alongside the managed Designer adapter for the same site. The configuration must use a full HTTPS origin; loopback HTTP is allowed for local development. `codexPath` is optional when Codex is on `PATH`. The adapter requires `exec --ignore-user-config`, `--ignore-rules`, `--ephemeral`, and `--output-schema` (inspected CLI: `0.159.2`). It verifies ChatGPT authentication before configuring. A configuration symlink or differing existing settings is rejected.

## Protocol version 1

Every request is `POST /api/codex`, JSON, with `x-designer-bridge-key` and the `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. Redirects are rejected. Bodies always include `action`, `protocolVersion: 1`, and a process-specific `workerId`.

- `claim`: send `capabilities` containing supported job kinds. The server replies `{protocolVersion:1,job:null}` when idle or a job `{id,projectId,kind,baseRevision,instruction,screenId?,context,leaseToken,leaseExpiresAt}`. `context` is the bounded project snapshot. Poll every 5 seconds while idle.
- `heartbeat`: send `jobId` and `leaseToken` every 10 seconds. The response is `{ok:true,cancelled:boolean,leaseExpiresAt?}`. Leases last 45 seconds. Cancellation, rejected ownership, or two missed heartbeats stop the local process.
- `complete`: send `jobId`, `leaseToken`, and exactly one of `result` or `error`. The response is `{ok:true}`. Any pending heartbeat finishes before the final ownership check; a transient failure of that check is retried once. Transient completion failures are retried at most twice. Completion is idempotent for the original owner/lease. Stale ownership cannot publish a proposal.

Stopping the helper interrupts active HTTP requests and prevents new completion attempts, including during final ownership checks and retry delays. Cancellation terminates the Codex process group; a process that ignores `SIGTERM` receives `SIGKILL` after two seconds.

Supported jobs are `plan.assist`, `plan.review`, `wireframe.generate`, `wireframe.refine`, and `moodboard.direction`. The runner times out after 9 minutes, under the server's 10-minute job lifetime. Failed jobs return only bounded categories (`login`, `limit`, `timeout`, `invalid`, or `unavailable`). Product text, CLI transcripts, stderr, and credentials are not logged.

## Data and process boundaries

Jobs run in a fresh private temporary directory using the existing authentication, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, and a read-only sandbox. Shell execution, plugins, hooks, MCP apps, web search, browser/computer access, image tools, and additional agents are disabled. A strict allowlist permits only reasoning, final text, and plan items in CLI JSONL output. A tool event or unknown item fails the job.

The JSON output schema is in `bridge/schema.mjs`. It permits only supported structured components, bounded strings/arrays/nesting, safe colors, known layout values, and valid screen links. Optional generated values are represented as null and normalized to omitted properties. Refinements must return exactly the selected screen. Both helper and Worker validate the result; the browser receives a proposal tied to the source revision and explicitly accepts it before changing the project.

The complete project snapshot supplies the plan, platform, design tokens, accepted requirements, comments, existing screens, and written image notes. The prompt distinguishes accepted decisions from unresolved suggestions, asks for essential journey states, and preserves existing identifiers where concepts remain. Generation returns the full replacement screen set; refinement returns only the selected screen. The helper rejects identifiers that collide with retained assets, discussions, requirements, or untouched screens and components. Streaming output preserves multibyte text, including Swedish characters and emoji.

The helper does not pass site credentials, application secrets, or API keys to the Codex subprocess. It preserves standard proxy/CA environment variables so TLS verification continues to work on managed networks. Temporary schema and job directories are removed after execution. `--ephemeral` avoids persistent conversation sessions, but the normal Codex CLI may maintain its own account/runtime metadata outside the job directory.

## Subscription image generation: investigation and current limitation

The installed Codex CLI `0.159.2` reports the native `image_generation` feature as stable and enabled. Official OpenAI source at [`859bbc87fc80c18a72e08b181e301ddb4f8dabea`](https://github.com/openai/codex/tree/859bbc87fc80c18a72e08b181e301ddb4f8dabea) provides:

- [Capability gates](https://github.com/openai/codex/blob/859bbc87fc80c18a72e08b181e301ddb4f8dabea/codex-rs/core/src/tools/spec_plan.rs): non-Free plan, an image-capable model/provider, and Codex backend authentication.
- [Native image extension](https://github.com/openai/codex/blob/859bbc87fc80c18a72e08b181e301ddb4f8dabea/codex-rs/ext/image-generation/src/extension.rs) and [authenticated image backend](https://github.com/openai/codex/blob/859bbc87fc80c18a72e08b181e301ddb4f8dabea/codex-rs/ext/image-generation/src/backend.rs): generation through the active Codex provider/account.
- [Artifact format](https://github.com/openai/codex/blob/859bbc87fc80c18a72e08b181e301ddb4f8dabea/codex-rs/ext/image-generation/src/artifact.rs): `generated_images/<session-id>/<call-id>.png` under the extension's save root.
- [`codex exec` event definitions](https://github.com/openai/codex/blob/859bbc87fc80c18a72e08b181e301ddb4f8dabea/codex-rs/exec/src/exec_events.rs): no typed image-generation result in the current JSONL item contract.

A bounded live probe in the build environment could not start the in-process CLI app server because its managed runtime is read-only, even after directing SQLite and logs to a writable temporary directory. No image was generated, and the native artifact route has not been validated end to end with this application.

Therefore **this first helper advertises `imageGeneration: false`** and exposes uploaded/imported references and written visual directions. It does not infer lack of subscription support from that integration limitation, substitute another paid API, invent an image, or present a test fixture as live generation. Enabling native generation requires a verified Linux CLI/app-server artifact path, owner-scoped upload to R2, strict file/MIME/size checks, and runtime capability advertisement. Until then, the model receives image notes and metadata, not image pixels, and is instructed to avoid claims of visual inspection.

## Validation and troubleshooting

```bash
npm run test:helper
```

The helper tests use the built-in Node test runner and no account/network calls. They cover strict schema normalization, bounds and links, retained identifier collisions, Unicode streaming, forbidden tools, subprocess cancellation and timeout, dedicated headers and versioned protocol, shutdown races, lease loss, completion retries, private configuration, noninteractive setup, and service separation. Cancellation escalation is also checked against a real local subprocess that ignores `SIGTERM`. Passing these tests establishes protocol behavior; it is not proof of a live subscription job.

If Connect Codex shows offline, run `~/.local/bin/blai-helper status` and `doctor`, check that `blai-helper.service` is running, and verify the exact Designer origin and its private Access/bridge settings. HTML sign-in pages, redirects, wrong protocol versions, and HTTP authentication failures are rejected. Confirm `DESIGNER_OWNER_EMAIL` matches the authenticated project owner. A `login` failure requires restoring the local ChatGPT Codex sign-in; `limit` means subscription usage/rate limits; `timeout` means the bounded run exceeded its time; `invalid` means output or a tool call failed validation. These failures never silently apply a partial design.
