---
name: claims-portfolio-triage
description: Evaluate claim queue ranking, diary deadlines and next actions.
---

# Claims portfolio triage

Start with the examiner's shift and the number of items they can review. In the claims domain, `portfolio` selects visible candidates, `rank` orders them, and `scoreBaseline` evaluates recorded decision sets. Apply authorization before computing ranks or counts. Keep the portfolio rule in the claims service so it works with a local model or with inference unavailable. [Domain service](../../../claims/domain/index.mjs) · [Shift walkthrough](../../../claims/README.md#work-through-a-shift)

## Exercise a synthetic shift

1. Use the seeded shift at 14:00 UTC on November 17, 2026. Maya owes a callback on WC-101 by 15:00 according to its diary. IN-201 needs identity matching, and WC-102 is waiting on wage evidence. Capture each row's owner, next action, reason, source, and due time when known. Preserve the distinction between a missing deadline and a deadline that has passed. [Seed records](../../../claims/domain/fixtures.mjs)
2. Compare the proposed change with the existing rules and due-date orderings on the same authorized candidates at the same time and review budget. Include a tie and a disputed or missing reviewer assessment. Transfer WC-101 to Alex in a disposable run. Refresh both portfolios and check counts and next actions under each employee's current access.
3. Report how many mandatory items fall below the budget, precision and recall at that budget, and label coverage. For time to first matching action, record which ordering the examiner saw and which action matched an independent assessment. Report the mean alongside the number of timed and eligible decision sets for each ordering. A ranking with no observed matching action has no timing estimate. [Evaluation tests](../../../claims/domain/tests/work.test.mjs)

Keep candidate sets, actual exposures, actions, and independent assessments distinguishable in the evaluation data. A click records behavior. A reviewer supplies the label. Operational spans carry timing and opaque correlation data. Use synthetic records until the business target, representative labels, and rights for historical training data are established. [Tracing and learning](../../../claims/README.md#tracing-and-learning)

Run `node --test claims/domain/tests/work.test.mjs` from the Git root with Node 24 and the claims dependencies installed. Set `CLAIMS_TEST_DATABASE_URL` to a disposable PostgreSQL database for assignment, access, and recorded-action cases. Report a skipped database suite separately from the pure ranking test.

## Enterprise decisions

Identify the applicable program and source before treating a diary interval as mandatory. The fixture deadlines and scoring results describe a synthetic shift.
