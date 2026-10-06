# MCP tool guide

Generated from the serving backend catalog and exhaustive guidance registry. This document describes metadata and does not authorize execution.

Catalog version: `mcp-catalog-d816cad8ed74b1d2`
Guidance version: `mcp-guidance-fca8a5359b51fcd4`
Tool count: 147

## `borrower.search`

**Description:** Search accessible borrowers by canonical name or confirmed alias. Use: Use when the authorized workflow requires this capability: Search accessible borrowers by canonical name or confirmed alias. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Search accessible borrowers by canonical name or confirmed alias.

**Profiles:** full, core-read, payments, loans, disbursements, admin, discovery

**When to use:** Use when the authorized workflow requires this capability: Search accessible borrowers by canonical name or confirmed alias. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `borrower.portfolio`

**Description:** Get one accessible borrower portfolio by public UUID. Use: Use when the authorized workflow requires this capability: Get one accessible borrower portfolio by public UUID. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Get one accessible borrower portfolio by public UUID.

**Profiles:** full, core-read, payments, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: Get one accessible borrower portfolio by public UUID. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `borrower.resolve-and-portfolio`

**Description:** Resolve one borrower without auto-selecting ambiguity and return a bounded portfolio. Use: Use when the authorized workflow requires this capability: Resolve one borrower without auto-selecting ambiguity and return a bounded portfolio. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Resolve one borrower without auto-selecting ambiguity and return a bounded portfolio.

**Profiles:** full, core-read, payments, loans, disbursements, discovery

**When to use:** Use when the authorized workflow requires this capability: Resolve one borrower without auto-selecting ambiguity and return a bounded portfolio. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Supply exactly one of query or borrowerPublicId; an ambiguous query returns candidates and requires a human to identify the borrower.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `borrower.create`

**Description:** Create a borrower in the configured MCP tenant. Use: Use when the authorized workflow requires this capability: Create a borrower in the configured MCP tenant. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Create a borrower in the configured MCP tenant.

**Profiles:** full, admin

**When to use:** Use when the authorized workflow requires this capability: Create a borrower in the configured MCP tenant. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `borrower.update`

**Description:** Update an accessible borrower by public UUID. Use: Use when the authorized workflow requires this capability: Update an accessible borrower by public UUID. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Update an accessible borrower by public UUID.

**Profiles:** full, admin

**When to use:** Use when the authorized workflow requires this capability: Update an accessible borrower by public UUID. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `borrower.alias`

**Description:** Add, confirm, or deactivate a borrower alias. Use: Use when the authorized workflow requires this capability: Add, confirm, or deactivate a borrower alias. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Add, confirm, or deactivate a borrower alias.

**Profiles:** full, admin

**When to use:** Use when the authorized workflow requires this capability: Add, confirm, or deactivate a borrower alias. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** For action add, provide borrowerPublicId and alias. For confirm or deactivate, provide aliasPublicId.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intake.get`

**Description:** Get a payment intake, evidence, and latest proposal. Use: Use when the authorized workflow requires this capability: Get a payment intake, evidence, and latest proposal. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Get a payment intake, evidence, and latest proposal.

**Profiles:** full, core-read, payments, discovery

**When to use:** Use when the authorized workflow requires this capability: Get a payment intake, evidence, and latest proposal. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.preview, payment.post, payment.cancel, payment.reverse, payment.match-context, intake.create

## `intake.list`

**Description:** List accessible payment intakes, optionally by status. Use: Use when the authorized workflow requires this capability: List accessible payment intakes, optionally by status. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List accessible payment intakes, optionally by status.

**Profiles:** full, core-read, payments

**When to use:** Use when the authorized workflow requires this capability: List accessible payment intakes, optionally by status. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.get`

**Description:** Inspect an atomic payment batch and its latest preview. Use: Use when the authorized workflow requires this capability: Inspect an atomic payment batch and its latest preview. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Inspect an atomic payment batch and its latest preview.

**Profiles:** full, core-read, payments

**When to use:** Use when the authorized workflow requires this capability: Inspect an atomic payment batch and its latest preview. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.stage`

**Description:** Create resumable payment-batch staging items without inventing amount or transfer time. Use: Use when the authorized workflow requires this capability: Create resumable payment-batch staging items without inventing amount or transfer time. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Create resumable payment-batch staging items without inventing amount or transfer time.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Create resumable payment-batch staging items without inventing amount or transfer time. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.staging.evidence.prepare`

**Description:** Prepare upload-first evidence for one resumable staging item. Use: Use when the authorized workflow requires this capability: Prepare upload-first evidence for one resumable staging item. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Prepare upload-first evidence for one resumable staging item.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Prepare upload-first evidence for one resumable staging item. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.staging.evidence.finalize`

**Description:** Finalize upload-first evidence for one resumable staging item. Use: Use when the authorized workflow requires this capability: Finalize upload-first evidence for one resumable staging item. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Finalize upload-first evidence for one resumable staging item.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Finalize upload-first evidence for one resumable staging item. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.staging.extract`

**Description:** Extract review-only payment-slip candidates from finalized staging evidence using the local OCR pipeline. Use: Use when the authorized workflow requires this capability: Extract review-only payment-slip candidates from finalized staging evidence using the local OCR pipeline. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Extract review-only payment-slip candidates from finalized staging evidence using the local OCR pipeline.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Extract review-only payment-slip candidates from finalized staging evidence using the local OCR pipeline. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.workspace`

**Description:** Inspect resumable batch staging metadata and public evidence status. Use: Use when the authorized workflow requires this capability: Inspect resumable batch staging metadata and public evidence status. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Inspect resumable batch staging metadata and public evidence status.

**Profiles:** full, core-read, payments

**When to use:** Use when the authorized workflow requires this capability: Inspect resumable batch staging metadata and public evidence status. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.candidates`

**Description:** Discover accessible named borrowers and backend-calculated contract candidates for one reviewed staging slip. Use: Use when the authorized workflow requires this capability: Discover accessible named borrowers and backend-calculated contract candidates for one reviewed staging slip. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Discover accessible named borrowers and backend-calculated contract candidates for one reviewed staging slip.

**Profiles:** full, core-read, payments

**When to use:** Use when the authorized workflow requires this capability: Discover accessible named borrowers and backend-calculated contract candidates for one reviewed staging slip. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.staging.review`

**Description:** Review one staged payment item and create its linked intake. Use: Use when the authorized workflow requires this capability: Review one staged payment item and create its linked intake. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Review one staged payment item and create its linked intake.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Review one staged payment item and create its linked intake. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.staging.edit`

**Description:** Edit one unposted staged payment item with revision and reason guards. Use: Use when the authorized workflow requires this capability: Edit one unposted staged payment item with revision and reason guards. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Edit one unposted staged payment item with revision and reason guards.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Edit one unposted staged payment item with revision and reason guards. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.split`

**Description:** Move selected unposted batch membership atomically into a new batch. Use: Use when the authorized workflow requires this capability: Move selected unposted batch membership atomically into a new batch. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Move selected unposted batch membership atomically into a new batch.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Move selected unposted batch membership atomically into a new batch. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.decision`

**Description:** Record a revision-bound chronology review decision for a batch. Use: Use when the authorized workflow requires this capability: Record a revision-bound chronology review decision for a batch. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Record a revision-bound chronology review decision for a batch.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Record a revision-bound chronology review decision for a batch. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.cancel`

**Description:** Cancel an unposted batch with a revision-bound idempotent command. Use: Use when the authorized workflow requires this capability: Cancel an unposted batch with a revision-bound idempotent command. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Cancel an unposted batch with a revision-bound idempotent command.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Cancel an unposted batch with a revision-bound idempotent command. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intake.create`

**Description:** Create an idempotent payment intake from supplied payment data. Use: Use when the authorized workflow requires this capability: Create an idempotent payment intake from supplied payment data. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Create an idempotent payment intake from supplied payment data.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Create an idempotent payment intake from supplied payment data. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.preview, payment.post, payment.cancel, payment.reverse, payment.match-context, intake.get

## `evidence.prepare`

**Description:** Prepare a signed upload for payment evidence. Use: Use when the authorized workflow requires this capability: Prepare a signed upload for payment evidence. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Prepare a signed upload for payment evidence.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Prepare a signed upload for payment evidence. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `evidence.finalize`

**Description:** Verify and finalize uploaded payment evidence. Use: Use when the authorized workflow requires this capability: Verify and finalize uploaded payment evidence. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Verify and finalize uploaded payment evidence.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Verify and finalize uploaded payment evidence. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `evidence.import-chatgpt-file`

**Description:** Import one attached ChatGPT file as verified payment evidence. Use: Use when the authorized workflow requires this capability: Import one attached ChatGPT file as verified payment evidence. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Import one attached ChatGPT file as verified payment evidence.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Import one attached ChatGPT file as verified payment evidence. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `loan.disbursement.evidence.import-chatgpt-file`

**Description:** Import one attached ChatGPT file as ready evidence for an exact loan disbursement draft. Use: Use when the authorized workflow requires this capability: Import one attached ChatGPT file as ready evidence for an exact loan disbursement draft. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Import one attached ChatGPT file as ready evidence for an exact loan disbursement draft.

**Profiles:** full, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: Import one attached ChatGPT file as ready evidence for an exact loan disbursement draft. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.evidence-supplement.import-chatgpt-file`

**Description:** Import one attached ChatGPT file as ready supplemental evidence for an exact posted payment. Use: Use when the authorized workflow requires this capability: Import one attached ChatGPT file as ready supplemental evidence for an exact posted payment. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Import one attached ChatGPT file as ready supplemental evidence for an exact posted payment.

**Profiles:** full, payments, loans

**When to use:** Use when the authorized workflow requires this capability: Import one attached ChatGPT file as ready supplemental evidence for an exact posted payment. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.evidence-supplement.record`

**Description:** Record ready supplemental evidence after explicit operator confirmation. Use: Use when the authorized workflow requires this capability: Record ready supplemental evidence after explicit operator confirmation. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Record ready supplemental evidence after explicit operator confirmation.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Record ready supplemental evidence after explicit operator confirmation. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `payment.preview`

**Description:** Preview and persist a versioned payment match proposal. Use: Use when the authorized workflow requires this capability: Preview and persist a versioned payment match proposal. Effects: Persists a payment.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview and persist a versioned payment match proposal.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Preview and persist a versioned payment match proposal. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a payment.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.post, payment.cancel, payment.reverse, payment.match-context, intake.get, intake.create

## `payment.cancel`

**Description:** Cancel an authorized unposted payment intake with an immutable receipt. Use: Use when the authorized workflow requires this capability: Cancel an authorized unposted payment intake with an immutable receipt. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Cancel an authorized unposted payment intake with an immutable receipt.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Cancel an authorized unposted payment intake with an immutable receipt. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** payment.preview, payment.post, payment.reverse, payment.match-context, intake.get, intake.create

## `payment.replacement.inspect`

**Description:** Inspect whether an accessible cancelled payment can receive one append-only replacement draft. Use: Use when the authorized workflow requires this capability: Inspect whether an accessible cancelled payment can receive one append-only replacement draft. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Inspect whether an accessible cancelled payment can receive one append-only replacement draft.

**Profiles:** full, core-read, payments

**When to use:** Use when the authorized workflow requires this capability: Inspect whether an accessible cancelled payment can receive one append-only replacement draft. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.replacement.create, payment.replacement.duplicate-review.preview, payment.replacement.duplicate-review.execute, payment.evidence-recovery.preview, payment.evidence-recovery.execute

## `payment.replacement.create`

**Description:** Create one audited draft replacement for an eligible cancelled payment without posting money. Use: Use when the authorized workflow requires this capability: Create one audited draft replacement for an eligible cancelled payment without posting money. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Create one audited draft replacement for an eligible cancelled payment without posting money.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Create one audited draft replacement for an eligible cancelled payment without posting money. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** The source payment must be cancelled and eligible for an unposted replacement.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** payment.replacement.inspect, payment.replacement.duplicate-review.preview, payment.replacement.duplicate-review.execute, payment.evidence-recovery.preview, payment.evidence-recovery.execute

## `payment.replacement.duplicate-review.preview`

**Description:** Preview and durably record an exact, tenant-scoped human review for cancelled semantic payment duplicates without changing money. Use: Use when the authorized workflow requires this capability: Preview and durably record an exact, tenant-scoped human review for cancelled semantic payment duplicates without changing money. Effects: Persists a payment.replacement.duplicate-review.preview review artifact; it does not perform the later financial execution. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Preview and durably record an exact, tenant-scoped human review for cancelled semantic payment duplicates without changing money.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Preview and durably record an exact, tenant-scoped human review for cancelled semantic payment duplicates without changing money. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a payment.replacement.duplicate-review.preview review artifact; it does not perform the later financial execution.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.replacement.inspect, payment.replacement.create, payment.replacement.duplicate-review.execute, payment.evidence-recovery.preview, payment.evidence-recovery.execute

## `payment.replacement.duplicate-review.execute`

**Description:** Execute a confirmed, fresh, idempotent duplicate review that authorizes only its exact cancelled candidates for replacement lineage. Use: Use when the authorized workflow requires this capability: Execute a confirmed, fresh, idempotent duplicate review that authorizes only its exact cancelled candidates for replacement lineage. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute a confirmed, fresh, idempotent duplicate review that authorizes only its exact cancelled candidates for replacement lineage.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Execute a confirmed, fresh, idempotent duplicate review that authorizes only its exact cancelled candidates for replacement lineage. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** payment.replacement.inspect, payment.replacement.create, payment.replacement.duplicate-review.preview, payment.evidence-recovery.preview, payment.evidence-recovery.execute

## `payment.identity-decision.preview`

**Description:** Preview and audit an exact participant-scoped same-payment or distinct-payment identity decision. Use: Use when the authorized workflow requires this capability: Preview and audit an exact participant-scoped same-payment or distinct-payment identity decision. Effects: Persists a payment.identity-decision.preview review artifact; it does not perform the later financial execution. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Preview and audit an exact participant-scoped same-payment or distinct-payment identity decision.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Preview and audit an exact participant-scoped same-payment or distinct-payment identity decision. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a payment.identity-decision.preview review artifact; it does not perform the later financial execution.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.identity-decision.execute`

**Description:** Execute a confirmed identity decision after snapshot and evidence revalidation. Use: Use when the authorized workflow requires this capability: Execute a confirmed identity decision after snapshot and evidence revalidation. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute a confirmed identity decision after snapshot and evidence revalidation.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Execute a confirmed identity decision after snapshot and evidence revalidation. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `payment.evidence-recovery.preview`

**Description:** Preview an explicit evidence recovery successor while preserving the source requirement floor and provenance. Use: Use when the authorized workflow requires this capability: Preview an explicit evidence recovery successor while preserving the source requirement floor and provenance. Effects: Persists a payment.evidence-recovery.preview review artifact; it does not perform the later financial execution. Retry: Retry with the same idempotency key and identical arguments; inspect the existing preview before changing a request. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Preview an explicit evidence recovery successor while preserving the source requirement floor and provenance.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Preview an explicit evidence recovery successor while preserving the source requirement floor and provenance. If expectedCount is below the inherited requirement floor, requirementDecision.confirmed=true and a reason are required; ordinary previews do not require post approval.

**Prerequisites:** Authenticated tenant scope, current target state, and an idempotency key.

**Effects:** Persists a payment.evidence-recovery.preview review artifact; it does not perform the later financial execution.

**Retry:** Retry with the same idempotency key and identical arguments; inspect the existing preview before changing a request.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** payment.replacement.inspect, payment.replacement.create, payment.replacement.duplicate-review.preview, payment.replacement.duplicate-review.execute, payment.evidence-recovery.execute

## `payment.evidence-recovery.execute`

**Description:** Execute a confirmed evidence recovery draft with immutable lineage and an idempotent receipt. Use: Use when the authorized workflow requires this capability: Execute a confirmed evidence recovery draft with immutable lineage and an idempotent receipt. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute a confirmed evidence recovery draft with immutable lineage and an idempotent receipt.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Execute a confirmed evidence recovery draft with immutable lineage and an idempotent receipt. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** payment.replacement.inspect, payment.replacement.create, payment.replacement.duplicate-review.preview, payment.replacement.duplicate-review.execute, payment.evidence-recovery.preview

## `payment.post`

**Description:** Post a ready payment proposal atomically. Use: Use when the authorized workflow requires this capability: Post a ready payment proposal atomically. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry the same operation with identical valid arguments; its input schema has no idempotency key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Post a ready payment proposal atomically.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Post a ready payment proposal atomically. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry the same operation with identical valid arguments; its input schema has no idempotency key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** payment.preview, payment.cancel, payment.reverse, payment.match-context, intake.get, intake.create

## `payment.reverse`

**Description:** Reverse a posted payment with compensating entries. Use: Use when the authorized workflow requires this capability: Reverse a posted payment with compensating entries. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry the same operation with identical valid arguments; its input schema has no idempotency key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Reverse a posted payment with compensating entries.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Reverse a posted payment with compensating entries. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry the same operation with identical valid arguments; its input schema has no idempotency key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** payment.preview, payment.post, payment.cancel, payment.match-context, intake.get, intake.create

## `payment.reverse-with-accrual.preview`

**Description:** Preview reversing a floating-loan payment and materializing missing interest accruals through the original payment date. Use: Use when the authorized workflow requires this capability: Preview reversing a floating-loan payment and materializing missing interest accruals through the original payment date. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Preview reversing a floating-loan payment and materializing missing interest accruals through the original payment date.

**Profiles:** full, core-read, payments

**When to use:** Use when the authorized workflow requires this capability: Preview reversing a floating-loan payment and materializing missing interest accruals through the original payment date. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.reverse-with-accrual.execute`

**Description:** Execute a confirmed atomic payment reversal with floating interest accrual materialization. Use: Use when the authorized workflow requires this capability: Execute a confirmed atomic payment reversal with floating interest accrual materialization. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute a confirmed atomic payment reversal with floating interest accrual materialization.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Execute a confirmed atomic payment reversal with floating interest accrual materialization. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `payment.batch.create`

**Description:** Create an editable atomic payment batch. Use: Use when the authorized workflow requires this capability: Create an editable atomic payment batch. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Create an editable atomic payment batch.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Create an editable atomic payment batch. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.capture`

**Description:** Capture multiple payment intakes and batch items atomically. Use: Use when the authorized workflow requires this capability: Capture multiple payment intakes and batch items atomically. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Capture multiple payment intakes and batch items atomically.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Capture multiple payment intakes and batch items atomically. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.evidence.prepare-many`

**Description:** Prepare evidence for multiple payment batch items. Use: Use when the authorized workflow requires this capability: Prepare evidence for multiple payment batch items. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Prepare evidence for multiple payment batch items.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Prepare evidence for multiple payment batch items. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.evidence.finalize-many`

**Description:** Finalize evidence for multiple payment batch items. Use: Use when the authorized workflow requires this capability: Finalize evidence for multiple payment batch items. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Finalize evidence for multiple payment batch items.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Finalize evidence for multiple payment batch items. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.item.add`

**Description:** Add one payment intake to an atomic batch. Use: Use when the authorized workflow requires this capability: Add one payment intake to an atomic batch. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Add one payment intake to an atomic batch.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Add one payment intake to an atomic batch. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.evidence.prepare`

**Description:** Prepare evidence for a payment batch item. Use: Use when the authorized workflow requires this capability: Prepare evidence for a payment batch item. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Prepare evidence for a payment batch item.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Prepare evidence for a payment batch item. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.evidence.finalize`

**Description:** Finalize evidence for a payment batch item. Use: Use when the authorized workflow requires this capability: Finalize evidence for a payment batch item. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Finalize evidence for a payment batch item.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Finalize evidence for a payment batch item. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.preview`

**Description:** Preview the complete atomic payment batch allocation. Use: Use when the authorized workflow requires this capability: Preview the complete atomic payment batch allocation. Effects: Persists a payment.batch.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview the complete atomic payment batch allocation.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Preview the complete atomic payment batch allocation. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a payment.batch.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.batch.execute`

**Description:** Execute one explicitly confirmed atomic payment batch. Use: Use when the authorized workflow requires this capability: Execute one explicitly confirmed atomic payment batch. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute one explicitly confirmed atomic payment batch.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Execute one explicitly confirmed atomic payment batch. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `payment.reconcile.preview`

**Description:** Preview an interest-only posting for a reviewed historical needs_review payment intake without reducing principal. Use: Use when the authorized workflow requires this capability: Preview an interest-only posting for a reviewed historical needs_review payment intake without reducing principal. Effects: Persists a payment.reconcile.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview an interest-only posting for a reviewed historical needs_review payment intake without reducing principal.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Preview an interest-only posting for a reviewed historical needs_review payment intake without reducing principal. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a payment.reconcile.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.reconcile.reflow.preview`

**Description:** Preview an append-only temporal repair for an existing executed reconciliation with complete floating-interest provenance. Use: Use when the authorized workflow requires this capability: Preview an append-only temporal repair for an existing executed reconciliation with complete floating-interest provenance. Effects: Persists a payment.reconcile.reflow.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview an append-only temporal repair for an existing executed reconciliation with complete floating-interest provenance.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Preview an append-only temporal repair for an existing executed reconciliation with complete floating-interest provenance. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a payment.reconcile.reflow.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.reconcile.reflow.execute`

**Description:** Execute a confirmed idempotent temporal repair for an existing reconciliation. Use: Use when the authorized workflow requires this capability: Execute a confirmed idempotent temporal repair for an existing reconciliation. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute a confirmed idempotent temporal repair for an existing reconciliation.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Execute a confirmed idempotent temporal repair for an existing reconciliation. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `payment.allocation-correction.preview`

**Description:** Preview moving one posted scheduled repayment to another installment of the same active loan with exact component conservation. Use: Use when the authorized workflow requires this capability: Preview moving one posted scheduled repayment to another installment of the same active loan with exact component conservation. Effects: Persists a payment.allocation-correction.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview moving one posted scheduled repayment to another installment of the same active loan with exact component conservation.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Preview moving one posted scheduled repayment to another installment of the same active loan with exact component conservation. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a payment.allocation-correction.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.reconcile.preflight`

**Description:** Run a no-write execution feasibility check for an explicit payment reconciliation before confirmation. Use: Use when the authorized workflow requires this capability: Run a no-write execution feasibility check for an explicit payment reconciliation before confirmation. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Run a no-write execution feasibility check for an explicit payment reconciliation before confirmation.

**Profiles:** full, core-read, payments

**When to use:** Use when the authorized workflow requires this capability: Run a no-write execution feasibility check for an explicit payment reconciliation before confirmation. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.reconcile.mark-review`

**Description:** Move an eligible ready backdated floating payment into reconciliation review after explicit confirmation. Use: Use when the authorized workflow requires this capability: Move an eligible ready backdated floating payment into reconciliation review after explicit confirmation. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Move an eligible ready backdated floating payment into reconciliation review after explicit confirmation.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Move an eligible ready backdated floating payment into reconciliation review after explicit confirmation. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.reconcile.execute`

**Description:** Execute a confirmed, idempotent payment reconciliation with append-only provenance. Use: Use when the authorized workflow requires this capability: Execute a confirmed, idempotent payment reconciliation with append-only provenance. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute a confirmed, idempotent payment reconciliation with append-only provenance.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Execute a confirmed, idempotent payment reconciliation with append-only provenance. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `payment.allocation-correction.execute`

**Description:** Execute a confirmed, idempotent append-only scheduled payment allocation correction. Use: Use when the authorized workflow requires this capability: Execute a confirmed, idempotent append-only scheduled payment allocation correction. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute a confirmed, idempotent append-only scheduled payment allocation correction.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Execute a confirmed, idempotent append-only scheduled payment allocation correction. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `payment.restore.create`

**Description:** Create one linked restore draft so new payment-slip evidence can be finalized before an exact restore preview. Use: Use when the authorized workflow requires this capability: Create one linked restore draft so new payment-slip evidence can be finalized before an exact restore preview. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Create one linked restore draft so new payment-slip evidence can be finalized before an exact restore preview.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Create one linked restore draft so new payment-slip evidence can be finalized before an exact restore preview. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** The source payment must be in the reversed state and eligible for restoration.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.restore.evidence.prepare, payment.restore.evidence.finalize, payment.restore.preview, payment.restore.execute, payment.restore.cancel, payment.restore.schedule-backfill

## `payment.restore.evidence.prepare`

**Description:** Prepare a signed slip upload for one linked payment restore draft. Use: Use when the authorized workflow requires this capability: Prepare a signed slip upload for one linked payment restore draft. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Prepare a signed slip upload for one linked payment restore draft.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Prepare a signed slip upload for one linked payment restore draft. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.restore.create, payment.restore.evidence.finalize, payment.restore.preview, payment.restore.execute, payment.restore.cancel, payment.restore.schedule-backfill

## `payment.restore.evidence.finalize`

**Description:** Verify and finalize uploaded slip evidence for one linked payment restore draft. Use: Use when the authorized workflow requires this capability: Verify and finalize uploaded slip evidence for one linked payment restore draft. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Verify and finalize uploaded slip evidence for one linked payment restore draft.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Verify and finalize uploaded slip evidence for one linked payment restore draft. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.restore.create, payment.restore.evidence.prepare, payment.restore.preview, payment.restore.execute, payment.restore.cancel, payment.restore.schedule-backfill

## `payment.restore.preview`

**Description:** Preview exact restoration of a fully reversed payment using its original principal and interest components. Use: Use when the authorized workflow requires this capability: Preview exact restoration of a fully reversed payment using its original principal and interest components. Effects: Persists a payment.restore.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview exact restoration of a fully reversed payment using its original principal and interest components.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Preview exact restoration of a fully reversed payment using its original principal and interest components. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a payment.restore.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.restore.create, payment.restore.evidence.prepare, payment.restore.evidence.finalize, payment.restore.execute, payment.restore.cancel, payment.restore.schedule-backfill

## `payment.restore.execute`

**Description:** Execute a confirmed, idempotent exact restoration of a reversed payment as a linked child intake. Use: Use when the authorized workflow requires this capability: Execute a confirmed, idempotent exact restoration of a reversed payment as a linked child intake. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute a confirmed, idempotent exact restoration of a reversed payment as a linked child intake.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Execute a confirmed, idempotent exact restoration of a reversed payment as a linked child intake. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** payment.restore.create, payment.restore.evidence.prepare, payment.restore.evidence.finalize, payment.restore.preview, payment.restore.cancel, payment.restore.schedule-backfill

## `payment.restore.cancel`

**Description:** Cancel an eligible unposted restore draft with an immutable audited receipt without changing the reversed source or balances. Use: Use when the authorized workflow requires this capability: Cancel an eligible unposted restore draft with an immutable audited receipt without changing the reversed source or balances. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Cancel an eligible unposted restore draft with an immutable audited receipt without changing the reversed source or balances.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Cancel an eligible unposted restore draft with an immutable audited receipt without changing the reversed source or balances. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.restore.create, payment.restore.evidence.prepare, payment.restore.evidence.finalize, payment.restore.preview, payment.restore.execute, payment.restore.schedule-backfill

## `payment.restore.schedule-backfill`

**Description:** Repair derived schedule aggregates for one verified posted exact-payment restore without creating a payment. Use: Use when the authorized workflow requires this capability: Repair derived schedule aggregates for one verified posted exact-payment restore without creating a payment. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Repair derived schedule aggregates for one verified posted exact-payment restore without creating a payment.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Repair derived schedule aggregates for one verified posted exact-payment restore without creating a payment. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** payment.restore.create, payment.restore.evidence.prepare, payment.restore.evidence.finalize, payment.restore.preview, payment.restore.execute, payment.restore.cancel

## `loan.preview`

**Description:** Preview an exact loan schedule without persistence. Use: Use when the authorized workflow requires this capability: Preview an exact loan schedule without persistence. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Preview an exact loan schedule without persistence.

**Profiles:** full, core-read, loans

**When to use:** Use when the authorized workflow requires this capability: Preview an exact loan schedule without persistence. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.draft, loan.activate, loan.contract.get, loan.inspect-context, loan.cancel.preview, loan.cancel.execute

## `loan.cancel.preview`

**Description:** Persist a cancellation preview for an active loan with no actual disbursement and no remaining posted payments. Use: Use after inspecting the loan and before a separate cancellation execution. Effects: Persists a loan.cancel.preview review artifact; it does not perform the later financial execution. Retry: Not idempotent. Repeating creates another persisted preview; inspect history before retrying.

**Purpose:** Persist a cancellation preview for an active loan with no actual disbursement and no remaining posted payments.

**Profiles:** full, loans

**When to use:** Use after inspecting the loan and before a separate cancellation execution. Review the persisted preview; it is not read-only and does not authorize cancellation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** Persists a loan.cancel.preview review artifact; it does not perform the later financial execution.

**Retry:** Not idempotent. Repeating creates another persisted preview; inspect history before retrying.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.preview, loan.draft, loan.activate, loan.contract.get, loan.inspect-context, loan.cancel.execute

## `loan.draft`

**Description:** Create an editable loan draft. Use: Use when the authorized workflow requires this capability: Create an editable loan draft. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Create an editable loan draft.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Create an editable loan draft. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.preview, loan.activate, loan.contract.get, loan.inspect-context, loan.cancel.preview, loan.cancel.execute

## `loan.draft.delete`

**Description:** Permanently delete an unactivated draft loan after dependency checks and audit logging. Use: Use when the authorized workflow requires this capability: Permanently delete an unactivated draft loan after dependency checks and audit logging. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Permanently delete an unactivated draft loan after dependency checks and audit logging.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Permanently delete an unactivated draft loan after dependency checks and audit logging. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `loan.activate`

**Description:** Activate a loan draft idempotently and create its schedule. Use: Use when the authorized workflow requires this capability: Activate a loan draft idempotently and create its schedule. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Activate a loan draft idempotently and create its schedule.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Activate a loan draft idempotently and create its schedule. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.preview, loan.draft, loan.contract.get, loan.inspect-context, loan.cancel.preview, loan.cancel.execute

## `loan.interest-rate.list`

**Description:** List the effective-dated floating-interest timeline and current exact daily interest. Use: Use when the authorized workflow requires this capability: List the effective-dated floating-interest timeline and current exact daily interest. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List the effective-dated floating-interest timeline and current exact daily interest.

**Profiles:** full, core-read, loans

**When to use:** Use when the authorized workflow requires this capability: List the effective-dated floating-interest timeline and current exact daily interest. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `loan.interest-rate.preview`

**Description:** Preview an effective-dated floating-interest change and automatic timeline split. Use: Use when the authorized workflow requires this capability: Preview an effective-dated floating-interest change and automatic timeline split. Effects: Persists a loan.interest-rate.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview an effective-dated floating-interest change and automatic timeline split.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Preview an effective-dated floating-interest change and automatic timeline split. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a loan.interest-rate.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `loan.interest-rate.execute`

**Description:** Execute an explicitly confirmed floating-interest preview idempotently. Use: Use when the authorized workflow requires this capability: Execute an explicitly confirmed floating-interest preview idempotently. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute an explicitly confirmed floating-interest preview idempotently.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Execute an explicitly confirmed floating-interest preview idempotently. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `loan.settlement.preview`

**Description:** Preview and persist an exact floating-loan close-out composition. Use: Use when the authorized workflow requires this capability: Preview and persist an exact floating-loan close-out composition. Effects: Persists a loan.settlement.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview and persist an exact floating-loan close-out composition.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Preview and persist an exact floating-loan close-out composition. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a loan.settlement.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.settlement.execute, loan.settlement.reverse, loan.restructure.preview, loan.restructure.execute, loan.restructure.reverse, loan.waiver.preview, loan.waiver.execute

## `loan.settlement.execute`

**Description:** Execute an explicitly confirmed floating-loan close-out idempotently. Use: Use when the authorized workflow requires this capability: Execute an explicitly confirmed floating-loan close-out idempotently. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute an explicitly confirmed floating-loan close-out idempotently.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Execute an explicitly confirmed floating-loan close-out idempotently. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.settlement.preview, loan.settlement.reverse, loan.restructure.preview, loan.restructure.execute, loan.restructure.reverse, loan.waiver.preview, loan.waiver.execute

## `loan.settlement.reverse`

**Description:** Reverse an executed floating-loan settlement through exact append-only compensation. Use: Use when the authorized workflow requires this capability: Reverse an executed floating-loan settlement through exact append-only compensation. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Reverse an executed floating-loan settlement through exact append-only compensation.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Reverse an executed floating-loan settlement through exact append-only compensation. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.settlement.preview, loan.settlement.execute, loan.restructure.preview, loan.restructure.execute, loan.restructure.reverse, loan.waiver.preview, loan.waiver.execute

## `loan.cancel.execute`

**Description:** Execute an explicitly confirmed unfunded-loan cancellation idempotently. Use: Use when the authorized workflow requires this capability: Execute an explicitly confirmed unfunded-loan cancellation idempotently. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute an explicitly confirmed unfunded-loan cancellation idempotently.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Execute an explicitly confirmed unfunded-loan cancellation idempotently. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.preview, loan.draft, loan.activate, loan.contract.get, loan.inspect-context, loan.cancel.preview

## `loan.replacement.preview`

**Description:** Preview an atomic scheduled-loan replacement from an active loan into an existing funded draft. Use: Use when the authorized workflow requires this capability: Preview an atomic scheduled-loan replacement from an active loan into an existing funded draft. Effects: Persists a loan.replacement.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview an atomic scheduled-loan replacement from an active loan into an existing funded draft.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Preview an atomic scheduled-loan replacement from an active loan into an existing funded draft. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a loan.replacement.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** renewal.preview, renewal.execute, renewal.reverse, loan.replacement.execute, loan.replacement.reverse

## `loan.replacement.execute`

**Description:** Execute an explicitly confirmed fresh atomic loan replacement idempotently. Use: Use when the authorized workflow requires this capability: Execute an explicitly confirmed fresh atomic loan replacement idempotently. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute an explicitly confirmed fresh atomic loan replacement idempotently.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Execute an explicitly confirmed fresh atomic loan replacement idempotently. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** renewal.preview, renewal.execute, renewal.reverse, loan.replacement.preview, loan.replacement.reverse

## `loan.replacement.reverse`

**Description:** Reverse an executed loan replacement only when authoritative downstream checks allow compensation. Use: Use when the authorized workflow requires this capability: Reverse an executed loan replacement only when authoritative downstream checks allow compensation. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Reverse an executed loan replacement only when authoritative downstream checks allow compensation.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Reverse an executed loan replacement only when authoritative downstream checks allow compensation. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** renewal.preview, renewal.execute, renewal.reverse, loan.replacement.preview, loan.replacement.execute

## `loan.disbursement.list`

**Description:** List actual loan disbursement events and variance read-only. Use: Use when the authorized workflow requires this capability: List actual loan disbursement events and variance read-only. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List actual loan disbursement events and variance read-only.

**Profiles:** full, core-read, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: List actual loan disbursement events and variance read-only. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.disbursement.draft, loan.disbursement.update, loan.disbursement.evidence.prepare, loan.disbursement.evidence.finalize, loan.disbursement.post, loan.disbursement.reverse

## `loan.contract.get`

**Description:** Get complete accessible loan terms and repayment schedule read-only. Use: Use when the authorized workflow requires this capability: Get complete accessible loan terms and repayment schedule read-only. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Get complete accessible loan terms and repayment schedule read-only.

**Profiles:** full, core-read, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: Get complete accessible loan terms and repayment schedule read-only. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.preview, loan.draft, loan.activate, loan.inspect-context, loan.cancel.preview, loan.cancel.execute

## `loan.inspect-context`

**Description:** Inspect one accessible loan with a bounded summary, schedule, or payment-history view. Use: Use when the authorized workflow requires this capability: Inspect one accessible loan with a bounded summary, schedule, or payment-history view. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Inspect one accessible loan with a bounded summary, schedule, or payment-history view.

**Profiles:** full, core-read, payments, loans, disbursements, discovery

**When to use:** Use when the authorized workflow requires this capability: Inspect one accessible loan with a bounded summary, schedule, or payment-history view. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.preview, loan.draft, loan.activate, loan.contract.get, loan.cancel.preview, loan.cancel.execute

## `loan.payment-start-date.update`

**Description:** Change the first repayment date while preserving posted payment history and auditing schedule amendments. Use: Use only after reviewing the date amendment and obtaining explicit human confirmation. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Change the first repayment date while preserving posted payment history and auditing schedule amendments.

**Profiles:** full, loans

**When to use:** Use only after reviewing the date amendment and obtaining explicit human confirmation. The schema has no confirmed field; confirmation is an orchestration requirement, not a tool argument.

**Prerequisites:** Authenticated tenant scope, current target state, and an explicit human-confirmed date change.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `loan.schedule.defer`

**Description:** Defer one fully unpaid installment to the day after the current schedule tail without recording a payment. Use: Use only after authoritative inspection of the exact active scheduled loan and selected installment. Effects: Marks the source installment deferred and appends one replacement schedule installment and an audit record. Retry: Retry only with the identical idempotency key and payload; a changed request under the same key conflicts. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Defer one fully unpaid installment to the day after the current schedule tail without recording a payment.

**Profiles:** full, loans

**When to use:** Use only after authoritative inspection of the exact active scheduled loan and selected installment. Review the source and replacement dates and component amounts, then obtain explicit human confirmation.

**Prerequisites:** The selected schedule must belong to the accessible active scheduled loan and be fully unpaid.

**Effects:** Marks the source installment deferred and appends one replacement schedule installment and an audit record.

**Retry:** Retry only with the identical idempotency key and payload; a changed request under the same key conflicts.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `loan.payment-history.list`

**Description:** List payment intakes and posted components for one accessible loan read-only. Use: Use when the authorized workflow requires this capability: List payment intakes and posted components for one accessible loan read-only. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List payment intakes and posted components for one accessible loan read-only.

**Profiles:** full, core-read, loans

**When to use:** Use when the authorized workflow requires this capability: List payment intakes and posted components for one accessible loan read-only. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.match-context`

**Description:** Get a bounded, read-only payment matching context with borrower candidates and linked loan context. Use: Use when the authorized workflow requires this capability: Get a bounded, read-only payment matching context with borrower candidates and linked loan context. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Get a bounded, read-only payment matching context with borrower candidates and linked loan context.

**Profiles:** full, core-read, payments, discovery

**When to use:** Use when the authorized workflow requires this capability: Get a bounded, read-only payment matching context with borrower candidates and linked loan context. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** payment.preview, payment.post, payment.cancel, payment.reverse, intake.get, intake.create

## `loan.disbursement.draft`

**Description:** Create an editable actual loan disbursement draft. Use: Use when the authorized workflow requires this capability: Create an editable actual loan disbursement draft. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Create an editable actual loan disbursement draft.

**Profiles:** full, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: Create an editable actual loan disbursement draft. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.disbursement.list, loan.disbursement.update, loan.disbursement.evidence.prepare, loan.disbursement.evidence.finalize, loan.disbursement.post, loan.disbursement.reverse

## `loan.disbursement.update`

**Description:** Update supplied fields on an editable actual loan disbursement draft. Use: Use when the authorized workflow requires this capability: Update supplied fields on an editable actual loan disbursement draft. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Update supplied fields on an editable actual loan disbursement draft.

**Profiles:** full, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: Update supplied fields on an editable actual loan disbursement draft. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.disbursement.list, loan.disbursement.draft, loan.disbursement.evidence.prepare, loan.disbursement.evidence.finalize, loan.disbursement.post, loan.disbursement.reverse

## `loan.disbursement.evidence.prepare`

**Description:** Prepare a signed upload for loan disbursement evidence. Use: Use when the authorized workflow requires this capability: Prepare a signed upload for loan disbursement evidence. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Prepare a signed upload for loan disbursement evidence.

**Profiles:** full, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: Prepare a signed upload for loan disbursement evidence. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.disbursement.list, loan.disbursement.draft, loan.disbursement.update, loan.disbursement.evidence.finalize, loan.disbursement.post, loan.disbursement.reverse

## `loan.disbursement.evidence.finalize`

**Description:** Verify and finalize loan disbursement evidence. Use: Use when the authorized workflow requires this capability: Verify and finalize loan disbursement evidence. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Verify and finalize loan disbursement evidence.

**Profiles:** full, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: Verify and finalize loan disbursement evidence. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.disbursement.list, loan.disbursement.draft, loan.disbursement.update, loan.disbursement.evidence.prepare, loan.disbursement.post, loan.disbursement.reverse

## `loan.disbursement.post`

**Description:** Post an actual loan disbursement idempotently. Use: Use when the authorized workflow requires this capability: Post an actual loan disbursement idempotently. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Post an actual loan disbursement idempotently.

**Profiles:** full, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: Post an actual loan disbursement idempotently. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.disbursement.list, loan.disbursement.draft, loan.disbursement.update, loan.disbursement.evidence.prepare, loan.disbursement.evidence.finalize, loan.disbursement.reverse

## `loan.disbursement.reverse`

**Description:** Reverse a posted loan disbursement with a reason. Use: Use when the authorized workflow requires this capability: Reverse a posted loan disbursement with a reason. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Reverse a posted loan disbursement with a reason.

**Profiles:** full, loans, disbursements

**When to use:** Use when the authorized workflow requires this capability: Reverse a posted loan disbursement with a reason. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.disbursement.list, loan.disbursement.draft, loan.disbursement.update, loan.disbursement.evidence.prepare, loan.disbursement.evidence.finalize, loan.disbursement.post

## `loan.commission-participant.list`

**Description:** List current effective-dated commission participants for an accessible loan. Use: Use when the authorized workflow requires this capability: List current effective-dated commission participants for an accessible loan. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List current effective-dated commission participants for an accessible loan.

**Profiles:** full, core-read, admin

**When to use:** Use when the authorized workflow requires this capability: List current effective-dated commission participants for an accessible loan. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.commission-participant.add, loan.commission-participant.update, loan.commission-participant.end, loan.commission.preview, loan.commission.list, loan.commission.calculate, loan.commission.reverse

## `loan.commission-participant.add`

**Description:** Add a confirmed effective-dated commission participant idempotently. Use: Use when the authorized workflow requires this capability: Add a confirmed effective-dated commission participant idempotently. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Add a confirmed effective-dated commission participant idempotently.

**Profiles:** full, admin

**When to use:** Use when the authorized workflow requires this capability: Add a confirmed effective-dated commission participant idempotently. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.commission-participant.list, loan.commission-participant.update, loan.commission-participant.end, loan.commission.preview, loan.commission.list, loan.commission.calculate, loan.commission.reverse

## `loan.commission-participant.update`

**Description:** End the current participant version and append a confirmed replacement version. Use: Use when the authorized workflow requires this capability: End the current participant version and append a confirmed replacement version. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** End the current participant version and append a confirmed replacement version.

**Profiles:** full, admin

**When to use:** Use when the authorized workflow requires this capability: End the current participant version and append a confirmed replacement version. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.commission-participant.list, loan.commission-participant.add, loan.commission-participant.end, loan.commission.preview, loan.commission.list, loan.commission.calculate, loan.commission.reverse

## `loan.commission-participant.end`

**Description:** End a commission participant through a confirmed immutable successor version. Use: Use when the authorized workflow requires this capability: End a commission participant through a confirmed immutable successor version. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** End a commission participant through a confirmed immutable successor version.

**Profiles:** full, admin

**When to use:** Use when the authorized workflow requires this capability: End a commission participant through a confirmed immutable successor version. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.commission-participant.list, loan.commission-participant.add, loan.commission-participant.update, loan.commission.preview, loan.commission.list, loan.commission.calculate, loan.commission.reverse

## `loan.commission.preview`

**Description:** Preview exact commission derived only from posted payment interest components. Use: Use when the authorized workflow requires this capability: Preview exact commission derived only from posted payment interest components. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Preview exact commission derived only from posted payment interest components.

**Profiles:** full, core-read, admin

**When to use:** Use when the authorized workflow requires this capability: Preview exact commission derived only from posted payment interest components. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.commission-participant.list, loan.commission-participant.add, loan.commission-participant.update, loan.commission-participant.end, loan.commission.list, loan.commission.calculate, loan.commission.reverse

## `loan.commission.list`

**Description:** List exact derived commission for supplied posted payment public UUIDs. Use: Use when the authorized workflow requires this capability: List exact derived commission for supplied posted payment public UUIDs. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List exact derived commission for supplied posted payment public UUIDs.

**Profiles:** full, core-read, admin

**When to use:** Use when the authorized workflow requires this capability: List exact derived commission for supplied posted payment public UUIDs. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.commission-participant.list, loan.commission-participant.add, loan.commission-participant.update, loan.commission-participant.end, loan.commission.preview, loan.commission.calculate, loan.commission.reverse

## `loan.commission.calculate`

**Description:** Calculate exact derived commission for supplied posted payment public UUIDs. Use: Use when the authorized workflow requires this capability: Calculate exact derived commission for supplied posted payment public UUIDs. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Calculate exact derived commission for supplied posted payment public UUIDs.

**Profiles:** full, core-read, admin

**When to use:** Use when the authorized workflow requires this capability: Calculate exact derived commission for supplied posted payment public UUIDs. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.commission-participant.list, loan.commission-participant.add, loan.commission-participant.update, loan.commission-participant.end, loan.commission.preview, loan.commission.list, loan.commission.reverse

## `loan.commission.reverse`

**Description:** Preview the exact compensating commission effect of supplied posted reversal payments read-only; this never writes financial records or returns audit identifiers. Use: Use when the authorized workflow requires this capability: Preview the exact compensating commission effect of supplied posted reversal payments read-only; this never writes financial records or returns audit identifiers. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Preview the exact compensating commission effect of supplied posted reversal payments read-only; this never writes financial records or returns audit identifiers.

**Profiles:** full, core-read, admin

**When to use:** Use when the authorized workflow requires this capability: Preview the exact compensating commission effect of supplied posted reversal payments read-only; this never writes financial records or returns audit identifiers. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Posted reversal payments must already be supplied; this tool only calculates the compensating commission effect.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.commission-participant.list, loan.commission-participant.add, loan.commission-participant.update, loan.commission-participant.end, loan.commission.preview, loan.commission.list, loan.commission.calculate

## `payment.intermediary-attribution.create`

**Description:** Create a confirmed exact payment-source attribution idempotently. Use: Use only after exact source attribution is reviewed and confirmed. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Create a confirmed exact payment-source attribution idempotently.

**Profiles:** full, payments

**When to use:** Use only after exact source attribution is reviewed and confirmed.

**Prerequisites:** For sourceKind=direct, intermediaryPublicId must be null; for sourceKind=intermediary, provide its public ID. Authenticated tenant scope and current payment state.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `payment.intermediary-attribution.list`

**Description:** List append-only payment-source attribution entries for one accessible payment. Use: Use when the authorized workflow requires this capability: List append-only payment-source attribution entries for one accessible payment. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List append-only payment-source attribution entries for one accessible payment.

**Profiles:** full, core-read, payments

**When to use:** Use when the authorized workflow requires this capability: List append-only payment-source attribution entries for one accessible payment. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `payment.intermediary-attribution.reverse`

**Description:** Create a confirmed reasoned compensating attribution idempotently. Use: Use when the authorized workflow requires this capability: Create a confirmed reasoned compensating attribution idempotently. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Create a confirmed reasoned compensating attribution idempotently.

**Profiles:** full, payments

**When to use:** Use when the authorized workflow requires this capability: Create a confirmed reasoned compensating attribution idempotently. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `intermediary.search`

**Description:** Search active intermediaries before creating a new record. Use: Use when the authorized workflow requires this capability: Search active intermediaries before creating a new record. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Search active intermediaries before creating a new record.

**Profiles:** full, core-read, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Search active intermediaries before creating a new record. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.create`

**Description:** Create an intermediary after canonical-name review. Use: Use when the authorized workflow requires this capability: Create an intermediary after canonical-name review. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Create an intermediary after canonical-name review.

**Profiles:** full, admin

**When to use:** Use when the authorized workflow requires this capability: Create an intermediary after canonical-name review. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.profile.get`

**Description:** Inspect one intermediary profile, masked bank accounts, and assignment history. Use: Use when the authorized workflow requires this capability: Inspect one intermediary profile, masked bank accounts, and assignment history. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Inspect one intermediary profile, masked bank accounts, and assignment history.

**Profiles:** full, core-read, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Inspect one intermediary profile, masked bank accounts, and assignment history. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.bank-account.save`

**Description:** Save an intermediary bank account and return only its masked public form. Use: Use when the authorized workflow requires this capability: Save an intermediary bank account and return only its masked public form. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Save an intermediary bank account and return only its masked public form.

**Profiles:** full, admin

**When to use:** Use when the authorized workflow requires this capability: Save an intermediary bank account and return only its masked public form. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.managed-loan.list`

**Description:** List active loans managed by an intermediary through effective assignments. Use: Use when the authorized workflow requires this capability: List active loans managed by an intermediary through effective assignments. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List active loans managed by an intermediary through effective assignments.

**Profiles:** full, core-read, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: List active loans managed by an intermediary through effective assignments. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.assignment.create`

**Description:** Create an idempotent effective-dated loan intermediary assignment. Use: Use when the authorized workflow requires this capability: Create an idempotent effective-dated loan intermediary assignment. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Create an idempotent effective-dated loan intermediary assignment.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Create an idempotent effective-dated loan intermediary assignment. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.assignment.end`

**Description:** End an intermediary assignment without deleting its history. Use: Use when the authorized workflow requires this capability: End an intermediary assignment without deleting its history. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** End an intermediary assignment without deleting its history.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: End an intermediary assignment without deleting its history. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.disbursement.list`

**Description:** List intermediated disbursement groups by public filters. Use: Use when the authorized workflow requires this capability: List intermediated disbursement groups by public filters. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List intermediated disbursement groups by public filters.

**Profiles:** full, core-read, disbursements

**When to use:** Use when the authorized workflow requires this capability: List intermediated disbursement groups by public filters. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.disbursement.get, intermediary.disbursement.create, intermediary.disbursement.event.create, intermediary.disbursement.preview, intermediary.disbursement.post, intermediary.disbursement.reverse

## `intermediary.disbursement.get`

**Description:** Inspect one intermediated group, its transfer events, and latest reconciliation preview. Use: Use when the authorized workflow requires this capability: Inspect one intermediated group, its transfer events, and latest reconciliation preview. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Inspect one intermediated group, its transfer events, and latest reconciliation preview.

**Profiles:** full, core-read, disbursements

**When to use:** Use when the authorized workflow requires this capability: Inspect one intermediated group, its transfer events, and latest reconciliation preview. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.disbursement.list, intermediary.disbursement.create, intermediary.disbursement.event.create, intermediary.disbursement.preview, intermediary.disbursement.post, intermediary.disbursement.reverse

## `intermediary.disbursement.create`

**Description:** Create an exact intermediated disbursement group from persisted loan activation terms. Use: Use when the authorized workflow requires this capability: Create an exact intermediated disbursement group from persisted loan activation terms. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Create an exact intermediated disbursement group from persisted loan activation terms.

**Profiles:** full, disbursements

**When to use:** Use when the authorized workflow requires this capability: Create an exact intermediated disbursement group from persisted loan activation terms. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.disbursement.list, intermediary.disbursement.get, intermediary.disbursement.event.create, intermediary.disbursement.preview, intermediary.disbursement.post, intermediary.disbursement.reverse

## `intermediary.disbursement.event.create`

**Description:** Create one immutable-ready cash transfer event within an intermediated group. Use: Use when the authorized workflow requires this capability: Create one immutable-ready cash transfer event within an intermediated group. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Create one immutable-ready cash transfer event within an intermediated group.

**Profiles:** full, disbursements

**When to use:** Use when the authorized workflow requires this capability: Create one immutable-ready cash transfer event within an intermediated group. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.disbursement.list, intermediary.disbursement.get, intermediary.disbursement.create, intermediary.disbursement.preview, intermediary.disbursement.post, intermediary.disbursement.reverse

## `intermediary.disbursement.evidence.prepare`

**Description:** Prepare a signed upload for one transfer-event evidence item. Use: Use when the authorized workflow requires this capability: Prepare a signed upload for one transfer-event evidence item. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Prepare a signed upload for one transfer-event evidence item.

**Profiles:** full, disbursements

**When to use:** Use when the authorized workflow requires this capability: Prepare a signed upload for one transfer-event evidence item. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.disbursement.evidence.finalize`

**Description:** Verify and finalize one transfer-event evidence item. Use: Use when the authorized workflow requires this capability: Verify and finalize one transfer-event evidence item. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Verify and finalize one transfer-event evidence item.

**Profiles:** full, disbursements

**When to use:** Use when the authorized workflow requires this capability: Verify and finalize one transfer-event evidence item. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.disbursement.preview`

**Description:** Persist an exact role-total, evidence-readiness, retained-balance, and variance preview. Use: Use when the authorized workflow requires this capability: Persist an exact role-total, evidence-readiness, retained-balance, and variance preview. Effects: Persists a intermediary.disbursement.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Persist an exact role-total, evidence-readiness, retained-balance, and variance preview.

**Profiles:** full, disbursements

**When to use:** Use when the authorized workflow requires this capability: Persist an exact role-total, evidence-readiness, retained-balance, and variance preview. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a intermediary.disbursement.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.disbursement.list, intermediary.disbursement.get, intermediary.disbursement.create, intermediary.disbursement.event.create, intermediary.disbursement.post, intermediary.disbursement.reverse

## `intermediary.disbursement.post`

**Description:** Atomically post an exact balanced intermediated group after explicit confirmation. Use: Use when the authorized workflow requires this capability: Atomically post an exact balanced intermediated group after explicit confirmation. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Atomically post an exact balanced intermediated group after explicit confirmation.

**Profiles:** full, disbursements

**When to use:** Use when the authorized workflow requires this capability: Atomically post an exact balanced intermediated group after explicit confirmation. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** intermediary.disbursement.list, intermediary.disbursement.get, intermediary.disbursement.create, intermediary.disbursement.event.create, intermediary.disbursement.preview, intermediary.disbursement.reverse

## `intermediary.disbursement.reverse`

**Description:** Create a reasoned compensating reversal for one posted intermediated group. Use: Use when the authorized workflow requires this capability: Create a reasoned compensating reversal for one posted intermediated group. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Create a reasoned compensating reversal for one posted intermediated group.

**Profiles:** full, disbursements

**When to use:** Use when the authorized workflow requires this capability: Create a reasoned compensating reversal for one posted intermediated group. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** intermediary.disbursement.list, intermediary.disbursement.get, intermediary.disbursement.create, intermediary.disbursement.event.create, intermediary.disbursement.preview, intermediary.disbursement.post

## `intermediary.collection.list`

**Description:** List borrower payments held by an intermediary. Use: Use when the authorized workflow requires this capability: List borrower payments held by an intermediary. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List borrower payments held by an intermediary.

**Profiles:** full, core-read, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: List borrower payments held by an intermediary. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.remittance.get, intermediary.remittance.create, intermediary.remittance.allocations.save, intermediary.remittance.preview, intermediary.remittance.evidence.prepare, intermediary.remittance.evidence.finalize, intermediary.remittance.post

## `intermediary.collection.create`

**Description:** Record a borrower payment held by an intermediary without posting cash receipt twice. Use: Use when the authorized workflow requires this capability: Record a borrower payment held by an intermediary without posting cash receipt twice. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Record a borrower payment held by an intermediary without posting cash receipt twice.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Record a borrower payment held by an intermediary without posting cash receipt twice. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `intermediary.collection.cancel`

**Description:** Cancel an exact unposted intermediary collection with a current state hash and audit receipt. Use: Use when the authorized workflow requires this capability: Cancel an exact unposted intermediary collection with a current state hash and audit receipt. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Cancel an exact unposted intermediary collection with a current state hash and audit receipt.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Cancel an exact unposted intermediary collection with a current state hash and audit receipt. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `intermediary.remittance.get`

**Description:** Inspect a remittance, allocations, and exact remaining balance. Use: Use when the authorized workflow requires this capability: Inspect a remittance, allocations, and exact remaining balance. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Inspect a remittance, allocations, and exact remaining balance.

**Profiles:** full, core-read, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Inspect a remittance, allocations, and exact remaining balance. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.remittance.create, intermediary.remittance.allocations.save, intermediary.remittance.preview, intermediary.remittance.evidence.prepare, intermediary.remittance.evidence.finalize, intermediary.remittance.post, intermediary.collection.list

## `intermediary.remittance.create`

**Description:** Create an idempotent intermediary remittance draft. Use: Use when the authorized workflow requires this capability: Create an idempotent intermediary remittance draft. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Purpose:** Create an idempotent intermediary remittance draft.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Create an idempotent intermediary remittance draft. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.remittance.get, intermediary.remittance.allocations.save, intermediary.remittance.preview, intermediary.remittance.evidence.prepare, intermediary.remittance.evidence.finalize, intermediary.remittance.post, intermediary.collection.list

## `intermediary.remittance.allocations.save`

**Description:** Select exact intermediary collections for a remittance. Use: Use when the authorized workflow requires this capability: Select exact intermediary collections for a remittance. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Select exact intermediary collections for a remittance.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Select exact intermediary collections for a remittance. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.remittance.get, intermediary.remittance.create, intermediary.remittance.preview, intermediary.remittance.evidence.prepare, intermediary.remittance.evidence.finalize, intermediary.remittance.post, intermediary.collection.list

## `intermediary.remittance.preview`

**Description:** Preview the exact remittance reconciliation before posting. Use: Use when the authorized workflow requires this capability: Preview the exact remittance reconciliation before posting. Effects: Persists a intermediary.remittance.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview the exact remittance reconciliation before posting.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Preview the exact remittance reconciliation before posting. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a intermediary.remittance.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.remittance.get, intermediary.remittance.create, intermediary.remittance.allocations.save, intermediary.remittance.evidence.prepare, intermediary.remittance.evidence.finalize, intermediary.remittance.post, intermediary.collection.list

## `intermediary.remittance.evidence.prepare`

**Description:** Prepare a signed upload for remittance-slip evidence. Use: Use when the authorized workflow requires this capability: Prepare a signed upload for remittance-slip evidence. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Prepare a signed upload for remittance-slip evidence.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Prepare a signed upload for remittance-slip evidence. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.remittance.get, intermediary.remittance.create, intermediary.remittance.allocations.save, intermediary.remittance.preview, intermediary.remittance.evidence.finalize, intermediary.remittance.post, intermediary.collection.list

## `intermediary.remittance.evidence.finalize`

**Description:** Verify and finalize remittance-slip evidence. Use: Use when the authorized workflow requires this capability: Verify and finalize remittance-slip evidence. Effects: Changes evidence preparation or readiness state; it does not imply that a financial record is posted. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Verify and finalize remittance-slip evidence.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Verify and finalize remittance-slip evidence. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes evidence preparation or readiness state; it does not imply that a financial record is posted.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** intermediary.remittance.get, intermediary.remittance.create, intermediary.remittance.allocations.save, intermediary.remittance.preview, intermediary.remittance.evidence.prepare, intermediary.remittance.post, intermediary.collection.list

## `intermediary.remittance.post`

**Description:** Post a balanced, explicitly confirmed intermediary remittance. Use: Use when the authorized workflow requires this capability: Post a balanced, explicitly confirmed intermediary remittance. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Post a balanced, explicitly confirmed intermediary remittance.

**Profiles:** full, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Post a balanced, explicitly confirmed intermediary remittance. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** intermediary.remittance.get, intermediary.remittance.create, intermediary.remittance.allocations.save, intermediary.remittance.preview, intermediary.remittance.evidence.prepare, intermediary.remittance.evidence.finalize, intermediary.collection.list

## `renewal.preview`

**Description:** Preview a daily-loan renewal with backend-authoritative full-contract-interest composition by default. Use: Use when the authorized workflow requires this capability: Preview a daily-loan renewal with backend-authoritative full-contract-interest composition by default. Effects: Persists a renewal.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview a daily-loan renewal with backend-authoritative full-contract-interest composition by default.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Preview a daily-loan renewal with backend-authoritative full-contract-interest composition by default. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a renewal.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** renewal.execute, renewal.reverse, loan.replacement.preview, loan.replacement.execute, loan.replacement.reverse

## `renewal.execute`

**Description:** Execute an unchanged confirmed renewal idempotently, with explicit collection acknowledgement when required. Use: Use when the authorized workflow requires this capability: Execute an unchanged confirmed renewal idempotently, with explicit collection acknowledgement when required. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute an unchanged confirmed renewal idempotently, with explicit collection acknowledgement when required.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Execute an unchanged confirmed renewal idempotently, with explicit collection acknowledgement when required. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** renewal.preview, renewal.reverse, loan.replacement.preview, loan.replacement.execute, loan.replacement.reverse

## `renewal.reverse`

**Description:** Reverse an executed renewal with compensating records. Use: Use when the authorized workflow requires this capability: Reverse an executed renewal with compensating records. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Reverse an executed renewal with compensating records.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Reverse an executed renewal with compensating records. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** renewal.preview, renewal.execute, loan.replacement.preview, loan.replacement.execute, loan.replacement.reverse

## `loan.restructure.preview`

**Description:** Preview an exact single-payment or floating-loan settlement and replacement contract from current balances. Use: Use when the authorized workflow requires this capability: Preview an exact single-payment or floating-loan settlement and replacement contract from current balances. Effects: Persists a loan.restructure.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview an exact single-payment or floating-loan settlement and replacement contract from current balances.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Preview an exact single-payment or floating-loan settlement and replacement contract from current balances. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a loan.restructure.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.settlement.preview, loan.settlement.execute, loan.settlement.reverse, loan.restructure.execute, loan.restructure.reverse, loan.waiver.preview, loan.waiver.execute

## `loan.restructure.execute`

**Description:** Execute an explicitly confirmed restructure preview idempotently. Use: Use when the authorized workflow requires this capability: Execute an explicitly confirmed restructure preview idempotently. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute an explicitly confirmed restructure preview idempotently.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Execute an explicitly confirmed restructure preview idempotently. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.settlement.preview, loan.settlement.execute, loan.settlement.reverse, loan.restructure.preview, loan.restructure.reverse, loan.waiver.preview, loan.waiver.execute

## `loan.restructure.reverse`

**Description:** Reverse an executed restructure when the authoritative downstream checks allow it. Use: Use when the authorized workflow requires this capability: Reverse an executed restructure when the authoritative downstream checks allow it. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Reverse an executed restructure when the authoritative downstream checks allow it.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Reverse an executed restructure when the authoritative downstream checks allow it. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.settlement.preview, loan.settlement.execute, loan.settlement.reverse, loan.restructure.preview, loan.restructure.execute, loan.waiver.preview, loan.waiver.execute

## `loan.waiver.preview`

**Description:** Preview an interest, fee, or penalty waiver against the current replacement-loan balance. Use: Use when the authorized workflow requires this capability: Preview an interest, fee, or penalty waiver against the current replacement-loan balance. Effects: Persists a loan.waiver.preview review artifact; it does not perform the later financial execution. Retry: Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Purpose:** Preview an interest, fee, or penalty waiver against the current replacement-loan balance.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Preview an interest, fee, or penalty waiver against the current replacement-loan balance. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Persists a loan.waiver.preview review artifact; it does not perform the later financial execution.

**Retry:** Do not blindly retry; inspect the current state and follow the operation's explicit recovery path.

**Human confirmation:** Not required for this tool itself.

**Related tools:** loan.settlement.preview, loan.settlement.execute, loan.settlement.reverse, loan.restructure.preview, loan.restructure.execute, loan.restructure.reverse, loan.waiver.execute

## `loan.waiver.execute`

**Description:** Execute an explicitly confirmed component waiver preview idempotently. Use: Use when the authorized workflow requires this capability: Execute an explicitly confirmed component waiver preview idempotently. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Execute an explicitly confirmed component waiver preview idempotently.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Execute an explicitly confirmed component waiver preview idempotently. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** loan.settlement.preview, loan.settlement.execute, loan.settlement.reverse, loan.restructure.preview, loan.restructure.execute, loan.restructure.reverse, loan.waiver.preview

## `loan.waiver.reverse`

**Description:** Reverse an executed component waiver with a compensating record. Use: Use when the authorized workflow requires this capability: Reverse an executed component waiver with a compensating record. Effects: Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records. Retry: Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Reverse an executed component waiver with a compensating record.

**Profiles:** full, loans

**When to use:** Use when the authorized workflow requires this capability: Reverse an executed component waiver with a compensating record. Validate the current target and required evidence/state before calling; keep the returned audit and correlation metadata.

**Prerequisites:** Authenticated tenant scope, current target state, and any required idempotency or confirmation fields from the advertised schema.

**Effects:** Changes tenant-scoped application state according to the authoritative service; financial tools may append immutable records.

**Retry:** Safe to retry with the same idempotency key after checking the returned state; never change payload under a reused key.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** None

## `funding-source.list`

**Description:** List tenant funding profiles and drawdowns read-only. Use: Use when the authorized workflow requires this capability: List tenant funding profiles and drawdowns read-only. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List tenant funding profiles and drawdowns read-only.

**Profiles:** full, core-read, loans, disbursements, admin, discovery

**When to use:** Use when the authorized workflow requires this capability: List tenant funding profiles and drawdowns read-only. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** funding-allocation.preview, funding-allocation.create, funding-allocation.list

## `funding-allocation.preview`

**Description:** Preview attaching an active funding profile or drawdown to an active loan. Use: Use when the authorized workflow requires this capability: Preview attaching an active funding profile or drawdown to an active loan. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Preview attaching an active funding profile or drawdown to an active loan.

**Profiles:** full, core-read, loans, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: Preview attaching an active funding profile or drawdown to an active loan. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Select exactly one funding source: bankProfilePublicId XOR bankLoanPublicId. Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** funding-source.list, funding-allocation.create, funding-allocation.list

## `funding-allocation.create`

**Description:** Create an append-only funding allocation for an active loan, including after activation. Use: Use when the authorized workflow requires this capability: Create an append-only funding allocation for an active loan. Effects: Creates an immutable funding allocation and audit record. Retry: The server derives the retry key from loan, amount, and date; retry identical arguments without sending an idempotencyKey. Changing source or note may conflict. Requires explicit human confirmation through the workflow before execution.

**Purpose:** Create an append-only funding allocation for an active loan, including after activation.

**Profiles:** full, loans, admin

**When to use:** Use when the authorized workflow requires this capability: Create an append-only funding allocation for an active loan. Validate the current target and review the preview before creation.

**Prerequisites:** Select exactly one funding source: bankProfilePublicId XOR bankLoanPublicId. Authenticated tenant scope and current target state.

**Effects:** Creates an immutable funding allocation and audit record.

**Retry:** The server derives the retry key from loan, amount, and date; retry identical arguments without sending an idempotencyKey. Changing source or note may conflict.

**Human confirmation:** Required where the operation creates or changes financial/business state; inspect and preview first.

**Related tools:** funding-source.list, funding-allocation.preview, funding-allocation.list

## `funding-allocation.list`

**Description:** List append-only funding allocations for one loan read-only. Use: Use when the authorized workflow requires this capability: List append-only funding allocations for one loan read-only. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List append-only funding allocations for one loan read-only.

**Profiles:** full, core-read, loans, disbursements, admin

**When to use:** Use when the authorized workflow requires this capability: List append-only funding allocations for one loan read-only. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** funding-source.list, funding-allocation.preview, funding-allocation.create

## `system.error-diagnostic.get`

**Description:** Inspect a safe tenant-scoped MCP diagnostic trace by correlation ID. Use: Use when the authorized workflow requires this capability: Inspect a safe tenant-scoped MCP diagnostic trace by correlation ID. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Inspect a safe tenant-scoped MCP diagnostic trace by correlation ID.

**Profiles:** full, core-read, admin

**When to use:** Use when the authorized workflow requires this capability: Inspect a safe tenant-scoped MCP diagnostic trace by correlation ID. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `system.error-diagnostic.list`

**Description:** List recent safe tenant-scoped MCP diagnostics with bounded filters. Use: Use when the authorized workflow requires this capability: List recent safe tenant-scoped MCP diagnostics with bounded filters. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** List recent safe tenant-scoped MCP diagnostics with bounded filters.

**Profiles:** full, core-read, admin

**When to use:** Use when the authorized workflow requires this capability: List recent safe tenant-scoped MCP diagnostics with bounded filters. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `workflow.resolve`

**Description:** Read-only workflow guidance from current authorized state; it never confirms, authorizes, previews, or executes a financial operation. Use: Use when the authorized workflow requires this capability: Read-only workflow guidance from current authorized state; it never confirms, authorizes, previews, or executes a financial operation. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Read-only workflow guidance from current authorized state; it never confirms, authorizes, previews, or executes a financial operation.

**Profiles:** full, core-read, payments, loans, disbursements, admin, discovery

**When to use:** Use when the authorized workflow requires this capability: Read-only workflow guidance from current authorized state; it never confirms, authorizes, previews, or executes a financial operation. Read the returned authoritative state; do not treat this result as authorization to execute another operation.

**Prerequisites:** Authenticated tenant scope and access to the requested public identifiers.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None

## `tool.catalog.search`

**Description:** Search active MCP tool metadata for candidate capabilities; never reads domain records or executes tools. Use: Use when unsure which visible MCP capability fits a request. Effects: No side effects; read-only. Retry: Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Purpose:** Search active MCP tool metadata for candidate capabilities; never reads domain records or executes tools.

**Profiles:** full, core-read, payments, loans, disbursements, admin, discovery

**When to use:** Use when unsure which visible MCP capability fits a request.

**Prerequisites:** An active MCP profile connection.

**Effects:** None; read-only metadata or domain read.

**Retry:** Safe to repeat with the identical valid arguments; this read does not require an idempotency key.

**Human confirmation:** Not required for this tool itself.

**Related tools:** None
