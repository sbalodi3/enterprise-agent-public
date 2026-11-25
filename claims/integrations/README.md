# Synthetic service ingress

English | [中文](README.zh.md)

`createFixtureIngress({domain, token, workerToken})` returns a native WebServer handler. Register it at `/claims/integrations/fixtures`. `token` comes from `CLAIMS_FIXTURE_TOKEN`; it must differ from the Temporal worker credential. Missing or weak configuration fails at registration. Browser cookies, CSRF tokens and worker tokens cannot authenticate this endpoint.

Send `POST /claims/integrations/fixtures` with `Authorization: Bearer <fixture credential>`, `Content-Type: application/json` and a body containing exactly `{"source":"voice-intake","eventId":"source-stable-event-id"}`. The service accepts only predefined synthetic sources. Each binds to a fixed fixture, tenant `demo`, profile `claims-v1` and item; caller-provided principals, claim IDs, evidence or scope are rejected. The event records `fixture-ingress` as its actor and the fixture producer as its service subject. This principal cannot log in through a browser.

| Source | Fixed work item |
| --- | --- |
| `voice-intake` | `IN-201` |
| `voice-team-intake` | `IN-202` in the shared intake team |
| `a2a-update` | `WC-102` |
| `calendar-change` | `WC-101` |
| `jira-update` | `WC-103` |
| `ado-update` | `WC-102` |

The service credential is reusable. The producer must keep the same `eventId` when retrying a delivery. The domain transaction durably deduplicates that ID, appends evidence/timeline and addresses the current owner's mailbox without requiring a live browser or agent. A replay returns `duplicate: true`; reusing the ID with another source returns 409. This route replays synthetic integration events and does not establish a live partner connection or deliver a Temporal wage response.

Run `node --test claims/integrations/fixtures.test.mjs`. With `CLAIMS_TEST_DATABASE_URL` set to a disposable PostgreSQL database, the test also checks concurrent delivery, handler restart, durable deduplication, mailbox delivery and the recorded actor and service subject in an isolated schema that it removes afterwards.
