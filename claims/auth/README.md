# Claims demo browser authentication

English | [中文](README.zh.md)

The claims profile authenticates synthetic employees with Entra Local. Its passwordless account picker starts a confidential-client OIDC flow. The workbench grants a restricted peer only after authentication and employee lookup.

The browser receives an opaque HttpOnly, SameSite=Lax cookie. HTTPS uses a Secure `__Host-` cookie; HTTP is accepted only for loopback public URLs. JWTs, provider credentials and PKCE verifiers remain on the server. Discovery and ID-token issuer/audience/signature/expiry/nonce verification bind the login to the configured issuer and client. State is single use and bound to a separate HttpOnly browser cookie. The confidential client also uses PKCE S256. The signed tenant and object IDs must match an explicit employee link in PostgreSQL. The linked principal supplies the current role. Its existing workbench subject owns saved chats and Outlook grants. To add an employee, provision their claims principal and add their account to the [employee roster](roster.mjs).

| Endpoint | Behavior |
| --- | --- |
| `GET /auth/login` | Start a fresh interactive Entra Local login. The flow can retain an allowlisted Claims Agent or PDF destination. |
| `GET /auth/callback` | Validate the authorization response, rotate the browser session, and resume the validated destination from an app-origin completion page. A normal login opens Agent Chat or the employee’s department assistant. |
| `GET /auth/me` | Return `{user, csrfToken}` or 401. `user` includes `subject`, `principalId`, `tenantId`, `displayName` and `roles`. |
| `POST /auth/logout` | Require same Origin and `X-CSRF-Token`, revoke the local session/Peer and clear the cookie. |
| `GET /auth/signed-out` | Anonymous confirmation page with an explicit Sign in link. |
| `POST /auth/backchannel-logout` | Verify a signed OIDC logout token and revoke matching local sessions. |

Domain APIs call `ctx.claimsAuth.require(request, {write: true})` before a mutation; reads call `require(request)`. A successful call supplies a verified `claims-user` principal. The domain service still checks claim entitlement, role and workflow state. This plugin grants no stock Remote actions: sessions, workspaces, attachments, filesystem and plugin management remain unavailable to claims users. Internal assistant execution uses a domain-scoped service path, not a browser owner session.

The launchers set the app origin, tenant-specific public issuer, confidential client secret and private OIDC transport origin. Discovery, authorization, token and signing-key paths must match the configured tenant. The baseline and showcase persist their directories in separate volumes.

The unified Podman app defaults to a 12-hour browser session. Set `CLAIMS_AUTH_SESSION_SECONDS` to override the duration. The launcher also sets the Entra Local ID-token lifetime so the token can cover that session. Pending sign-ins expire after five minutes. The callback offers a link to start a new sign-in when the attempt expires or cannot be verified.

Browser sessions and pending logins end on host restart. Application sign-out revokes the local peer and closes its session watch. Entra Local supports front-channel logout. Disabling a directory account prevents fresh sign-ins. An existing application session lasts until local sign-out, ID-token expiry or the configured session limit.

Authentication APIs return safe HTTP status and `AUTH_*` codes. The browser callback shows a recovery page for an invalid sign-in. The authorization flow is single use. Provider outages deny new login without falling back to owner. No token exchange is retried automatically. Connection provider removal immediately stops new admission; plugin teardown revokes admitted Peers and streams.

The tests use signed JWTs and a local provider fixture. Browser acceptance exercises the pinned [Entra Local release](https://github.com/cmaneu/entra-local/tree/v0.1.1).

Run `node claims/auth/tests/entra.browser.mjs` against the baseline or add `--showcase` for all five showcase employees. The check uses installed Chrome and verifies portfolio access and isolated logout. Add `--hosted` to open each employee’s default Chat or department assistant and verify hosted Chat revocation. Run `node claims/auth/tests/browser.acceptance.mjs` against a fresh baseline for the full claim and evidence flow.

Set `CLAIMS_ACCEPTANCE_LIVE=1` when the local model service is running to additionally select Compare evidence and Local model in the real panel, check the answer against the selected source, and print the resulting synthetic session ID for log inspection. `CLAIMS_ACCEPTANCE_SCREENSHOT` can name a local PNG path for the rendered answer. This optional path sends only the seeded synthetic claim to the configured local model.

The application root requires Entra Local and opens Agent Chat or the employee’s department assistant. Both the workstation and employee-specific hosted chat gateways verify the app’s current session and the assigned employee before forwarding any native chat traffic, including the WebSocket. The gateway retains the upstream harness credential in memory. Its claims bridge forwards only the signed-in employee’s cookie and supported claims operations. Opening a citation rechecks its claim, document version, and saved conversation. A browser following an expired document or conversation link signs in again and resumes that destination. An authenticated session watch closes active browser connections when the primary session ends. Hosted chat volumes and the workstation’s local profile are independent.

For the two-mode browser acceptance run, start the Maya workstation companion and the Compose services. Set `CLAIMS_DESKTOP_ACCEPTANCE=1` when running the browser test above. Optionally set `CLAIMS_DESKTOP_TEST_WORKSPACE` to the absolute path of a demo folder to exercise the local picker. The test registers that folder in Maya’s workstation profile.
