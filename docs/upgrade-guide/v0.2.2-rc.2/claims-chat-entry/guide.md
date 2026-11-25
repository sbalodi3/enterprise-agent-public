---
kind: upgrade-guide
description: The Claims Workbench removes the Work modes chooser and opens Agent Chat after sign-in and supports migrating employee Chat ports to a shared Workbench URL.
---

# Claims Chat entry

English | [中文](guide.zh.md)

## Change

The Claims demo opens Agent Chat after Entra Local sign-in. The Work modes chooser and its sidebar entry were removed. Legal and Finance sign-ins open their department assistant.

Claims Chat previously opened the scope picker for some portfolio questions. A list or count now runs against the employee’s authorized claims. A record-specific question sets the current claim or asks the employee to confirm a match. Saved manual selections become pins.

In shared mode, adjusters open `/chat` on the Workbench origin. Standard Chat keeps native session IDs. Image reads from a user session require a matching recorded attachment. Workspace files, executable tools and terminals use an employee volume resolved by a private manager. Text Chat, Claims Chat and Outlook use the shared application.

## Migration

1. Open the existing application bookmark or `/open-app` and sign in. Confirm the Chat composer opens.
2. Select **Workbench** in the sidebar to review claims, or navigate directly to `/open-workbench`.
3. Use **Ask agent** to open the Workbench assistant and **Open in Chat** to continue that conversation in Chat. Use **Return to chat** in the sidebar to resume the active session.
4. Ask “List all open auto claims,” then “How many of those?” Verify that the list and count cover the same filters. Use **Choose scope** to pin a claim or selected documents. When Chat asks about a match, choose **Yes**, **No**, or **Other** to continue the original request.

5. Upgrade the baseline first, then the showcase. Follow the [local deployment procedure](../../../../claims/deploy/README.md#shared-chat). An existing installation needs an employee inventory and a rollback rehearsal before activating the shared route.
6. Open an old conversation as its owner, download a migrated attachment and verify the file checksum. Check that a second employee cannot open either direct link. After a text turn, count containers with the deployment workspace label. After an approved file tool, reopen that file as its owner.
7. On the unified Podman project, sign in as Finance or Legal and open a department record from Workbench. Choose **Ask agent** and verify the shared Chat composer opens with that record selected. Previous answers for the same scope appear under **Saved Workbench answers**.
