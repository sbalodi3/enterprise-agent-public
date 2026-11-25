# Local claims demo deployment

English | [中文](README.zh.md)

## Single Podman application

Run `npm run app:up` from the repository root with Node 24, a running rootless Podman engine and the Docker Compose provider. The `enterprise-agent` project serves all three departments at [Open Enterprise Agent](http://127.0.0.1:3280/open-app). Entra Local uses port 8280. The synthetic Microsoft consent screen uses loopback port 8381. PostgreSQL, the workspace manager and department data services are private to the project.

| Sign in as | Chat loads | Example |
| --- | --- | --- |
| Maya Chen | Assigned claims, Claims tools and private workspace | Open WC-101 in Workbench |
| Sam Patel | Finance billing exceptions, invoice sources and reviewed Finance actions | Select FIN-207 and ask what explains the variance |
| Morgan Ellis | Legal matters, source chronology and reviewed Legal actions | Select MAT-017 and ask which dates conflict |

1. A fresh install includes a local synthetic wage partner. To exercise the signed A2A exchange, set `SHOWCASE_A2A_SOURCE` to the [matching source checkout](../showcase/partner/README.md). `SHOWCASE_PARTNER_MODE=fixture` explicitly selects the bundled fixture. Sign-in, Workbench and Outlook setup are available without a model. Configure a model to use Chat replies and model-assisted actions.
2. Start the project and sign in. **Ask agent** from a Finance or Legal Workbench record opens that record in the shared composer. Each department conversation lists only the employee’s records. Citations open versioned sources. Existing drawer answers are under **Saved Workbench answers** for the same employee and scope.
3. Choose **App connections** and connect the signed-in employee’s synthetic Outlook account. The existing grant is reused on subsequent sign-ins and Workbench restarts. Restarting the synthetic Microsoft provider generates new mailbox identities and requires fresh consent. For a tenant deployment, configure the existing delegated Microsoft settings in the project environment, including the employee-to-account map and token encryption key. The launcher uses those settings when a Microsoft client is configured.
4. `npm run app:up -- --stop` stops the project and retains application data. `npm run app:up` reuses available images. Use `--build` to rebuild or `--cms-mcp` to include the optional imported portfolio.

Run `node claims/shared-chat/departments.browser.mjs` for the three-login composer and authorization check. Add `--outlook` to exercise delegated consent and search against the local synthetic provider. Use test identities and a local model for this check, which saves answers.

### Use Azure OpenAI

Run `npm run app:up` once to create the private project settings file, `.artifacts/enterprise-agent/.env`. Add your Azure OpenAI resource endpoint, the name of a deployed model that supports Chat Completions and tool calls, and the API key. All three settings are required. Keep the key in that Git-ignored file or in your shell environment.

```dotenv
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
AZURE_OPENAI_API_KEY=your-key
```

Run `npm run app:up` again. Workbench uses this deployment for Claims, Finance and Legal Chat and Outlook-assisted Chat. Department access still follows the signed-in employee. The resource endpoint can also include `/openai/v1`. [Microsoft Foundry endpoint documentation](https://learn.microsoft.com/en-us/azure/ai-foundry/model-inference/concepts/endpoints)

### Use a local model

- To start the optional Ollama container, run `npm run app:up -- --ollama`. It starts with an empty model library on a fresh install. Choose a tool-capable model and run `podman exec enterprise-agent-ollama-1 ollama pull MODEL_NAME`. Set `CLAIMS_MODEL_ID=MODEL_NAME` in the project settings file and rerun the same launch command.
- To use llama.cpp, download the pinned GGUF described below and run `npm run app:up -- --model`.
- To use an existing OpenAI-compatible server, set `CLAIMS_MODEL_URL` and `CLAIMS_MODEL_ID` in the project settings file and run `npm run app:up`. Use an address reachable from Podman.

When switching away from a local container, run `npm run app:up -- --stop` first. It stops both optional local model services and retains the project data. Clear the Azure settings if you want to use a local provider.

Configure the separate widget origin, production ingress and optional wage-evidence pilot using the [widget deployment guide](widget-host.md).

Run commands from the repository root with Node 24. Allow at least 16 GiB of free container storage for a first build. [Compose](../../compose.claims.yml) pins upstream image digests. The application image builds the pnpm workspace and installs the claims and Temporal worker npm dependencies from frozen locks.

```sh
node claims/deploy/up.mjs
```

Docker is the default engine. To use Podman, install the Docker Compose CLI provider (2.24.4 or later for the showcase overlays) and check it with `podman compose version`. On macOS, start a Podman machine with amd64 emulation for the Entra Local image. On Linux with systemd, start the rootless API with `systemctl --user start podman.socket`. The launcher uses Podman for builds and the Compose provider for lifecycle commands. If multiple providers are installed, set `PODMAN_COMPOSE_PROVIDER` to the Compose CLI executable.

```sh
export CONTAINER_ENGINE=podman
node claims/deploy/up.mjs
```

The launcher keeps private credentials in `claims/deploy/.env`, starts the workbench at http://localhost:3080 and publishes the Entra Local account picker on loopback port 8080. Choose Maya Chen, Alex Rivera or Jordan Lee. PostgreSQL stays on the private Compose network. Each engine has its own image and volume store. If switching engines on the same host, release the existing stack's loopback ports before launching the other stack.

Choose optional profiles explicitly:

```sh
node claims/deploy/up.mjs --story --observe
node claims/deploy/up.mjs --story --observe --model
```

| Profile | Adds | Local interface | Persistent state |
| --- | --- | --- | --- |
| Default | Workbench with shared Chat, workspace manager, bookmark redirects, PostgreSQL, Entra Local | Application 3080, old bookmarks 3083–3085, Entra Local 8080 | Directory, Postgres, native history and private workspace volumes |
| `story` | Temporal dev server and `dsh claims-worker` | Temporal UI 8233; gRPC 7233 | SQLite history in a named Temporal volume; separate worker home |
| `observe` | OpenTelemetry Collector 0.165.0 and Jaeger | Jaeger 16686; Collector OTLP HTTP 4318 | Ephemeral local traces |
| `model` | llama.cpp serving a local GGUF | Compose port 8080 and workstation loopback port 3082 | Read-only model directory |

Published ports bind to `127.0.0.1`. The workbench binds its concrete container interface because the harness rejects wildcard listeners. Workbench serves every hosted Chat account. The worker uses its own dsh profile. The worker profile has no web UI. External harness telemetry is disabled; local OTLP is enabled only with `--observe`. The Collector exports named operations from the `claims-workbench` service. A `claims.routing.decision` span can carry the intent, scope-model release, confidence band, routing action, and number of additions. The Collector validates each name and value and accepts counts from 0 to 1536. An Undo span links to the decision by opaque IDs. Other spans carry no application attributes. The Collector removes events, status messages, trace state, and scope and resource attributes apart from the service name. Jaeger receives from the Collector internally; its ingestion port is not published. Verify the configured minimization with `node claims/deploy/check-observe.mjs`, which sends synthetic canaries and reads the resulting Jaeger trace.

The launcher records the current Git revision at build time. The built source can include local uncommitted changes. Use `--build-only` to build the baseline images without starting services. Use `--no-build` when the local image contains the intended source. If optional services were started previously, stop them explicitly when changing profiles.

`Dockerfile.refresh` updates a verified harness image when container storage is limited. Tag the verified image `claims-workbench:verified-harness` and check that its harness source matches the checkout. It copies current claims sources and selected client sources. Use the full build for other harness changes.

```sh
docker build -f claims/deploy/Dockerfile.refresh -t claims-workbench:local .
podman build --pull=never --layers=false --disable-compression=false --ignorefile claims/deploy/Dockerfile.refresh.dockerignore -f claims/deploy/Dockerfile.refresh -t claims-workbench:local .
```

For `--model`, place the reference GGUF in `claims/deploy/models/Qwen3-4B-Q4_K_M.gguf`, or set `CLAIMS_MODELS_DIR` / `CLAIMS_MODEL_FILE` in the private env file to another compatible, properly licensed model. To download the reference explicitly, run `node claims/deploy/download-model.mjs`. Startup never downloads weights and weights are not baked into the image. The default API is `http://llama:8080/v1` with model alias `claims-local`; llama.cpp uses its Jinja tool template and disables hidden thinking by default so bounded turns can return tool calls and visible answers. After the server loads:

```sh
"${CONTAINER_ENGINE:-docker}" compose --env-file claims/deploy/.env -f compose.claims.yml exec -T workbench node claims/deploy/check-model.mjs
```

This smoke checks a structured `lookup_claim` call with `WC-102`, supplies a synthetic result, and checks the model answers. It does not establish claims reasoning quality, evidence grounding, repeated tool-call reliability, or the harness authorization boundary.

The reference is the official [Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF/tree/bc640142c66e1fdd12af0bd68f40445458f3869b) `Qwen3-4B-Q4_K_M.gguf`, a single 2,497,280,256-byte file, Apache-2.0, revision `bc640142c66e1fdd12af0bd68f40445458f3869b`, SHA256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`. The downloader verifies that digest and refuses to replace a different existing artifact. It is a local demonstration model, not a validated claims model.

## Optional web search for Standard Chat

Start the [SearXNG search stack](searxng/compose.yml) with the same engine as Chat. DuckDuckGo needs no search API key. Only the search service has an egress network. Chat reaches the MCP bridge on the private tools network at `http://searxng-mcp:8000/mcp`.

```sh
export SEARXNG_SECRET="$(openssl rand -hex 32)"
"${CONTAINER_ENGINE:-docker}" compose -f claims/deploy/searxng/compose.yml up -d
export CLAIMS_SEARCH_NETWORK=enterprise-agent-search-tools
```

Pass the tools network to the shared launcher when starting Workbench. The migration imports each employee’s MCP configuration and restricts tool discovery and calls to that owner. The network name and bridge URL must match the original deployment. Use a model configured for tool calling. Resumed conversations retain their original model history. New turns use the current local model with any matching token limits from the employee’s original profile.

## Workflow ownership and recovery

The authenticated work API owns admission, claim access, current assignment, evidence validation, human approval, operation state, and the unique synthetic destination receipt. Temporal owns durable waiting, bounded timers, and activity retries. Workflow arguments contain opaque identifiers; evidence stays in the domain store. The worker cannot approve work. No live partner systems are contacted.

The gateway commits wage admission/evidence/review plus a domain outbox row. The worker polls `GET /api/internal/work/wage/pending`, starts `claims-wage-<requestId>` idempotently, delivers the corresponding signal, then acknowledges `POST /api/internal/work/wage/delivered`. A crash between delivery and ACK redelivers. Stable workflow IDs and duplicate event handling make that safe. Closed workflows are acknowledged without restarting them. Generic reviewed operations come from `GET /api/internal/work/dispatchable`; wage-linked operations are excluded from that list.

`wageEvidenceRequest` waits for a committed synthetic partner artifact (default three days), validates through the work API, then waits for a human decision (default seven days). Transfers can invalidate admission and wake waiting work. Reviewed execution uses the operation ID as its stable identity. An unknown acknowledgement waits for an explicit reconciliation signal (default one day); it never retries a destination write just to discover whether the first succeeded. Expired reconciliation leaves the domain operation unknown and requiring follow-up. A later authorized reconciliation request can still read the existing receipt when the workflow has closed.

The service API token is sent only on the private worker-to-workbench path. Runtime supports `WORKER_API_TOKEN_FILE` or `WORKER_API_TOKEN`; this local Compose supplies an env value from the private generated file. Recorded fixture ingress uses a separately generated `CLAIMS_FIXTURE_TOKEN`; rerunning `init-env.mjs` appends this key when missing and preserves existing settings. For production, use managed secrets, authenticated/TLS service identities, and an operationally owned Temporal cluster. The persisted SQLite dev server is a local recovery demonstration, not HA. There is no Kubernetes or cloud infrastructure in this package.

```sh
npm --prefix claims/worker ci --workspaces=false --ignore-scripts
npm --prefix claims/worker test
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix claims/worker run test:integration
TEMPORAL_ADDRESS=127.0.0.1:7233 CLAIMS_TEST_RESTART_SERVER=1 npm --prefix claims/worker run test:integration
```

The integration test uses the real Temporal service and an authenticated synthetic API fixture. It proves worker/server restart recovery, duplicate signal handling, no effect before human review, unknown-result recovery with one effect, and bounded timeout. Domain/API/OIDC correctness has separate tests under `claims/`; this fixture alone does not prove them.

To check a real demo workflow currently waiting for partner, review, or reconciliation:

```sh
node claims/deploy/check-restart.mjs claims-wage-REQUEST_ID
```

That check restarts the demo Temporal/worker services, reconnects, and verifies the same waiting phase without submitting a signal or business write. Database, history, and harness volumes survive normal restart and `down`; do not use `down -v` unless intentionally resetting all demo state. Regenerating credentials while retaining a previously initialized database does not rotate its stored credentials.

## Shared Chat

The baseline and showcase each run their own Workbench and PostgreSQL. Each deployment has a separate Entra directory and workspace manager.

| Container | Responsibility |
| --- | --- |
| `workbench` | Serves sign-in callbacks, Workbench, shared `/chat`, native history, Claims Chat, widgets and Outlook operations. |
| `entra` | Provides the local Entra-compatible directory, account picker and identity tokens. |
| `postgres` | Stores claim permissions, protected conversations, mailbox links and deployment-scoped ownership of native Chat data. |
| `workspace-manager` | Accepts private Unix-socket requests from Workbench and manages employee sandboxes through the engine. |
| Employee workspace | Starts on a file, terminal, or executable tool request. Mounts one persistent employee volume. Stops after 15 idle minutes. |
| `chat-bookmarks` | One temporary redirect listener for the previous employee ports. New employees share the Workbench address. |
| `llama` | Optional local inference server. An existing OpenAI-compatible local model endpoint can also serve both modes. |
| `temporal` | Stores claims workflow history, timers, and retry state for the story profile. |
| `worker` | Executes the activities scheduled by Temporal, including approved claims workflows. |
| `collector` | Receives local telemetry and filters it before export when observation is enabled. |
| `jaeger` | Stores and displays the filtered traces. |
| `kong` | Provides the connected showcase’s public application entry point. |
| `juris` | Serves the showcase’s synthetic claims system of record. |
| `legal-agent` | Handles the showcase’s cross-department Legal handoffs. |
| `voice` | Delivers simulated calls to the showcase intake workflow. |
| `partner-adapter` | Connects the showcase’s wage-evidence workflow to the simulated partner. |
| `amazon-mock` | Simulates partner requests and callbacks in the local showcase. |
| `scope-router` | Optional classifier for routing claims questions to an authorized scope. |
| `searxng` | Optional local web search engine. |
| `searxng-mcp` | Exposes the search engine to employees who have that MCP connection. An existing deployment can use a different service name. |
| Local Microsoft emulator | Supplies synthetic Outlook mailboxes and consent when enabled. Mailbox grants are employee-owned. |

New installations default to shared Chat. Run `node claims/deploy/up.mjs` or add `--showcase --cms-mcp`. Use `CONTAINER_ENGINE=podman` for rootless Podman. Open `/open-companion` to use the optional Mac workspace. Personal files live on named volumes. Native history and attachments live in Workbench storage, with ownership checked against PostgreSQL.

For an existing installation, keep the original volumes, environment, image references and Compose configuration. Run these commands for one project at a time, using `claims-demo` first and `enterprise-agent-showcase` second.

1. Run `node claims/deploy/inventory-chat.mjs --project PROJECT --output .artifacts/shared-chat-inventory`. Resolve every reported owner or path issue. Use its printed directory as `INVENTORY`.
2. Run `node claims/deploy/snapshot-chat.mjs INVENTORY`. Set `CLAIMS_TEST_DATABASE_URL` to a disposable PostgreSQL database and run `node claims/deploy/rehearse-chat.mjs INVENTORY`. Preserve the reports and a database backup privately.
3. During the pause, drain active native, Claims and mail turns. Stop the project's Workbench, legacy Chat writers and authority. Run `node claims/deploy/stage-chat.mjs import INVENTORY`. The helper verifies current inputs, preserves the old Workbench home on a separate volume and prints the staged manifest. Set `CLAIMS_SHARED_CHAT_IMAGE` to your built candidate image.
4. Set `CLAIMS_SHARED_CHAT_VOLUME` to the `shared` field in `staged.json`. On installations with private search, set `CLAIMS_SEARCH_NETWORK` to its existing engine network. Start the shared topology with the existing model, integrations and profiles. Reopen an imported conversation, check attachment bytes and verify two accounts before running `node claims/deploy/activate-chat.mjs INVENTORY`.
5. To roll back, finish active work, stop Workbench, the manager, bookmark listener and employee sandboxes, then run `node claims/deploy/stage-chat.mjs rollback INVENTORY`. Use the generated `rollback.compose.json` as the last overlay on the previous Compose configuration. With the current Compose definitions, enable `--profile legacy-employee-chat`. For CMS, include the original generated CMS Chat overlay and `--profile cms-chat`. It selects fresh restored volumes containing both the original and subsequent work. Archive the deployment’s `shared-chat.active.json` (Docker) or `shared-chat.podman.active.json` marker before restarting the old services; retain all shared data and the current PostgreSQL database.
