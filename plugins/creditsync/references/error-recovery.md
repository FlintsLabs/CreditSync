# CreditSync error recovery

Tool errors have `{ code, message, suggestedAction, retryable, reviewRequired, repreviewRequired, humanReviewRequired, details, correlationId }`. Treat the flags and current record as authoritative; never infer success from a timeout. `repreviewRequired` invalidates prior approval; `humanReviewRequired` stops the workflow for an operator decision.

For unexpected, repeated retryable, database/cache/network/storage, or external-service failures, call `system.error-diagnostic.get` with the returned correlation ID as a read-only follow-up. Use `system.error-diagnostic.list` only with a bounded narrowing filter or a window of at most 24 hours when no correlation ID is available. A missing diagnostic can mean persistence timeout or retention expiry and is never proof of command failure. Diagnostics do not authorize bypassing confirmation, duplicate, mismatch, stale-preview, idempotency, or human-review boundaries.

| Error class | Recovery |
| --- | --- |
| unauthorized/forbidden | Stop. Verify private app connection and server-configured actor; never switch tenant or identity in tool input. |
| rate limited / retryable transport | Retry after the indicated delay with the same intent and idempotency key. Inspect the record before retrying a write. |
| duplicate | Retrieve the public ID in the response and report the original. Do not create another intake. |
| ChatGPT file unavailable / disallowed host / unsafe address / MIME, magic, size, or checksum mismatch | Stop before payment preview or post. Retry only an identical transient failure with the same idempotency key; never reveal the file parameter, URL, ID, bytes, or storage details. |
| supplemental evidence not ready / wrong payment state | Stop. Re-inspect the exact posted payment; import again only as an identical retry, and record only after explicit confirmation with a reason. |
| ambiguous / mismatch / `reviewRequired` | Show safe candidate context, obligations, warnings, and difference. Wait for a human selection. |
| stale / expired / not latest | Re-read the intake, loan, renewal, or settlement target, then request a new preview. Previous approval does not carry over. |
| scheduled allocation correction stale/dependent/overpayment | Re-inspect the exact posted intake, source/target schedules, loan, and dependencies; preview again and stop on any blocker. Execute only a fresh ready preview after explicit confirmation; reuse the key only for identical guards, reason, and preview. |
| settlement balance/accrual changed | Stop. Re-inspect the borrower portfolio, create and show a fresh settlement preview, and obtain fresh confirmation before a new execute attempt. |
| rate accrued-date / overlap conflict | Re-list the floating timeline and honor `earliestEditableDate`; never rewrite an accrued day or force overlapping periods. |
| `FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION` | Do not post. Inspect the exact ready intake, obtain confirmation for `payment.reconcile.mark-review`, then run a fresh reconciliation preflight/preview and obtain a separate confirmation before execute. Other preflight errors are not eligible for this transition. |
| already posted/executed/reversed | Retrieve current state. If it matches the intended idempotent operation, report that result rather than issuing a new intent. |
| reversal blocked | Identify and reverse later downstream activity in reverse chronological dependency order, then inspect again. |
| waiver reason/confirmation required | Stop and obtain the exact component, amount, specific reason, and explicit approval; never supply a generic invented reason. |
| unexpected restructure cash | Stop and show the backend cash direction/amount and optional disbursement-draft boundary; do not execute until explicitly accepted. |
| invalid schema/output | Stop and report a plugin/app contract incompatibility. Do not retry with guessed fields. |
| internal/retryable | Preserve the correlation ID, retry once only when safe, then escalate without exposing payloads or stack traces. |

Never include bearer tokens, raw QR payloads, signed URLs, evidence contents, full identity-card values, or private tool payloads in error reports. A changed reason, allocation, preview, or target is a new intent and must not reuse another intent's idempotency key.
