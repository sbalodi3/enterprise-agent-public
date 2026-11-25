---
kind: upgrade-guide
description: Connected wage requests require employee approval before partner dispatch.
---

# Approve wage requests before sending

English | [中文](guide.zh.md)

## Change

In the connected showcase, `POST /claims/api/wages` now returns a pending proposal. An authorized employee approves the exact disclosure before a worker contacts the synthetic Amazon partner. Filing returned evidence requires a second review. Workbench and Chat share both reviews.

## Migration

1. Rebuild the connected showcase with your usual dataset flags. Keep its named volumes. Workbench applies migration 019 and mock Juris imports any missing CMS records.
2. Update callers to display the returned proposal. Submit the employee’s decision, proposal version and digest to `POST /claims/api/proposals/{id}/review`. Check the resulting operation for its destination receipt.
3. In **Reviews**, check the outgoing recipient and dates, release the local partner result, then inspect the separate filing proposal. Existing partner tasks retain their original IDs. Recovery uses registration lookup.
