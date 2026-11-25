---
name: a2a-partner-contract
description: Design partner A2A requests, authenticate callbacks and validate task evidence.
---

# Develop a partner A2A exchange

Identify the publisher, caller, capability and protocol version. Record the input and output fields and how the result links to the authorized employee, claim and request.

## Resolve identity at the right boundary

The local adapter uses a dedicated credential for each service boundary. Agree on partner identity and callback rules before using an external provider.



## Exercise a wage request

Use synthetic claim `WC-102`. Retry the same request after a lost acknowledgement and verify it returns one task. The signed adapter verifies callback identity and retrieves the authoritative task before staging evidence. Test duplicate callbacks and mismatched task IDs. Keep wage values out of operational traces.

In the harness, the wage workflow consumes a locally persisted synthetic delivery tied to the request. A transfer from Maya to Alex marks the pending request stale. A fresh late callback to that request cannot create a review. Alex may open a fresh request at the new claim revision. The mailbox fixture named `a2a-update` by itself delivers a notification. The worker path requires the request ID. [Domain and fixture handling](../../../claims/domain/index.mjs) · [Mailbox ingress](../../../claims/integrations/README.md) · [Worker](../../../claims/worker/README.md)

Run the domain tests from the Git root with `CLAIMS_TEST_DATABASE_URL` set to a disposable PostgreSQL database. For callback replay and restart, also use a local Temporal test service. Report which cases ran, which skipped, and which partner requirements still need bilateral evidence. [Domain tests](../../../claims/domain/tests/work.test.mjs) · [Worker recovery test](../../../claims/worker/tests/recovery.test.mjs)

```sh
node --test claims/domain/tests/work.test.mjs
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix claims/worker run test:integration
```
