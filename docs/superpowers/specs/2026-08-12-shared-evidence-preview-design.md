# Shared Evidence Preview Design

## Goal

Provide one compact, privacy-aware preview interaction anywhere CreditSync displays uploaded images or documents. Evidence-free records remain visually unchanged.

## Scope

The first release covers:

- Payment Inbox payment evidence.
- Loan disbursement evidence.
- Legacy transaction slips.
- Reconciliation uploads and transaction slips.
- Borrower ID-card images in create/edit and borrower detail views.

Financial evidence and identity documents share the preview mechanism, while labels and accessibility text remain domain-specific. Profile avatars and decorative images are not evidence and are out of scope.

## Interaction

Each available file is represented by a compact localized button such as “Preview slip,” “Preview evidence,” or “Preview ID card.” No thumbnail or reserved empty state appears in the normal layout. Multiple files render as separate ordered buttons. Evidence that is not ready may show its status but cannot be previewed.

Activating a button opens a modal and only then resolves the current authenticated access URL. JPEG and PNG files render with `object-contain`; PDFs render in an embedded frame. The modal also provides an “Open in new tab” fallback. Loading, access failure, expiration, and unsupported-type states stay inside the modal. Retrying requests a fresh URL. Closing the modal clears the resolved URL from component state.

## Shared Component

`EvidencePreviewDialog` owns modal state, lazy URL resolution, loading and error states, image/PDF rendering, retry, keyboard focus, and the optional new-tab action. Callers provide a localized label, MIME type, and a resolver callback. The component never logs URLs or file contents.

`EvidencePreviewButton` is the compact trigger wrapper used by evidence surfaces. It renders nothing when its reference is absent, preventing empty layout space.

## Data Contracts and Security

New and migrated backend presenters return a safe public file UUID or a protected access reference, never an object key, bearer token, raw identity value, or persistent signed URL. Payment-intake evidence gains `filePublicId` after tenant-scoped file lookup. Borrower detail gains the existing safe ID-card media reference needed by the preview.

Current public legacy URLs are migrated behind a resolver abstraction where a file UUID/reference is available. Existing already-resolved URLs remain supported only for legacy transaction and reconciliation contracts until their storage records can be normalized; the shared component still loads them only after an explicit click.

The existing `/files/:id/access-url` endpoint remains the authorization boundary for file UUIDs. ID-card previews use the same authenticated tenant and ownership checks as their borrower read contract. No preview request changes financial or audit state.

## Surface Behavior

- Payment Inbox: ready evidence with `filePublicId` gets “Preview slip”; pending evidence remains status-only.
- Loan disbursements: replace the new-tab-only evidence action with the shared modal trigger.
- Transactions: replace the raw legacy anchor with the shared preview trigger when `slipUrl` exists.
- Reconciliation: pending uploads and borrower transaction slips use the shared trigger when their URL exists.
- Borrower create/edit: the upload area remains optimized for selecting/replacing an image; an explicit preview button appears only after an image exists and opens the shared modal.
- Borrower detail: the contact/profile area includes “Preview ID card” only when an ID-card image exists.

## Accessibility and Localization

The trigger is a real button with a descriptive accessible name. The modal has a localized title and description, traps focus through the existing Radix dialog, closes with Escape, and returns focus to the trigger. Images receive domain-specific alt text. English and Thai keys are updated together.

## Failure Handling

URL resolution failures do not navigate away or expose internal errors. The modal shows a localized error and retry action. Popup blockers affect only the optional new-tab fallback. Unsupported MIME types receive a download/open fallback rather than being embedded.

## Testing and Verification

Test-first coverage will verify lazy resolution, no request before click, image and PDF rendering, close-state cleanup, retry, absence when no evidence exists, Payment Inbox file UUID presentation, Loan Disbursement migration, borrower ID-card availability, and localized keys. Backend presenter tests will verify safe `filePublicId`/media references and tenant isolation. Verification includes focused tests, backend typecheck and relevant disposable PostgreSQL suites, full frontend tests/lint/build, and production health after deployment.
