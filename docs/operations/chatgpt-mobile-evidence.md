# ChatGPT mobile evidence ingestion

This runbook covers the private MCP paths for attachments supplied by ChatGPT on a mobile client. These are evidence-ingestion paths only: the backend binds a verified attachment to the selected payment intake or loan-disbursement draft and returns a safe ready result. Importing does not create a payment intake, activate a loan, change a loan schedule, or post a payment or payout.

## Support boundary

The importer accepts exactly one opaque file parameter together with an existing draft and a stable retry key:

```json
{
  "disbursementPublicId": "<draft public UUID>",
  "idempotencyKey": "<stable import key>",
  "chatgptFile": {
    "download_url": "<HTTPS URL supplied by the platform>",
    "file_id": "<opaque platform file ID>",
    "mime_type": "image/jpeg",
    "file_name": "optional-name.jpg"
  }
}
```

The server authorizes the exact tenant-owned draft before any download. It then validates HTTPS host policy, DNS-resolved addresses, TLS hostname, redirects, response MIME, file signature, byte limit, and SHA-256 before storage finalization. Results and logs contain public record IDs, status, audit ID, and correlation ID only; do not copy file IDs, URLs, signed URLs, QR payloads, account details, raw bytes, or raw OCR into chat or telemetry.

The current automated gates use synthetic responses, storage doubles, disposable PostgreSQL, the scripted MCP eval harness, and the plugin validator. No authorized iOS or Android device session has been run for this change. Therefore actual-device transport, app-version compatibility, attachment handoff, and mobile-network behavior remain pending acceptance gates; this document does not claim them as tested.

## Device acceptance checklist

Record the device platform, OS/app version, test date, connection type, tenant/profile, and synthetic fixture checksum without recording the attachment URL or file ID. Run the checklist separately for payment and payout workflows on each platform/connection; a successful payout test does not establish payment compatibility. For each combination, verify:

1. Attach a synthetic JPEG, PNG, and PDF from the supported ChatGPT mobile flow.
2. Call read-only `workflow.resolve` at the start of the intent and again after an attachment, stale-state, failed-import, or version change. Then resolve and inspect the exact target, and call the appropriate importer once per required attachment with a stable key: `evidence.import-chatgpt-file` with `paymentIntakePublicId` for an unposted payment intake, or `loan.disbursement.evidence.import-chatgpt-file` with `disbursementPublicId` for a payout draft. Both take the top-level `chatgptFile` object shown above. Create/select the intake or draft as a separate reviewed workflow step; never substitute one target type for another. Resolver output is guidance only and never authorizes, confirms, persists a preview, or invents a future ID.
3. Confirm each result is `ready`, then read back the exact target using `intake.get` or `loan.disbursement.list`. Verify every required attachment association and the returned audit receipt. A ready upload proves file verification, not recipient, loan, or financial correctness; review those separately before any financial transition.
4. Simulate an interrupted response and retry the same key. Confirm the ready retry performs no second fetch, upload, or finalize, including when the original URL has expired.
5. Exercise unavailable, unreported/omitted, unsafe-host, MIME/signature mismatch, oversized, target-conflict, and recipient-mismatch stops. Confirm the target remains unposted and no activation or post call occurs. If the connection cannot advertise `workflow.resolve`, stop attachment-bearing writes and request a profile refresh/reconnect; do not invent a resolver call or signed URL.
6. Only after all attachments have been reviewed and a human confirms the exact current variance and recipient may a separate financial transition be tested in an authorized non-production tenant.

Capture sanitized outcomes such as `ready`, `pending`, `review_required`, elapsed time bucket, and failure category. Never retain platform identifiers, URLs, bearer material, evidence contents, or posted financial records in a mobile test log.

Acceptance matrix at implementation time (no real-device sessions executed):

| Platform | Payment intake import/read-back/retry | Payout draft import/read-back/retry |
| --- | --- | --- |
| ChatGPT iOS, each configured connection | Pending | Pending |
| ChatGPT Android, each configured connection | Pending | Pending |

Late evidence for an already-posted payment is a separate append-only flow: use `payment.evidence-supplement.import-chatgpt-file`, then obtain explicit confirmation and a reason before `payment.evidence-supplement.record`. Do not use ordinary intake evidence import or repost the payment. If this connection advertises that flow as supported, record a separate device acceptance result for it.

## Stop and recovery rules

- A missing or unavailable attachment is a hard stop for an image-first request; do not fall back to evidence-free posting.
- Reuse an idempotency key only for the identical draft and file identity. A different target, file identity, content, or tenant requires review and a new human-approved workflow.
- A pending result after storage failure may be retried with the same key. Do not delete or recreate the draft evidence intent to force progress.
- A `ready` retry is a read of the existing association. Do not fetch, PUT, finalize, or upload again.
- Mobile transport defects are reported with the sanitized category and correlation ID. Do not work around them by using REST, SQL, a guessed URL, or a payment-intake importer.
