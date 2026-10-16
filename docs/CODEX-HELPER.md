# BLAI Designer Codex Helper

The designer uses your existing ChatGPT Codex subscription through a small Node.js process on your Linux computer. It polls the designer's Cloudflare Worker over HTTPS, runs one bounded Codex job, and returns an editable proposal. There is no OpenAI API-key dependency or paid API fallback. Normal subscription usage limits still apply.

This is a separate adaptation of the [AI writing tool](https://github.com/JoDavidsson/ai-writing-tool) helper at commit `655415110c8b23e0b9b83f2ec5b19b9cd3c4c62f`. It uses a separate service (`blai-designer-codex.service`), private configuration (`.blai-designer/config.json`), bridge secret, Cloudflare Access service token, queue, and work directory. It never changes the writer's app, database, `.codex-bridge` configuration, or `writing-partner-codex.service`. The existing Codex account sign-in is reused.

## Before connecting

1. Use Node.js 22 or newer and an up-to-date official [Codex CLI](https://github.com/openai/codex). Run `codex login` and sign in with ChatGPT. `codex login status` must report ChatGPT authentication. This helper requires `exec --ignore-user-config`, `--ignore-rules`, `--ephemeral`, and `--output-schema` (inspected CLI: `0.159.2`).
2. Deploy the designer Worker and configure the authentication and resources described in the repository README. Set `DESIGNER_OWNER_EMAIL` to your allowed Cloudflare Access identity.
3. Configure a **designer-specific** Cloudflare Access service token and a Service Auth policy allowing it on `/api/codex`. Keep the browser app protected by your normal identity policy. Use the token only for this helper.
4. Generate a new random bridge secret with at least 32 characters; store it as the Worker's `DESIGNER_BRIDGE_SECRET` and in the local helper settings. Never reuse the writer bridge secret or send credentials in chat. Do not put the helper secret or Access service token in browser code.

No inbound Linux port, VPN, or public Linux server is required: all helper requests are outbound. The app shows the helper online only after a successful compatible claim/heartbeat.

## Configure without prompts

Create a private JSON file on your Linux machine (for example `~/designer-helper-settings.json`, mode `600`):

```json
{
  "site": "https://your-designer.example.com",
  "bridgeSecret": "YOUR_NEW_DESIGNER_BRIDGE_SECRET",
  "accessClientId": "YOUR_DESIGNER_ACCESS_CLIENT_ID",
  "accessClientSecret": "YOUR_DESIGNER_ACCESS_CLIENT_SECRET",
  "codexPath": "/absolute/path/to/codex"
}
```

Use the real secret through a secure local editor or secret manager. The example values are placeholders. `codexPath` is optional when `codex` is on `PATH`. HTTP origins are permitted only for `localhost`, `127.0.0.1`, or `[::1]` local development; service tokens are optional only there. A production origin must be HTTPS with no path, query, or embedded credentials.

From the designer checkout:

```bash
node bridge/configure-linux.mjs --settings ~/designer-helper-settings.json
npm run helper
```

The configure command checks the existing subscription login and required CLI switches, then writes a private configuration file. It refuses to overwrite differing settings, follow a configuration symlink, or change the permissions of a shared parent directory. Delete your downloaded source settings securely after configuration if you no longer need that copy.

For a configuration outside the checkout, choose a dedicated private directory:

```bash
mkdir -m 700 -p ~/.config/blai-designer
node bridge/configure-linux.mjs \
  --settings ~/designer-helper-settings.json \
  --config ~/.config/blai-designer/config.json \
  --codex-path /absolute/path/to/codex
node bridge/start.mjs ~/.config/blai-designer/config.json
```

## Optional Linux user service

Install only after the foreground helper successfully connects:

```bash
node bridge/configure-linux.mjs \
  --settings ~/designer-helper-settings.json \
  --install-service
systemctl --user status blai-designer-codex.service
journalctl --user -u blai-designer-codex.service --follow
```

For a custom configuration, include the same `--config` argument or run `node bridge/install-service.mjs /absolute/path/to/config.json`. The service uses the Node executable and `PATH` active during installation. It starts at user login, uses `UMask=0077`, and restarts on failure. A different existing designer service is preserved and requires an explicit backup before replacement. Keeping the helper running after logout requires the machine's usual systemd lingering configuration.

Stop with `systemctl --user stop blai-designer-codex.service`. Uninstall with `systemctl --user disable --now blai-designer-codex.service`, remove only `~/.config/systemd/user/blai-designer-codex.service`, then run `systemctl --user daemon-reload`. Preserve the writer service.

The helper prevents two processes from using the same configuration with `helper.lock`. After an unclean machine/process shutdown, stop the designer service and verify that the recorded PID is no longer running before removing the stale lock beside its configuration. Restart the service afterward.

## Protocol version 1

Every request is `POST /api/codex`, JSON, with `x-designer-bridge-key` and the `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. Redirects are rejected. Bodies always include `action`, `protocolVersion: 1`, and a process-specific `workerId`.

- `claim`: send `capabilities` containing supported job kinds. The server replies `{protocolVersion:1,job:null}` when idle or a job `{id,projectId,kind,baseRevision,instruction,screenId?,context,leaseToken,leaseExpiresAt}`. `context` is the bounded project snapshot. Poll every 5 seconds while idle.
- `heartbeat`: send `jobId` and `leaseToken` every 10 seconds. The response is `{ok:true,cancelled:boolean,leaseExpiresAt?}`. Leases last 45 seconds. Cancellation, rejected ownership, or two missed heartbeats stop the local process.
- `complete`: send `jobId`, `leaseToken`, and exactly one of `result` or `error`. The response is `{ok:true}`. A final heartbeat confirms ownership before completion; transient completion failures are retried at most twice. Completion is idempotent for the original owner/lease. Stale ownership cannot publish a proposal.

Supported jobs are `plan.assist`, `plan.review`, `wireframe.generate`, `wireframe.refine`, and `moodboard.direction`. The runner times out after 9 minutes, under the server's 10-minute job lifetime. Failed jobs return only bounded categories (`login`, `limit`, `timeout`, `invalid`, or `unavailable`). Product text, CLI transcripts, stderr, and credentials are not logged.

## Data and process boundaries

Jobs run in a fresh private temporary directory using the existing authentication, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, and a read-only sandbox. Shell execution, plugins, hooks, MCP apps, web search, browser/computer access, image tools, and additional agents are disabled. A strict allowlist permits only reasoning, final text, and plan items in CLI JSONL output. A tool event or unknown item fails the job.

The JSON output schema is in `bridge/schema.mjs`. It permits only supported structured components, bounded strings/arrays/nesting, safe colors, known layout values, and valid screen links. Optional generated values are represented as null and normalized to omitted properties. Refinements must return exactly the selected screen. Both helper and Worker validate the result; the browser receives a proposal tied to the source revision and explicitly accepts it before changing the project.

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

The helper tests use the built-in Node test runner and no account/network calls. They cover strict schema normalization, bounds and links, forbidden tools, subprocess cancellation and timeout, dedicated headers and versioned protocol, lease loss, completion retries, private configuration, noninteractive setup, and service separation. Passing fixture tests establishes protocol behavior; it is not proof of a live subscription job.

If Settings shows offline, confirm the foreground helper is running, check the exact designer origin, and verify its Access service token and bridge secret. HTML sign-in pages, redirects, wrong protocol versions, and HTTP authentication failures are rejected. Confirm `DESIGNER_OWNER_EMAIL` matches the authenticated project owner. A `login` failure requires restoring the local ChatGPT Codex sign-in; `limit` means subscription usage/rate limits; `timeout` means the bounded run exceeded its time; `invalid` means output or a tool call failed validation. These failures never silently apply a partial design.
