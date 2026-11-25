# Claims workbench

English | [中文](README.zh.md)

Sign in with Entra Local to open Agent Chat. Chat opens the standard harness agent and a personal workspace. Workbench opens the adjuster’s authorized claims, intake, inbox and reviews. The claim assistant under **Overview** works with one selected record.

For the presenter walkthrough with a synthetic JURIS, partner wage exchange, recorded intake call and interactive claim timeline, see the [connected claims showcase](showcase/README.md).

## Start the demonstration

Run from the repository root with Node 24 and the engine described in the [local deployment guide](deploy/README.md). The default stack builds the Linux harness image, creates private local credentials, provisions the synthetic Entra directory, and starts the workbench with replay available.

```sh
node claims/deploy/up.mjs
```

Open [the application](http://localhost:3080) and sign in. Choose Maya Chen or Alex Rivera for an adjuster, or Jordan Lee for the supervisor portfolio. Use separate browser profiles to keep the two identities signed in simultaneously.

For the complete demonstration, download the pinned Qwen3-4B Q4_K_M weights once and start the optional services. The downloader verifies the SHA-256. The local model endpoint is configurable through `CLAIMS_MODEL_URL` and `CLAIMS_MODEL_ID`.

```sh
node claims/deploy/download-model.mjs
node claims/deploy/up.mjs --story --observe --model
```

The containers preserve PostgreSQL, Temporal history and native harness sessions on named volumes. Restarting the web host ends its browser login sessions. Deployment details, image pins, volume behavior and operating commands are in the [local deployment guide](deploy/README.md).

## Use desktop chat and local folders

The connected showcase also offers a live claims conversation in a Workbench drawer and in hosted Chat. Both surfaces use the same protected transcript and read-only tools. Follow the [WC-103 conversation walkthrough](showcase/README.md#use-the-claims-agent-from-either-page) for local startup, employee selection, and source inspection.

Employees sign in to the same Workbench URL and open `/chat`. Each employee has private history and a persistent files volume. Workspace tools start a private sandbox on demand. Ask *What are my open auto claims?* to search your assigned open personal and commercial auto claims. Ask *How many of those?* for the full matching count, including later pages. *List all open auto claims* searches the cases you can access across assignments. You can also ask for personal auto, commercial auto, cases due today, or waiting cases. Select a case in the card to open its Workbench overview. Refresh Workbench to update the card in the same chat. Start the model-enabled stack above for live replies. Select **Workbench** in the Chat sidebar to review claims in the same window. **Return to chat** in the sidebar resumes the active session with its draft, attachments and running response. Use **Ask agent** to open the Workbench assistant for the selected claim or your portfolio. Choose **Open in Chat** to continue that conversation in Chat. Reopening Workbench restores the last accessible record and tab. Sign-out ends access to both modes and closes the browser’s active chat connection.

Ask *Do I have any open action items?* to see your actionable Workbench assignments and outstanding inbox questions or obligations. Requests with no recorded completion appear separately from the confirmed count. Ask *Show my unread notifications* for your Workbench Inbox, or *Show unread email in my Outlook inbox* for connected Outlook Mail. Listing unread messages preserves their read status. If you ask only for your inbox and both sources are available, choose one in the chat.

To work with a folder on your Mac, run the optional local companion. Build the repository once with `pnpm install --frozen-lockfile` and `pnpm run build` using the versions in the root package manifest. In a host terminal run:

```sh
CLAIMS_DESKTOP_USER=maya node claims/runtime/launch.mjs --desktop-chat
```

Leave the companion running and open `/open-companion` on Workbench as Maya to use local Agent Chat. To attach a claim directly, click **Choose scope** beside **Workspace Write**, select the whole claim or specific documents, then click **Apply scope**. A pinned selection supplies the relevant claim information to the agent for that conversation. You can also name a claim in your question. Chat shows the matched claim as **Current** and uses it for follow-ups. A portfolio search keeps your pins in place. Inside Chat, **New session** starts another conversation. Select **Add workspace**, navigate to a folder (or use **Edit path**), then click **Open**. The native agent uses your OS account’s access to that folder. The companion uses the same Entra Local login and stores chat state in `.desktop-chat-home/<employee subject>`. Hosted and workstation chats have separate histories. A previously paired standalone chat profile stays on disk in its original home.

The default workstation assignment is `maya`. Set `CLAIMS_DESKTOP_USER` to the local employee’s demo ID to change the assignment. Other signed-in employees use their own hosted chat. With the companion stopped, sign-in opens the employee’s hosted workspace. The model-enabled stack publishes inference on loopback port 3082 for the workstation. Hosted Chat verifies the Workbench session for each request. Ordinary Chat and Claims Chat share Workbench and start zero employee containers.

## Connect Outlook Mail

In the Chat sidebar, open **App connections**, turn on **Allow agent access** for Microsoft Outlook, and confirm. Choose the work account assigned to the signed-in employee. The card displays the verified address once the server confirms mailbox access. Return to Chat, select **Outlook Mail**, and ask *Find emails about the Westfield invoice*. Select a subject to read the message, or ask *Open the second one*. Turning the switch off stops reads, including pending requests. Answers already delivered remain in that employee’s Chat history.

Best match gives exact identifiers and subject phrases priority, with newer messages first among comparable matches. Ask for the *latest* to order indexed matches by time received. *Recent* covers 30 calendar days including today in the browser’s time zone. Explicit dates override that window. A partial-results notice invites you to narrow the search. To draft an email, clear **Outlook Mail** and use the ordinary composer. Drafting makes no mailbox calls.

### Run the local Outlook emulator

From the repository root, install the pinned [Inbox Zero Emulate](https://github.com/inbox-zero/emulate) test dependency. Use Node 24 and keep the emulator running in the first terminal. Choose a fresh private directory for each run.

```sh
npm ci --prefix claims/tests/outlook-emulator
mkdir -m 700 "$TMPDIR/outlook-demo"
node claims/tests/outlook-emulator/lab.mjs --docker --app-origin http://localhost:3080 --write-env "$TMPDIR/outlook-demo/local.env"
```

On macOS with Podman, use `--podman` in place of `--docker`, and select `CONTAINER_ENGINE=podman` in the app terminal.

In a second terminal, load the generated settings and start the model-enabled demo with the weights from **Start the demonstration**. Sign in as Maya or Alex and pick the matching `@example.test` address on the local sign-in screen. Each employee has a different invoice reference. Restarting the emulator generates fresh identities and credentials, so restart the workbench with the new settings and reconnect.

```sh
set -a
. "$TMPDIR/outlook-demo/local.env"
set +a
node claims/deploy/up.mjs --model
```

For the CMS-MCP showcase, prepare the [pinned claim snapshot](showcase/README.md#explore-cms-mcp-claims) first. Add `--cms` to the emulator command and use `--app-origin http://127.0.0.1:3180`. Load the generated settings before starting `node claims/deploy/up.mjs --showcase --cms-mcp --model`. Each of the 20 CMS adjusters receives correspondence and a review update for each of their ten source claims. Pick an adjuster, open **App connections**, and consent with that employee’s synthetic address. Copy a claim number from Workbench and ask *Find my Outlook emails about CLM-000020*, using the copied number. Ask for its status in ordinary Chat to use the employee’s claims access. A Workbench transfer changes claim access. The original recipient keeps their existing mail.

The emulator handles Microsoft sign-in, refresh and mailbox reads. A [local Graph Search fixture](tests/outlook-emulator/graph-fixture.mjs) supplies the received-time search response for the same synthetic mailbox. To run the [mailbox isolation tests](tests/outlook-emulator/integration.test.mjs), set `CLAIMS_TEST_DATABASE_URL` to a disposable PostgreSQL database and run `npm --prefix claims/tests/outlook-emulator test`. The CMS tests use the prepared `.artifacts/claims-showcase/cms-mcp/snapshot.json` by default. Set `CLAIMS_CMS_TEST_SNAPSHOT` to use another absolute path. Microsoft tenant consent, indexing and Outlook Web links require separate tenant verification.

The workbench owns the Microsoft client secret and token encryption key. For a tenant deployment, register the workbench’s `/claims/connections/microsoft/callback` as a Web redirect, enable delegated `Mail.Read`, and provision immutable employee-to-Entra object ID mappings. The [server configuration](connections/oauth.mjs) defines the required settings. Each [agent operation](connections/operations.mjs) declares its required app grants. The [Graph transport](connections/graph-client.mjs) checks the grant before every HTTP call, including retries. To add Calendar, Teams, Files or People, register its operations and request its delegated scopes and token audience. An adapter for Work IQ must construct resource paths server-side and send an explicit, nonempty list of enabled sources. Calendar event access covers the event and its attendees. Chat, transcripts and recordings require their own permissions. OneDrive and SharePoint can share a Files switch when the provider groups their results. Check tenant consent, source restrictions and billing before enabling an adapter. [Work IQ retrieval and prerequisites](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/retrieve)

## Work through a shift

1. **Triage as Maya.** Open **WC-101** under **Must act this shift**. Its callback deadline explains why it appears above the unmatched intake and the waiting wage request. Compare the rules and due-date views. Refresh while reviewing a record. The selection persists while the record remains visible.
2. **Ask about one claim.** Open **Evidence & timeline**, read the diary, then use the assistant under **Overview**. Choose **Replay fixture** or **Local model**. Priority explanation, evidence comparison, timeline and handoff are separate tasks. For live priority explanations, the model selects and orders record facts. The workbench supplies the exact deadline and source citation. In live comparisons, the model selects passages and the server verifies every quotation against its source. Saved results retain the creating employee, claim revision, profile release and run mode.
3. **Prepare several handoffs.** Select multiple rows and prepare handoffs. Each selected record gets its own authorization checks and harness session. A failed run identifies the affected item. Handoffs are drafts.
4. **Receive work while signed out.** Deliver the voice-intake fixture using the dedicated producer credential, then repeat with the same event ID. Reopen **Inbox** and inspect the transcript and timeline. A single obligation survives the retry. The team intake variant lets an adjuster claim an item. Colleagues can send questions and replies on shared records. [Fixture ingress contract](integrations/README.md)
5. **Change ownership.** Open a record owned by Maya and transfer it to Alex. Refresh each browser. Alex can take the next action. Maya's old detail, evidence, and saved answers require current access. An old proposal cannot authorize a write against the new revision.
6. **Run the wage workflow.** With the story services running, open **WC-102** as its owner and choose **Request wage evidence**. Under **Reviews**, deliver the simulated partner callback. Refresh after the worker processes it, inspect the exact proposed change and digest, then approve or reject. For the recovery case enable **Lose next approval acknowledgement** in **Demo controls** before approving. Refresh to see the unknown outcome, then request reconciliation. A confirmed receipt identifies the one simulated effect. The operation and mailbox distinguish waiting, unknown and confirmed states.
7. **Evaluate triage.** Record feedback, open evidence and prepare a review from a displayed decision set. As the supervisor, open **Demo controls** and evaluate the synthetic ranking. Inspect recall and precision at the review budget, missed mandatory work, label coverage, disputed labels and observed time to the first matching action. Comparing timing requires observations for each ordering.

## How this uses the harness

| Part | Implementation | Example |
| --- | --- | --- |
| Profile | A versioned department manifest defines the subject types, allowed tools, procedures, model alias, evaluation and evidence policy. A generated dsh composition mounts its preset. | The employee can start a Claims run after selecting a claim or intake. [Manifest](profiles/claims-v1.json) |
| Plugin | A Cordis plugin contributes a service or UI feature and owns its lifecycle. | The browser admission plugin binds an Entra Local identity to a restricted peer. The workbench plugin registers HTTP routes and native main-panel/sidebar entries. [Admission](auth/README.md) · [Workbench plugin](runtime/plugin.mjs) |
| Tool | A named operation the model can request inside one scoped session. | `compare_evidence` reads authorized excerpts for the selected revision. The model cannot change the target by providing a different claim ID. [Assistant](runtime/assistant.mjs) |
| Hook | A check that runs at a defined stage of the existing loop. | The pre-step hook rechecks the session, authorization and revision, and caps the run. A tool guard restricts dispatch. Each read checks the item again. |
| Automation | A durable process that can make progress while the adjuster is offline. | Temporal starts the wage request, waits for a fixture callback and human review, then calls the domain service. An explicit receipt lookup resolves a lost acknowledgement. [Workflow](worker/workflows.mjs) |
| Integration | A source or destination adapter with its own identity, contract and deduplication rules. | Voice, calendar, Jira, Azure Boards and A2A-style updates replay synthetic events. The source adapter can be replaced when an approved system contract exists. |

The API derives identity from the browser session. The database checks the work item's assignment, team membership and tenant before returning counts, evidence or answers. Approval records the exact proposal version and digest. The worker polls a transactional outbox. Immediately before an effect, the domain service checks the reviewer, current assignment, version and payload again. These boundaries apply even when the model is unavailable.

The baseline runs Claims. The connected showcase also runs Legal Matters and Finance Billing Review with department-specific records, tools and approvals. Each assistant checks employee access and source revisions before returning a saved answer. The Legal and Finance demonstration links two independently owned records through a reviewed A2A request. [Presenter walkthrough](showcase/README.md#present-legal-matters-and-finance-billing-review)

## Tracing and learning

Operational spans contain static operation names, latency, status and opaque trace links. Routing decisions also record the classifier version, intent, confidence band, action and attachment count. The local Collector checks those fields and removes other span attributes, events and free-text status before forwarding to [Jaeger](http://localhost:16686). Select service `claims-workbench`. The wage admission trace links to its worker activities and subsequent review. The review trace links to dispatch and reconciliation. PostgreSQL keeps the exact approval and receipt in a separate action ledger. The native harness session log contains the model-visible synthetic evidence on the private application volume. The Claims composition disables stock session telemetry and feedback upload.

A supervisor's `GET /claims/api/dataset` returns the versioned synthetic decision records used by `POST /claims/api/evaluate`. The records retain the authorized candidates, ranking, actual exposures, subsequent actions, and independent fixture assessments. Ties use a stable order. Missing or disputed judgments remain visible in coverage. The demo evaluates two inspectable rankings. An open-source supervised ranker such as CatBoost can be evaluated once a business target, representative labels, and training rights are known.

## Deployment path

| Local component | Enterprise integration point | Work before deployment |
| --- | --- | --- |
| Harness web host and worker | ECS Fargate and the approved API gateway | Configure workforce and service identities, secret rotation, session sharing, tenancy and recovery. |
| PostgreSQL and local fixtures | RDS, governed claims/data APIs and approved evidence storage | Establish claim entitlements, authoritative versions, retention, audit and backup policies. |
| Local Temporal dev server | A supported Temporal deployment, or redesigned Step Functions workflows | Test retry limits, callback contracts, failover and operator intervention against real volumes. |
| Local Qwen/llama.cpp | Approved company models behind enterprise routing | Evaluate citation accuracy, refusals, cost and latency with examiner-reviewed cases. |
| Fixture ingress and simulator | Verified partner A2A exchange, voice intake, calendar, boards and system-of-record commands | Agree the partner schema and identities, signed evidence, idempotency, approval and destination receipt contract. |
| Collector, Jaeger and SQL ledger | Enterprise telemetry and independently governed attestation | Enforce access, integrity and retention separately for spans, action evidence and learning datasets. |

The demo uses synthetic claims. The future JURIS mock, sibling A2A checkout and company accounts are independent of local startup. The harness's [MIT license](../LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md) accompany the code. Model weights and container images carry their respective licenses.

## Developer context and privacy

The [context inventory](docs/developer-context.md) lists what Codex, Claude Code, Chat and Workbench load. The [outbound data audit](docs/security-audit.md) identifies destinations, payloads and triggers. The [isolated runtime observations](docs/runtime-evidence.md) and [build context check](docs/artifact-check.md) document the tested configurations. Enterprise Chat and Workbench disable upstream analytics, feedback upload and the raw session-log extension on official DeepSeek model requests. A configured DeepSeek search sends the search query with the original-question option disabled.

## Checkpoints and verification

The [local dispatch tests](tests/local-dispatch.test.mjs) cover interrupted approvals. The [launcher tests](tests/launch-protection.test.mjs) check that an existing custom profile survives startup. The [authentication tests](auth/auth.test.mjs) exercise session revocation, and the [work service tests](domain/tests/work.test.mjs) check that reseeding preserves existing work.

Run the commands from the repository root. The source tests require the harness build and both Claims npm lockfiles installed. Full-stack acceptance uses the story, observe and model Compose profiles. The wage story test creates a synthetic review and receipt on WC-102.

| Checkpoint | Runnable verification |
| --- | --- |
| [Local platform](deploy/README.md) | `node claims/deploy/up.mjs` boots the native web UI and persists seeded records. |
| [Identity and access](auth/tests/browser.acceptance.mjs) | `node claims/auth/tests/browser.acceptance.mjs` signs in as two users and verifies record and session isolation. |
| [Portfolio and record review](ui/tests/workbench.browser.mjs) | `node claims/ui/tests/workbench.browser.mjs` exercises navigation, selection, batches and rendering with fixture responses. |
| [Mailbox and integrations](integrations/fixtures.test.mjs) | `node --test claims/integrations/fixtures.test.mjs` verifies ingress identity and replay. Supply a disposable `CLAIMS_TEST_DATABASE_URL` for the database cases. |
| [Assistant tools and review](auth/tests/browser.acceptance.mjs) | `CLAIMS_ACCEPTANCE_LIVE=1 node claims/auth/tests/browser.acceptance.mjs` exercises both labeled replay and the configured model through the native panel. |
| [Durable workflow](worker/tests/recovery.test.mjs) | `TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix claims/worker run test:integration` exercises signal replay and worker restart. Add `CLAIMS_TEST_RESTART_SERVER=1` to restart the demo Temporal service during the test. |
| [Tracing and evaluation](tests/story.browser.mjs) | `node --env-file=claims/deploy/.env claims/tests/story.browser.mjs --observe` follows a browser approval to its receipt and verifies its admission link in Jaeger. |

For the focused tests use Node 24 and run:

```sh
pnpm install --frozen-lockfile
pnpm run build
npm --prefix claims ci --workspaces=false --ignore-scripts
npm --prefix claims/worker ci --workspaces=false --ignore-scripts
npm --prefix claims test
npm --prefix claims/worker test
```

The PostgreSQL tests create and remove isolated schemas when `CLAIMS_TEST_DATABASE_URL` is supplied. Without it they report the skipped integration cases. Browser acceptance uses local Chrome through Playwright. It reads the generated demo credentials without printing them.

### Claims Chat implementation reviews

| Review | Finding and refinement | Verification |
| --- | --- | --- |
| Identity and scope | Hosted Chat uses an owner credential for workspace operations. The limited claims bridge forwards the employee session, verifies the gateway assignment, and rechecks the login before delivering protected content. | Gateway and BFF tests, plus Alex and Maya in separate signed-in browsers. |
| Retrieval and citations | Chat reads the portfolio without logging a queue view. On a resumed WC-103 conversation, the model sometimes read only one incident-date passage. The verifier retrieves the missing passage through the same scoped MCP connection and identifies that read in Activity. | Disposable PostgreSQL checks, the WC-103 MCP snapshot, and a resumed date question with both documents openable at their cited passages. |
| Drawer and hosted Chat | A narrow sidebar overlapped the drawer and stale refreshes could overwrite newer results. The compact panel uses a modal on narrow screens and discards superseded reads. | Browser checks cover both widths, draft restoration, highlighted passages, and two deliberately reordered responses. |
| Comparison and recovery | Retries reuse the original request ID. Chat checks individually named claims before suggesting a comparison. On a resumed portfolio question about all deadlines today, it checks the full requested group even if the model repeats a claim ID from an earlier message. An omitted claim ID on a document read must resolve to one document in the confirmed selection. | Concurrent submits, interrupted attempts, reassignment, and MCP tests for named comparisons and resumed deadline questions. |
| Live deployment | Two model copies exceeded the available Docker VM memory. The showcase can share an existing local inference process. The activity route streams through Kong, with an authorized refresh if a stream stalls. | Live browser walkthrough with both PDFs, timeline follow-up, sign-out and resume, the shift-clock portfolio question, and a confirmed WC-103/WC-104 comparison. |
