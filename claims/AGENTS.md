# Developing Enterprise Agent for claims

Enterprise Agent opens Chat after sign-in. The Chat sidebar gives adjusters access to Workbench. Chat opens the employee's workspace. Workbench triages an assigned portfolio. The native Claims Agent reads the claims and documents selected in its composer. Use the [shift walkthrough](README.md#work-through-a-shift) to identify which experience a change affects.

In the connected showcase, the Workbench drawer and hosted Claims Chat share a protected conversation. Follow the [WC-103 walkthrough](showcase/README.md#use-the-claims-agent-from-either-page) and use the [claims MCP runtime](runtime/claim-chat.mjs) for portfolio, claim, document, or confirmed multi-claim reads. Keep ordinary workspace history and employee claims history separate.

## Choose the owner of a change

For Legal Matters and Finance Billing Review, start with the [department profiles](portfolios/profiles.mjs), [record and approval store](portfolios/store.mjs), and [mock A2A exchange](portfolios/a2a.md). Use the [presenter walkthrough](showcase/README.md#present-legal-matters-and-finance-billing-review) to identify which employee owns the record and which approved fields may cross departments.

| Change | Where it belongs |
| --- | --- |
| Department capabilities, allowed tools, procedures and evidence rules | The [department profile](profiles/claims-v1.json). Keep claim-specific assumptions out of shared harness packages. |
| A read or draft for one claim | The [scoped assistant](runtime/assistant.mjs). Bind employee, record and revision server-side. Recheck access when ownership changes. Verify quotations against the selected evidence. |
| Receiving external events or running work across sign-outs | An [integration adapter](integrations/README.md) authenticates its producer and handles duplicate delivery. The [worker](worker/README.md) coordinates durable steps. |
| A consequential change | The [domain service](domain/) checks the human approval against the exact proposal and current access before dispatch. Show an unknown outcome until a destination receipt or reconciliation confirms the effect. |

## Choose a developer skill

| When the change concerns | Use |
| --- | --- |
| Which claim to work next, diary deadlines or ranking evaluation | [Claims portfolio triage](../.agents/skills/claims-portfolio-triage/SKILL.md) |
| An external agent's advertised capability, task, callback or returned evidence | [A2A partner contract](../.agents/skills/a2a-partner-contract/SKILL.md) |
| An examiner approving an exact change, its dispatch or destination receipt | [Reviewed claim action](../.agents/skills/reviewed-claim-action/SKILL.md) |
| Facts and sources in a selected claim's timeline, comparison or handoff draft | [Claim evidence review](../.agents/skills/claim-evidence-review/SKILL.md) |
| Delivery from a service to an employee's inbox, claim matching or duplicate messages | [Workbench mailbox adapter](../.agents/skills/workbench-mailbox-adapter/SKILL.md) |

## Handle development context

Keep internal engineering references out of employee prompts, fixtures, trace payloads and application assets. An employee who opens a checkout in desktop Chat gives workspace tools access to the selected folder.

## Verify and share a change

Use synthetic claims and disposable identities. After the local prerequisites are installed, start with `npm --prefix claims test`. For worker changes also run `npm --prefix claims/worker test`. Select the browser, database, or recovery check for the affected behavior from [checkpoints and verification](README.md#checkpoints-and-verification). Use fixture replay or the configured **local** model. Identify which one produced any saved answer or recording. Installing packages, pulling images, downloading weights, and explicitly requested tests against a named remote provider each have a separate network destination.

The native session log can contain model-visible evidence. Keep operational spans limited to operation names, opaque links and the allowlisted routing categories, model version and attachment count. Use the domain ledger for approvals and receipts, and establish training rights before using historical claims for learning. [Tracing and learning](README.md#tracing-and-learning)

Use the intended private project for pushes and PR artifacts. Check the push URL and repository visibility before sharing. A local recording can include a chat transcript, workspace path, or sign-in screen. Review its frames and share synthetic evidence only with the requested audience. Preparing a branch, test, or screenshot by itself authorizes no upload.
