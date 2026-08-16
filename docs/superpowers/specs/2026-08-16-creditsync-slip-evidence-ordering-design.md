# CreditSync slip evidence ordering design

## Goal

Make the CreditSync plugin attach supplied payment-slip images before posting a payment, while preserving data-only payment capture when no image is supplied.

## Scope

- Update the `reconcile-payments` skill and root CreditSync guidance so image-first capture is an explicit hard prerequisite for posting.
- Keep structured data-only capture unchanged when no slip is present.
- Extend the scripted plugin evals and tests to prove ordering, duplicate handling, upload effects, and stop-before-post behavior.
- Do not change the MCP tool contract or backend accounting behavior.

## Workflow

For a request containing one or more slip images:

1. Extract only supported payment fields and calculate each image's exact byte size and SHA-256 locally.
2. Create the payment intake with a stable idempotency key.
3. Stop on a hard intake duplicate and inspect the original; do not prepare or upload evidence.
4. For each supplied image, call `evidence.prepare` and inspect the result.
5. Stop on an evidence duplicate, missing/expired upload descriptor, checksum/metadata mismatch, or any upload/finalize failure. Do not preview or post.
6. PUT unchanged bytes using the returned signed URL and required headers, then call `evidence.finalize`.
7. Verify every finalized evidence item is `ready` and remains bound to the prepared evidence/file identity, MIME type, size, and SHA-256.
8. Resolve borrowers and portfolios, call `payment.preview`, and post only the latest `ready` proposal. A stale proposal requires re-preview; evidence remains a prerequisite.

For a request without images, use the existing intake → preview → post data-only flow. Do not manufacture evidence or block a valid data-only payment because no slip was supplied.

## Duplicate and safety boundaries

- A hard intake duplicate or evidence duplicate returns the original public ID and stops without a second financial record.
- Semantic duplicate warnings remain review signals and do not authorize bypassing evidence or posting.
- Evidence is optional only when the request is explicitly data-only; if an image is supplied, `evidence.ready` is mandatory before posting.
- Signed URLs, raw QR payloads, evidence contents, bearer tokens, and full private tool payloads stay out of user-facing logs and reports.
- The backend remains the authority for matching, allocations, exact money values, and posting readiness.

## Verification

- Keep positive eval coverage for data-only payments and add/retain positive slip coverage with `evidence.prepare → evidence.put → evidence.finalize → payment.preview → payment.post`.
- Add negative coverage proving missing upload data, finalize failure/binding mismatch, and evidence duplicate stop before preview/post.
- Assert unchanged upload bytes, declared size, and SHA-256 in the scripted harness.
- Run plugin tests, validator, and the repository's applicable contract checks.

