---
kind: upgrade-guide
description: The local claims workbench switches employee sign-in from Keycloak passwords to the Entra Local account picker.
---

# Sign in to the claims workbench with Entra Local

English | [中文](guide.zh.md)

## Change

The baseline and showcase use a tenant-specific Entra Local issuer. Each synthetic account maps to its existing PostgreSQL employee and workspace.

## Migration

1. Run `node claims/deploy/up.mjs` with your usual profiles. For the showcase run `node claims/showcase/launch.mjs` once before using `--offline`. Both launchers translate their generated issuer settings and stop the old project's Keycloak container. Keep the existing volumes.
2. Open the workbench and choose an employee by name. Existing sessions require a new sign-in.
3. Open the employee's portfolio. Verify every account using `node claims/auth/tests/entra.browser.mjs` or `node claims/auth/tests/entra.browser.mjs --showcase`.
