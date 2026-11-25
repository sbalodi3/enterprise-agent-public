---
name: workbench-mailbox-adapter
description: Build employee mailbox adapters.
---

# Deliver work to the employee mailbox

Identify who sent the event, which record it concerns, and who owes the response. Authenticate service producers at ingress. For a colleague's request, derive the sender from the employee session and check that both people can access the record. Resolve the tenant, department, record, and recipient on the server. Keep claim matching in the claims adapter so another department can reuse delivery without inheriting workers' compensation fields. [Fixture ingress](../../../claims/integrations/fixtures.mjs) · [Domain and mailbox handling](../../../claims/domain/index.mjs)

The local service fixture uses a dedicated producer credential and fixed mappings. A production adapter needs a documented event format and authenticated producer identity.

## Exercise a signed-out voice intake

Use the synthetic event `{"source":"voice-intake","eventId":"voice-demo-1"}` against the fixture adapter. It maps to Maya's unmatched intake `IN-201`, whose transcript gives two possible incident dates. Keep the source excerpt available to the assigned examiner and leave the date for follow-up. A new matching adapter should send an ambiguous caller to an authorized intake queue for human matching. The existing `voice-team-intake` fixture demonstrates team ownership and acceptance with a fixed intake ID. [Fixture definitions](../../../claims/domain/fixtures.mjs) · [Ingress contract](../../../claims/integrations/README.md)

Deliver the event while Maya is signed out. Repeat it concurrently and after a handler restart using the same event ID. Expect one intake timeline entry and one open obligation in her inbox on sign-in. The domain transaction deduplicates by tenant, profile, and event ID. Reusing that ID for another source must return a conflict. Reject a browser or worker credential and any attempt by the fixture caller to select a different claim or tenant. Verify retrieval under the recipient's current access, including after reassignment.

For `a2a-update`, choose the path by the intended effect. A service event posted to `/claims/integrations/fixtures` can add evidence and mail. Advancing a waiting wage request requires a verified event bound to that specific request and delivered to its worker. Opening or reading an inbox message grants no approval. [Ingress behavior](../../../claims/integrations/README.md) · [Wage workflow](../../../claims/worker/README.md)

Run the following from the Git root. Set `CLAIMS_TEST_DATABASE_URL` to a disposable PostgreSQL database to exercise concurrent delivery, handler restart, and the team handoff. Report skipped database cases separately from the HTTP credential and input checks. [Ingress tests](../../../claims/integrations/fixtures.test.mjs) · [Work and team tests](../../../claims/domain/tests/work.test.mjs)

```sh
node --test claims/integrations/fixtures.test.mjs claims/domain/tests/work.test.mjs
```
