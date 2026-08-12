# Intermediary Remittance Completion Design

## Decision

Complete the existing two-leg intermediary ledger instead of representing a grouped transfer as another borrower payment. A remittance is cash received from an intermediary; its allocations reconcile borrower collections and must never create a second repayment for a collection already linked to a posted payment intake.

## Supported paths

1. **Normal path:** capture borrower-to-intermediary collections without changing loan balances, create one remittance, attach its slip, select exact collections, preview, explicitly confirm, and atomically post the borrower payments.
2. **Historical reconciliation:** create collections linked to existing posted payment intakes. Posting the remittance settles those collections without creating new payment transactions. The linked intake amount, borrower, loan, and received timestamp must match exactly.
3. **Exceptional manual approval:** preserve the existing reasoned, tenant-admin-only path.

## Evidence

Add tenant-scoped collection/remittance evidence intents that reuse the current signed-upload lifecycle: prepare, direct PUT, finalize, inspect. Finalization verifies MIME, size, SHA-256, expiry, tenant metadata, and storage metadata. Drafts may exist without evidence, but agents must stop when the user supplied evidence and it is not `ready`. Posted/reversed financial rows and finalized evidence links are immutable.

## Interfaces

REST and MCP call the same intermediary service. MCP exposes intermediary search/list/create, collection create/list, historical-link create, remittance create/list/get, allocation save, preview, post, and evidence prepare/finalize. Reads use read-only annotations; post is destructive and requires an idempotency key plus explicit confirmation. Public schemas expose UUIDs and two-decimal strings only.

The Web UI adds a compact **Intermediary money** workspace for pending collections and remittance batches. It supports manual creation, exact selection, visible `gross - selected = remaining`, evidence upload/preview, and explicit post confirmation. Thai and English copy remain synchronized.

## Current data reconciliation

The three 180-baht slips dated 2026-08-07, 2026-08-08, and 2026-08-10 belong to the confirmed intermediary `น.ส. สุภัญญา คุณเกียรติ`. Each remittance links three exact floating-loan collections: พี่ฟ้า 60, พี่พล 75, and ป้าแจ่มวง 3,000 จำนวน 45. Existing posted payment intakes are linked historically; ready intakes are converted to collection provenance and are posted only through remittance settlement. No amount is posted twice.

## Safety and verification

All money uses `decimal.js`; all writes carry command context, correlation/request IDs, idempotency, and audit entries. Database constraints prevent duplicate evidence hashes, duplicate bank references, cross-tenant links, multiple active reservations, and mutation of posted rows. Tests cover the historical no-double-post path, exact allocation, stale preview, evidence lifecycle, REST/MCP contracts, localized UI, and disposable PostgreSQL financial invariants.
