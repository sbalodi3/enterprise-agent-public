# Desktop startup and outbound traffic

The Enterprise Agent workstation companion served its signed-out entry page and stayed healthy for 40 seconds of idle time. Its observed Node network traffic went to the private harness host on loopback. The upstream Electron desktop has a separate analytics path. A stock telemetry integration test delivered a synthetic launch event with machine metadata to a local collector. A packaged Electron startup remains unverified.

## Enterprise Agent workstation companion

The exercise ran the [real launcher](../runtime/launch.mjs) with a fresh synthetic employee home and an empty shared agents directory, with model, session-export and product-export URLs pointing to a loopback HTTP recorder. The existing companion already occupied port 3081. The test assigned the new gateway an ephemeral loopback port at the same HTTP listener seam used by the [gateway integration test](../tests/desktop-chat-gateway.test.mjs). Requests retained the expected `Host: localhost:3081`. The original listener had the same process ID before and after the run.

| Evidence | Observation |
| --- | --- |
| Network enforcement | The parent and child processes inherited a macOS sandbox policy denying remote IP connections except loopback. A Node preload recorded destinations for socket connections, common DNS lookup/resolve calls and Undici HTTP/connection events. Paths, queries, credentials, headers and bodies were excluded. |
| Positive control | A fixture issued a localhost lookup and fetched the recorder. DNS, HTTP and TCP observers registered the events and the receiver recorded one GET. Counters were reset before companion startup. |
| Signed-out routes | `GET /` returned 303, `GET /desktop/presence` with the application origin returned 204 and `GET /api` returned 401. The client did not follow the sign-in redirect. |
| Startup, 40 seconds idle and shutdown | The companion stayed alive until stopped. The model/export recorder received zero requests. The observers recorded two lookup API calls for the numeric loopback address and one outbound HTTP request/connection to `127.0.0.1`. The [gateway pairs with its private native host](../desktop-chat/gateway.mjs) during startup. The lookup calls do not establish that a DNS packet reached a resolver. |

This exercise covers unauthenticated startup and idle on the workstation, with traffic observed above the native socket layer and external IP connections blocked. Coverage excludes arbitrary native code, system resolver activity outside the instrumented processes, signed-in workstation use, and user-invoked web, plugin or shell tools. The [security audit](security-audit.md) covers the other tested profiles.

## Upstream Electron desktop

The checkout contains built JavaScript for the shell and host. Its Electron npm package was missing the executable, `path.txt`, and `dist/Electron.app`. There was no matching desktop installation or download in the checked application and Electron cache locations. Resolving the upstream Electron package attempted its install fallback and failed during module loading, before obtaining a binary. The following tests used the installed checkout and local receivers.

| Evidence | Observation |
| --- | --- |
| Launch trigger in source | The [desktop main process](../../apps/desktop/src/main.ts) submits one `desktop_app_launch` event on host readiness through its analytics path. Stock desktop analytics defaults to enabled and the package documents no user-facing control. The [exporter](../../packages/host/product-telemetry-otel/src/index.ts) defaults to the vendor collector at `dsh-otel-collector.deepseeksvc.com`. [Collection policy](../../packages/client/product-analytics/README.md) |
| Local receiver evidence | Five [exporter](../../packages/host/product-telemetry-otel/tests/loader-composition.e2e.ts) and [machine-environment](../../packages/client/product-analytics/tests/environment-composition.host.e2e.ts) composition cases passed with external IP connections blocked. The environment fixture explicitly submits a synthetic launch event through the real host implementation and verifies one captured event, application version, OS and processor metadata. Its test context has no user or device identifiers. |
| Shell behavior | All 187 [main startup](../../apps/desktop/tests/main-startup.spec.ts) and [welcome startup](../../apps/desktop/tests/welcome-startup.spec.ts) cases passed. They exercise the main-process application code with mocked Electron APIs. |

The local event capture establishes what the stock analytics path can send. No full Electron GUI process, packaged updater, on-screen consent interaction, or 40-second packaged-shell idle trace was observed. The workstation companion uses the Enterprise Agent web launcher with stock product analytics disabled.
