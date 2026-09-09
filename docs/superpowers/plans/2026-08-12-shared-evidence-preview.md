# Shared Evidence Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one compact click-to-preview modal for every uploaded financial-evidence and borrower ID-card surface without reserving page space when no file exists.

**Architecture:** A shared `EvidencePreviewButton` owns lazy resolution and delegates rendering to the existing Radix dialog. File-backed records resolve an authenticated access descriptor (`url`, `mimeType`) only after click; legacy resolved references use a resolver callback with the same interface. Backend presenters add safe file UUIDs where Payment Inbox currently exposes only evidence-intent UUIDs.

**Tech Stack:** React 19, TypeScript 6, Radix Dialog, Tailwind CSS, i18next, Elysia, Drizzle ORM, PostgreSQL, Vitest, Testing Library, Bun

## Global Constraints

- Never log or persist signed URLs, object keys, raw identity-card values, file contents, or bearer tokens.
- Render no preview trigger or empty placeholder when a file reference is absent.
- Resolve protected URLs only after explicit user interaction and clear them when the modal closes.
- Support JPEG/PNG images and PDFs; unsupported types receive an open-in-new-tab fallback.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together.
- Preserve tenant and ownership checks at the existing file-access and borrower-read boundaries.
- Keep financial and posted records immutable; preview is read-only.

---

### Task 1: Shared lazy evidence-preview component

**Files:**
- Create: `frontend/src/components/evidence/EvidencePreviewButton.tsx`
- Create: `frontend/tests/evidence-preview-button.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`

**Interfaces:**
- Consumes: `label: string`, `mimeType?: string | null`, and `resolve: () => Promise<{ url: string; mimeType?: string | null }>`.
- Produces: `EvidencePreviewButton` that renders a compact trigger and a lazy modal with image/PDF/fallback, retry, close cleanup, and new-tab fallback.

- [ ] Write a rendered-component test asserting the resolver is not called before click, is called once after click, renders an image for `image/jpeg`, clears content on close, retries after rejection, renders an iframe for PDF, and renders no component when `available={false}`.
- [ ] Run `cd frontend && bun run test tests/evidence-preview-button.vitest.tsx`; expect failure because the component does not exist.
- [ ] Implement the component with `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `Button`, `Eye`, `ExternalLink`, `RefreshCw`, and state `{ open, loading, descriptor, error }`; clear descriptor/error in `onOpenChange(false)`.
- [ ] Add localized shared keys: `evidence.preview`, `evidence.loading`, `evidence.failed`, `evidence.retry`, `evidence.openNewTab`, `evidence.imageAlt`, and `evidence.documentTitle` in English and Thai.
- [ ] Re-run the focused test; expect all shared interaction branches to pass.
- [ ] Commit with `feat: add shared evidence preview dialog` after updating the current changelog entry.

### Task 2: Authenticated file access descriptors

**Files:**
- Modify: `backend/src/modules/files.ts`
- Modify: `backend/src/modules/files.test.ts`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/tests/loan-disbursement-flow.vitest.tsx`

**Interfaces:**
- Consumes: authenticated public file UUID.
- Produces: `GET /files/:id/access-url` response `{ url: string, mimeType: string | null }` and `resolveFileAccess(filePublicId): Promise<{ url: string; mimeType: string | null }>`; retain `resolveFileAccessUrl` as a compatibility wrapper until all callers migrate.

- [ ] Extend the backend file-access test to expect the tenant-owned record’s MIME type and ensure cross-tenant access remains 404.
- [ ] Run the focused backend test through the disposable PostgreSQL script; expect the MIME assertion to fail.
- [ ] Add `mimeType: fileRecord.mimeType ?? null` to the authorized response and implement the frontend descriptor helper.
- [ ] Update the existing disbursement test mock shape without changing behavior.
- [ ] Re-run focused backend and frontend tests; expect pass.
- [ ] Commit with `feat: return safe evidence access descriptors`.

### Task 3: Payment Inbox evidence references and preview

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/services/payment-service.test.ts`
- Modify: `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`
- Modify: `frontend/tests/payment-inbox.vitest.tsx`

**Interfaces:**
- Produces payment evidence `{ publicId, status, mimeType, filePublicId }`, where `filePublicId` is a tenant-scoped public UUID or null.
- Uses `EvidencePreviewButton` with `resolveFileAccess(filePublicId)` only for `status === "ready"`.

- [ ] Add a service test proving detail presentation returns the ready file UUID and never a storage key/URL.
- [ ] Add a UI test that selects an intake with ready evidence, clicks localized preview, and asserts file resolution occurs only after click; pending/null-file evidence remains status-only.
- [ ] Run both focused tests and observe the missing `filePublicId`/preview failures.
- [ ] Join each evidence row to its tenant-owned file during detail presentation, return `filePublicId`, and replace the raw UUID-only evidence row with metadata plus `EvidencePreviewButton`.
- [ ] Run focused tests until green.
- [ ] Commit with `feat: preview payment inbox evidence`.

### Task 4: Loan disbursement evidence migration

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanDisbursements.tsx`
- Modify: `frontend/tests/loan-disbursement-flow.vitest.tsx`

**Interfaces:**
- Replaces popup-first `openEvidence` with `EvidencePreviewButton` and `resolveFileAccess`.

- [ ] Rewrite the existing evidence test to assert no descriptor request before click and an in-page preview after click.
- [ ] Run the focused test; expect failure against popup-only behavior.
- [ ] Remove popup state/handler and render the shared button for every `evidenceFilePublicId`.
- [ ] Re-run focused tests; expect pass.
- [ ] Commit with `refactor: unify disbursement evidence preview`.

### Task 5: Legacy transaction and reconciliation previews

**Files:**
- Modify: `frontend/src/pages/dashboard/transactions/TransactionList.tsx`
- Modify: `frontend/src/pages/dashboard/reconciliation/ReconciliationPage.tsx`
- Create: `frontend/tests/legacy-evidence-previews.vitest.tsx`

**Interfaces:**
- Uses resolver callbacks returning the legacy click-scoped URL and inferred MIME (`application/pdf` for `.pdf`, otherwise `image/*`/unknown fallback).

- [ ] Add rendered tests showing no trigger for null slips, a compact trigger for transaction slips, and preview triggers for reconciliation pending uploads and borrower transaction slips.
- [ ] Run the test; expect failure because both pages use raw anchors or omit available slips.
- [ ] Replace raw anchors with shared preview buttons and add the missing borrower-transaction preview action.
- [ ] Re-run focused tests; expect pass.
- [ ] Commit with `feat: preview legacy transaction evidence`.

### Task 6: Borrower ID-card previews

**Files:**
- Modify: `frontend/src/pages/dashboard/borrowers/BorrowerForm.tsx`
- Modify: `frontend/src/pages/dashboard/borrowers/BorrowerDetail.tsx`
- Modify: `frontend/tests/borrower-detail.vitest.tsx`
- Create: `frontend/tests/borrower-id-card-preview.vitest.tsx`

**Interfaces:**
- Uses `idCardImageUrl` only as a click-scoped resolver result and `idCardImageRef` as the persisted storage reference; never renders the raw identity-card number in preview metadata.

- [ ] Extend borrower fixtures with/without `idCardImageUrl` and assert the detail trigger appears only when present and opens the shared image modal.
- [ ] Add a form test asserting an uploaded/existing ID-card image provides a compact preview action without changing the upload control.
- [ ] Run focused tests; expect missing-trigger failures.
- [ ] Add ID-card media fields to the detail interface and render shared preview triggers in detail and form with localized privacy-aware labels.
- [ ] Re-run focused tests; expect pass.
- [ ] Commit with `feat: preview borrower identity images`.

### Task 7: Cross-surface verification and release record

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` only if operator/user workflow wording is needed after final review.

**Interfaces:**
- Produces one verified release change set and synchronized documentation.

- [ ] Consolidate changelog bullets under `v0.3.10` into concise `Added`/`Changed` entries describing the shared component, safe backend references, and migrated surfaces.
- [ ] Run `backend/scripts/test-disposable-postgres.sh backend/src/modules/files.test.ts backend/src/services/payment-service.test.ts` (or the script’s supported focused invocation) and `cd backend && bun run typecheck`.
- [ ] Run `cd frontend && bun run test && bun run lint && bun run build`.
- [ ] Inspect `git diff --check`, verify no signed URLs/secrets/object keys were added to logs or public DTOs, and confirm English/Thai key parity.
- [ ] Commit with `feat: add app-wide evidence previews` if verification/documentation changes remain.
- [ ] Merge to `main`, rerun affected frontend/backend checks on the merged tree, deploy with production Docker Compose, verify backend MCP health and public frontend HTTP 200, and visually inspect the Payment Inbox preview trigger.
