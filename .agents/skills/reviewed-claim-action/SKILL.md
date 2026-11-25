---
name: reviewed-claim-action
description: Build reviewed claim writes.
---

# Build a reviewed claim action

Start with the destination effect. Identify the record and fields that could change, the employee who may approve them, and the receipt that verifies the outcome.

## Follow one proposal through the service

1. Have the Workbench display the proposed fields, evidence, destination, and current record revision. The domain service owns the saved proposal, payload digest and approval. An edit to the proposed change requires a fresh review. Trace the current path through `review`, `dispatchOperation`, and `reconcileOperation` in the [domain service](../../../claims/domain/index.mjs).
2. Immediately before dispatch, recheck the reviewer’s entitlement, assignment, record revision and approved payload digest. Keep the same operation ID across retries.
3. Keep the examiner's approval, the worker's progress, and confirmation from the destination distinguishable in the UI. If the destination may have acted before its acknowledgement was lost, present the outcome as unknown. Look up the existing operation at the destination. Mark it confirmed only when the receipt matches the reviewed change. [Worker recovery](../../../claims/worker/README.md)

## Exercise the two outcomes separately

- **Transfer while waiting.** Maya starts a synthetic wage request on WC-102, then transfers the claim to Alex. A pending request or review becomes stale. A new callback for the old request cannot create an actionable proposal. Check that Maya loses access and Alex can start a fresh request at the new revision. For an already approved, queued write, transfer before dispatch and verify that the stale operation produces no effect. [Domain scenarios](../../../claims/domain/tests/work.test.mjs)
- **Lost acknowledgement with the same owner.** Keep Maya assigned, have her inspect and approve one proposal, then simulate loss of the acknowledgement. Check the unknown state, run reconciliation twice, and verify that both lookups identify the same receipt and a single simulated change. Separate the business receipt from a successful activity trace. [Synthetic shift](../../../claims/README.md#work-through-a-shift) · [Worker restart and receipt checks](../../../claims/worker/tests/recovery.test.mjs)

From the Git root, run `node --test claims/domain/tests/work.test.mjs` with `CLAIMS_TEST_DATABASE_URL` pointing at disposable PostgreSQL. For worker recovery, set `TEMPORAL_ADDRESS` to a local test server and run `npm --prefix claims/worker run test:integration`. Report the denied or stale operation, the state before receipt lookup, the confirmed effect count, and any infrastructure-dependent cases that skipped.
