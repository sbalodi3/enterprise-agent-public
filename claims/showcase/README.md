# Connected claims showcase

English | [中文](README.zh.md)

Walk through a shift as Maya. Start with an assigned portfolio, request wage evidence from a synthetic partner, listen to a missed call, then show exactly what an examiner approved and what appeared in mock JURIS. The portfolio contains fourteen fictional Ohio claims, six open and one closed per examiner, and two intake scenarios. The shift clock is November 17, 2026 at 14:00 UTC. [Scenario data](data/scenario.mjs)

The optional [wage-evidence study](wage-study/README.md) compares Workbench source review and the A2UI pilot using eight matched synthetic cases.

## Start locally

From the harness repository root, use Node 24, Python 3, `patch`, the container engine and Compose CLI from the [deployment guide](../deploy/README.md), and the matching local A2A checkout. The default sibling location is `$HOME/Documents/A2A/dev_a2a_aws`. Set `SHOWCASE_A2A_SOURCE` to use another copy. The launcher checks fingerprints, prepares a disposable partner build context under `.artifacts/claims-showcase`, and starts the separate `enterprise-agent-showcase` Compose project. The first build can require registry and package downloads. [Partner build and input contract](partner/README.md)

```sh
node claims/deploy/up.mjs --showcase
```

Open the [showcase entrance](http://127.0.0.1:3180/open-app). Choose Maya Chen in the Entra Local picker. Sign-in opens Maya’s workspace agent. Select **Workbench** in the sidebar to open her portfolio. A second browser profile signed in as `alex` can show how the visible portfolio changes with the examiner.

After the images have been built, the following starts the cached stack for offline presentation. Both workflow stories run without inference. To show a live Chat reply as well, stage the local model weights using the [model instructions](../README.md#start-the-demonstration) and add `--model`.

```sh
node claims/deploy/up.mjs --showcase --offline
```

## Explore CMS-MCP claims

Enable this dataset to add 200 synthetic claims from six lines of business to the existing showcase. The first import reads the [pinned CMS-MCP checkout](https://github.com/sebastianhema/CMS-MCP/tree/bfa4bfceeb0a9b73a88b7a4f7ab82704a043341e) with the selected engine’s locally cached `docker.io/library/postgres:17` image. Supply the path to your checkout and run from the harness repository root.

```sh
CMS_MCP_SOURCE=/path/to/CMS-MCP node claims/deploy/up.mjs --showcase --cms-mcp
```

The launcher saves a verified snapshot in `.artifacts/claims-showcase/cms-mcp/`. Subsequent starts can use `node claims/deploy/up.mjs --showcase --offline`. Re-importing the same snapshot preserves assignments and document revisions. Configure the local model for live Claims Chat answers.

1. Open the [showcase](http://127.0.0.1:3180/open-app) as **Aisha Khan**. Her starting portfolio has ten open claims. In Workbench search for **CLM-000020**. Open its extract and compare the loss date (December 6, 2024) with the reported date (December 24). Ask Claims Chat for those dates, then open its cited passage or PDF.
2. In another browser profile choose **Brandon Lee**. He starts with ten denied claims. In Workbench choose **All claims** or **Closed** and look up **CLM-000017**. Its source status is Denied and its deductible is 947.00. Search for Aisha’s claim to check assignment isolation.
3. Choose **Claims Administrator** to explore the six lines across employees. The 20 source adjusters start with ten claims each. The source assigns each adjuster a single status, so twelve accounts have only closed, paid or denied claims. Open a timeline entry to inspect its source passage. Dates of loss and reporting are calendar dates. The extract records its own generation time.

In Aisha’s Chat, ask *What are my open cases?* Open a row in the Cases app to see it in Workbench. As the administrator, ask *Show the organization portfolio summary by line of business.* The imported portfolio totals 200 claims, 3,173,820.00 in billings and 29 litigated claims. Expand a group, select a claim and use **Ask agent → Open in Chat** to ask for its billings and deductible. Open the financials citation to compare both values with the extract.

The importer reads the pinned CMS-MCP SQL once. Chat and the MCP Apps then use Workbench’s authenticated reads for case lists, timelines, summaries and source links. A transfer changes the current owner while the extract preserves the original source adjuster. The administrator can supervise the claims. With the local CMS Outlook fixtures enabled, any of the 20 adjusters can connect their own synthetic mailbox from **App connections**. Each mailbox has 20 claim-specific messages covering that adjuster’s ten source claims. Ask *Find my Outlook emails about* followed by a claim number from Workbench. [Outlook emulator setup](../README.md#connect-outlook-mail)

With the CMS showcase, local model and Chrome running, the first two checks exercise both roles, source links, and the administrator’s interactive case search. The third checks the account directory and private hosted workspaces. The Outlook checks require the CMS emulator. The `--cms-all` check verifies all 20 employees’ claim scope and mailbox consent. The `--cms` check runs live Outlook Chat turns for Aisha and Brandon.

```sh
node claims/showcase/tests/cms-portfolio.browser.mjs
node claims/showcase/tests/cms-cases.browser.mjs
node claims/auth/tests/entra.browser.mjs --showcase --cms-mcp --hosted --shared
node claims/tests/app-connections.browser.mjs --cms-all --shared
node claims/tests/app-connections.browser.mjs --cms --shared
```

Use `node claims/deploy/up.mjs --showcase --no-cms-mcp --offline` to hide the imported claims and their directory accounts. The original showcase and saved work stay available on their existing volumes. Add `--cms-mcp` to enable this dataset again.

## Act on a CMS claim

Open **CLM-000020** as Aisha Khan. In **Ask agent**, type *Create a note: Employer called to confirm the payroll contact.* Edit or discard the draft, or choose **Approve and add note**. Open **JURIS record** to find the filed note and receipt. Chat and **Reviews** share the same proposals. Open claims also support handling priority, handling instructions, and creating, rescheduling or completing a diary. Closed, paid and denied claims accept supplemental notes.

Ask *Request wage evidence* on Aisha’s claim. Review the identity, dates and destination before approving disclosure. **Release partner evidence** returns one pay period. Inspect earnings, uncovered dates and sources before separately approving filing. **CLM-000002** exercises full coverage. A contact note drafted from an opened Outlook message starts as a private, editable summary.

Run `node claims/showcase/tests/reviewed-actions.browser.mjs` against the installed showcase to verify drafting, editing and discarding across Chat and Workbench.

## Present Legal Matters and Finance Billing Review

Use two separate browser profiles at the [showcase entrance](http://127.0.0.1:3180/open-app). Sign in as `finance` (Sam Patel) in one and `legal` (Morgan Ellis) in the other. Each employee starts with their department assistant open alongside six synthetic records. Its answers use the configured local model and link to authorized documents. Saved answers reopen for the same person and scope while the source revisions remain current.

1. In Finance open **FIN-207**, the outside-counsel invoice exception. Click the **+$600 variance** to highlight the repeated expense reference **EXP-044**. Open a source line or its PDF. The supplier invoice totals $9,000 and the staged bill totals $9,600. Use **Ask agent** to ask what explains the variance.
2. Select **Ask Legal to verify expense**. Read the proposed question and recipient, then confirm. In Legal, open the **Inbox** and select the request on **MAT-017**. Open the expense authorization register. It records one $600 approval and identifies the register the reviewer checked.
3. In Legal select **Approve reply to Finance** and confirm the shareable disposition. Return to Finance. The response arrives in the inbox and on FIN-207, with reference **AUTH-600-01**. Ask **“Was a second $600 expense authorized?”** and open the cited copy of the approved response. **Open billing review** records a review in the mock Finance register. Inspect the receipt and compare the invoice and staged lines. A reviewer still has to resolve the exception before billing.
4. In **MAT-017**, use **Ask agent** to prepare the incident chronology. The supervisor report says November 9. The handover says November 10 and was entered on November 17. Inspect the two cited passages, then **Request date confirmation** or **Approve factual packet**. The packet keeps the disagreement explicit. The assigned WC-103 adjuster receives the status and approved references in Claims. Legal’s internal preparation note stays in the matter.
5. For a second demonstration, Finance can use **Request another authorization check** after the first exchange completes. Existing filed packets and billing reviews can be reopened using their receipts. Show **MAT-021** or **FIN-212** to demonstrate work with no claim ID.

The local Legal peer and Workbench exchange A2A messages over the private Compose network. The approved question and returned billing reference cross departments. The mock matter file and billing-review register are local demonstration destinations. The implementation does not contact outside counsel or a billing provider. [A2A exchange](../portfolios/a2a.md) · [Department profiles](../portfolios/profiles.mjs)

For local Ollama, set `CLAIMS_MODEL_ID=nemotron-3.5-lightning:30b-mlx` and point `CLAIMS_MODEL_URL` at an endpoint reachable from the containers in `.artifacts/claims-showcase/.env`. On macOS, use `http://host.containers.internal:11434/v1` with Podman or `http://host.docker.internal:11434/v1` with Docker Desktop. Start the showcase with `--offline` after the model and container images are available. `node claims/showcase/tests/department-chat.browser.mjs` exercises real sign-in, live model answers, source PDFs, saved history and access checks with the configured model.

## Present the two claims workflows

### 1. Request missing wage evidence

1. Open **Workbench**, select **WC-102**, and read the employer incident report. Jamie Rowan's report has no payroll attachment. In **JURIS record**, show the initial revision and empty wage evidence field.
2. Select **Request wage evidence**, then **Reviews**. Review the disclosure and select **Approve and send wage request**. When the request is waiting, select **Release partner evidence**. This presenter control instructs the partner mock to complete its task. Use **Refresh** to see the resulting review.
3. Open **Overview → Open interactive timeline → Partner wage statement**. Select **Open PDF** to inspect the same version shown in the source reader. The partner returned June 1–14, 2026, gross USD 1,830, 80 regular hours and 4 overtime hours. Those 14 days cover only part of the 364 requested days. Point out the source and the outstanding coverage.
4. In **Reviews**, inspect the target, proposed quote, citation and revision. Select **Approve and file wage evidence**, then refresh until the receipt appears. In **JURIS record**, show the wage entry, the new revision and the matching receipt ID. The approved change records documentary evidence. Benefit and payment decisions remain with their existing process.

### 2. File a missed call on the correct claim

1. Select **Deliver missed call**. In **Inbox**, open **IN-201 → Intake Review**. The synthetic recording and speaker-attributed transcript are bundled in the application. Click the timestamp near 0:06 to hear the caller describe Cedar Dock, loading bay three and report number ending in 42.
2. Compare **WC-105** and **WC-107**. Both name River Ellis and Willow Harbor Supply. WC-105's employer report describes Cedar Dock and WHS-42. WC-107 describes Alder Yard and WHS-71. The caller is unsure of the incident date. Keep that uncertainty visible when making the match.
3. Select **WC-105**, choose the cited caller passage and select **Prepare filing**. In **Reviews**, inspect the proposed filing and select **Approve exact proposal**. Refresh, open the filed claim, and inspect **JURIS record**. The transcript reference, quoted passage and receipt should agree with the approval. A team intake, **IN-202**, has too little information to match and stays queued for follow-up.

The signed-in presenter can also open a protected [WC-102 JURIS snapshot](http://127.0.0.1:3180/claims/api/items/WC-102/juris), [employer report PDF](http://127.0.0.1:3180/claims/api/media/WC-102/WC-102-report?format=pdf), or [delivered intake audio](http://127.0.0.1:3180/claims/api/media/IN-201/IN-201-call?format=audio) directly. These URLs recheck the current employee's access on every request.

## Use the claims agent from either page

For local Nemotron Lightning, configure the Ollama endpoint and model identifier described above. Chat can open an authorized claim named in a question and show it as **Current**. If the description has several possible matches, the agent asks which claim you meant. **Yes** continues the original request. **No** rules out that candidate for the request. **Other** lets you enter a new clue.

1. Sign in as **Maya**, open **WC-101**, then open the **Callback diary** PDF. The viewer renders the authorized file and offers **Download** and **Open in new tab**. After a sign-in prompt, the application returns to the requested document.
2. Sign in as **Alex** in another browser profile. Open **WC-103** and select **Ask agent → Open in Chat** to continue its Workbench conversation in native Chat. **New session** inside Chat starts a blank conversation.
3. In the native composer choose **Choose scope**. Search Alex’s assigned or shared claims, switch between open and closed records, expand WC-103, and select the supervisor report and shift handover. Apply the scope, then ask *Why are there two incident dates?* The first report gives November 9 and the second gives November 10. Open each citation to see the highlighted passage.
4. Ask *Show me the timeline.* November 17 is the handover’s entry date. Narrow the selection to the supervisor report and ask again. Each answer keeps its original source references, and subsequent reads use the new selection. With the report still pinned, ask *Which of my assigned claims have a deadline later today?* to search the portfolio. The report stays attached for the next question about the pinned document.

The work service checks access for each protected read. The optional CPU classifier uses 90 synthetic training examples to help route requests between workspace and protected Chat. Manual attachments and direct portfolio searches work independently of that classifier. To stage the model, use Python 3.12 in a virtual environment, install the training dependencies, and supply a local copy of `sentence-transformers/all-MiniLM-L6-v2` at revision `c9745ed1d9f207416be6d2e6f8de32d1f16199bf` as `MINILM_DIR`. The training command checks the base weights and writes a versioned release. The showcase launcher enables the private inference container when the release is present. Add `--observe` to view protected chat runs in [local showcase traces](http://127.0.0.1:17686).

```sh
python -m pip install -r claims/router/requirements-train.txt
python claims/router/train.py --base "$MINILM_DIR" --output .artifacts/claims-router/model
node claims/deploy/up.mjs --showcase
"${CONTAINER_ENGINE:-docker}" exec enterprise-agent-showcase-workbench-1 node claims/router/evaluate.mjs
```

To work with a Mac folder in Maya’s Chat, build the local harness using the [workstation setup](../README.md), then start this companion in a second terminal from the repository root. Open `/open-companion` on the showcase to use Maya’s signed-in companion on port 3181. Select **Add workspace** to open a folder. The standard `/chat` URL opens Maya’s shared Workbench Chat.

```sh
DSH_HOME=.artifacts/claims-showcase/workstation-home CLAIMS_APP_ORIGIN=http://127.0.0.1:3180 CLAIMS_CHAT_PORT_BASE=3183 CLAIMS_DESKTOP_USER=maya CLAIMS_MODEL_URL=http://127.0.0.1:11434/v1 CLAIMS_MODEL_ID=nemotron-3.5-lightning:30b-mlx node claims/runtime/launch.mjs --desktop-chat
```

With the showcase running, `node claims/showcase/tests/claim-chat.browser.mjs` exercises the live path using synthetic employees. Add `--comparison` to exercise portfolio suggestions and the confirmed two-claim comparison. The keyless MCP regression is `node --test claims/tests/claim-chat-runtime.test.mjs`, and the shared UI regression is `node claims/ui/tests/claim-chat.browser.mjs`.

## What runs

| Component | Responsibility in the demonstration |
| --- | --- |
| Kong and Entra Local | Kong's DB-less proxy exposes the employee application on loopback port 3180. Entra Local handles the local sign-in. The application derives employee and claim access from the session. |
| Workbench and its database | Store the examiner's assigned work, source versions, mailbox obligations, decisions and approved commands. Each evidence read, media request and source-system read checks current record access. |
| Partner adapter, Amazon mock and Temporal | The workflow can wait across sign-outs. The adapter uses the sibling A2A client's draft wage contract, verifies the signed partner result and returns its evidence. A callback refers to a task. The worker retrieves the authoritative result before presenting it. [Adapter](partner/README.md) |
| Voice mock and source assets | A fixed service event delivers one intake. The same locally synthesized recording supplies the timestamped transcript and the testimony the examiner cites. [Recording generator](assets/generate_call.py) |
| Timeline MCP App | The read-only tool is bound to the selected claim and revision. Its sandboxed view displays events and lets the examiner open a source in the host. The source reader also exposes the same text outside the frame. [Tool and resource](timeline.mjs) |
| Mock JURIS | A separate service, database and role own the fourteen scripted claims and, when enabled, the 200 CMS claims. Each command updates one claim and records one receipt in a transaction. Retrying an identical operation returns the original receipt. The JURIS tab reads the destination through the authorized Workbench endpoint. [Service](juris/store.mjs) |

Workbench checks access to each record and requires human approval of the exact payload before a destination write. This showcase uses synthetic services and data.

## Repeat or verify

`--stop` shuts down the showcase and preserves its named volumes. Start it again to resume. **`--reset` deletes the showcase project's named volumes, including its recorded reviews, partner tasks and destination receipts.** To repeat from a fresh shift, run the reset and start commands in order. [Launcher](launch.mjs)

```sh
node claims/deploy/up.mjs --showcase --reset
node claims/deploy/up.mjs --showcase --offline
```

The browser check approves the wage request, wage filing and intake filing and advances the demo records, so use a fresh showcase for the test. Run it from the repository root with the web workspace dependencies and Google Chrome available. It covers the Workbench handoff to Chat, private claim access, signed wage response, MCP timeline citation and downloadable PDF, audio seeking, intake matching, destination readback and an evidence comparison as Alex. Set `SHOWCASE_TEST_LOST_ACK=1` to exercise receipt reconciliation during the wage review.

```sh
node claims/showcase/tests/browser.mjs
```

For the signed partner and browser approval test, set `CLAIMS_CMS_TEST_DATABASE_URL` to disposable PostgreSQL, `TEMPORAL_ADDRESS` to a test Temporal instance, `CLAIMS_TEST_A2A_CONTEXT` to a fresh prepared partner directory, and `CLAIMS_TEST_PYTHON` to its Python interpreter. Run `node --test claims/showcase/tests/reviewed-wages.integration.mjs`. This test starts private partner processes, uses its own claim database and checks both full and partial wage returns.

For a check of the underlying data and JURIS command behavior, run the following. `JURIS_TEST_ADMIN_URL` enables the transaction test against disposable PostgreSQL with permission to create a temporary database. `CLAIMS_SHOWCASE_TEST_DATABASE_URL` enables the Workbench integration test using the same approach. Both checks remove their own generated test databases.

```sh
node --test claims/showcase/data/*.test.mjs claims/showcase/juris/*.test.mjs claims/domain/tests/showcase.test.mjs
```
