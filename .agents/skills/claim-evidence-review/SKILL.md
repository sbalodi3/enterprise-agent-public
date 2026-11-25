---
name: claim-evidence-review
description: Develop source-linked claim timelines, comparisons and handoff drafts.
---

# Review evidence for one claim

Choose the affected task in the department profile. Follow its registered tool in the scoped assistant to the domain read for the selected employee, item and revision. The live comparison renderer verifies exact passages against the sources that tool read. Timeline and handoff checks accept a matching source reference in the answer. For changes to either, verify each material statement against its own source as part of review. [Claims profile](../../../claims/profiles/claims-v1.json) · [Scoped assistant](../../../claims/runtime/assistant.mjs) · [Domain reads](../../../claims/domain/index.mjs)

## Work through a correction

Use the synthetic IN-201 transcript. At 00:12 the caller reports Monday. At 00:43 the caller says Tuesday is possible. For a correction test, extend a disposable fixture with a later examiner note recording the caller's correction to Tuesday. Leave the written incident report absent. Preserve the timestamp of each account separately from the incident date it describes. [Intake fixture](../../../claims/domain/fixtures.mjs)

- For a comparison or summary, the examiner should be able to open the source of each material statement on the selected record. Attribute both accounts to their speakers, identify the later correction, and keep independent confirmation outstanding. Ask an examiner to identify the expected facts and unresolved question when preparing a pilot example. Identify who set those expectations so fixture-authored and examiner-reviewed examples can be counted separately.
- For a timeline or handoff, include the source and date of the correction, current owner, and follow-up for the missing report. Keep the handoff a draft. For multi-record handoffs, run a separately authorized session for each record.
- Substitute a quote from the wrong source and verify that the live comparison renderer rejects it. Advance the claim revision or reassign it while a run is pending. Verify the server rejects completion under the old binding. After reassignment, the former owner loses access and the new owner starts a separate session at the current revision. [Renderer and replay tests](../../../claims/tests/assistant.test.mjs) · [Session and reassignment tests](../../../claims/domain/tests/work.test.mjs)

Run `node --test claims/tests/assistant.test.mjs claims/domain/tests/work.test.mjs` from the Git root with Node 24, the harness build, and local claims dependencies. Supply a disposable `CLAIMS_TEST_DATABASE_URL` to exercise persisted sessions and reassignment. State which results came from replay, renderer tests, or a configured local model, and identify any database skips.

## Enterprise decisions

Read seeded records locally. External evidence requires an authorized source and a way for the examiner to retrieve the cited version.
