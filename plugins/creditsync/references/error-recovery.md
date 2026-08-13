# CreditSync error recovery

Tool errors have `{ code, message, retryable, reviewRequired, details }`. Treat the flags and current record as authoritative; never infer success from a timeout.

| Error class | Recovery |
| --- | --- |
| unauthorized/forbidden | Stop. Verify private app connection and server-configured actor; never switch tenant or identity in tool input. |
| rate limited / retryable transport | Retry after the indicated delay with the same intent and idempotency key. Inspect the record before retrying a write. |
| duplicate | Retrieve the public ID in the response and report the original. Do not create another intake. |
| ambiguous / mismatch / `reviewRequired` | Show safe candidate context, obligations, warnings, and difference. Wait for a human selection. |
| stale / expired / not latest | Re-read the intake, loan, renewal, or settlement target, then request a new preview. Previous approval does not carry over. |
| settlement balance/accrual changed | Stop. Re-inspect the borrower portfolio, create and show a fresh settlement preview, and obtain fresh confirmation before a new execute attempt. |
| rate accrued-date / overlap conflict | Re-list the floating timeline and honor `earliestEditableDate`; never rewrite an accrued day or force overlapping periods. |
| already posted/executed/reversed | Retrieve current state. If it matches the intended idempotent operation, report that result rather than issuing a new intent. |
| reversal blocked | Identify and reverse later downstream activity in reverse chronological dependency order, then inspect again. |
| invalid schema/output | Stop and report a plugin/app contract incompatibility. Do not retry with guessed fields. |
| internal/retryable | Preserve the correlation ID, retry once only when safe, then escalate without exposing payloads or stack traces. |

Never include bearer tokens, raw QR payloads, signed URLs, evidence contents, full identity-card values, or private tool payloads in error reports. A changed reason, allocation, preview, or target is a new intent and must not reuse another intent's idempotency key.
