# Production Bruno Financial Flows Design

## Goal

Create a Bruno CLI collection for operators to inspect borrower contracts, create floating daily-interest contracts, and record payments with slip evidence through CreditSync's authenticated REST API.

## Agreed scope

- Target environment: production.
- Contract creation is a preview followed by draft creation; activation is a separate request that the operator must run deliberately.
- Payment recording is a sequence of separate requests: create intake, prepare evidence, direct signed upload, finalize evidence, preview allocations, and post. Posting is a separate final request that the operator must run deliberately.
- The collection is a manually stepped operational workflow, not an unattended orchestration script.
- Use the backend as the sole authority for loan calculations, floating interest, and payment allocations.
- Never include real borrower records, production credentials, signed URLs, slip images, or other tenant data in the committed collection.

## Approaches considered

1. A modular Bruno collection with one request per workflow step. Chosen because operators can inspect each production response before continuing.
2. A scripted sequence that automatically executes multiple mutations. Rejected because it could activate contracts or post payments without an operator reviewing the intermediate results.
3. A read-only collection plus a separate write tool. Rejected because it does not fulfill the requested contract creation, payment, and slip upload flow.

## Collection design

Create a repository-owned collection at `bruno/creditsync-production/` using the native Bruno collection and `.bru` request formats. Group requests into authentication, borrower and loan inspection, floating daily-loan origination, and payment with evidence. Include concise request-level notes describing required inputs, state dependencies, and the next safe step.

Authentication uses the existing `POST /auth/google` route with an operator-provided Google ID token, then stores the returned CreditSync access token for subsequent bearer-authenticated requests. Production host and all credentials remain operator-configured environment values; the committed environment contains placeholders only.

Inspection requests cover borrower search/portfolio and loan list/detail, schedule where applicable, floating interest rates, and loan payment history. All lookup requests use public UUIDs and expose backend values without reproducing financial calculations in scripts.

Floating daily origination includes:

1. `POST /loans/preview` with operator-supplied terms.
2. `POST /loans` to create an editable draft after the operator reviews preview output.
3. `GET /loans/:id` to inspect the saved draft.
4. `POST /loans/:id/activate` as a separate, manually selected request.

Payment and slip evidence includes:

1. `POST /payment-intakes` with exact two-decimal amount, received timestamp, payer, and origin loan public UUID; require a unique idempotency key.
2. `POST /payment-intakes/:id/evidence/upload-intents` with exact MIME type, byte size, and SHA-256 of the selected slip.
3. `PUT` the slip bytes directly to the returned signed upload URL, using exactly the returned required headers and no bearer token.
4. `POST /payment-intakes/:id/evidence/:evidenceId/finalize`.
5. `POST /payment-intakes/:id/match-preview` with explicit borrower/loan allocation when needed; show the backend response for operator review.
6. `POST /payment-intakes/:id/post` with the reviewed preview public UUID as a separate manually selected request.

No collection script automatically runs the next request, activates a loan, or posts a payment. Retries of mutations must preserve the same exact payload and idempotency key; changed payloads require a new reviewed workflow. Do not persist QR payloads, raw identity values, slip contents, or full bank references into collection variables or request notes.

## Error handling and safety

- Make auth, production base URL, public IDs, financial input strings, idempotency keys, and slip metadata explicit environment/request inputs.
- Keep secret values outside Git and avoid printing bearer tokens, upload URLs, private evidence, or financial identifiers in CLI output and saved reports.
- Explain that a signed upload URL is short-lived and is used only for the direct storage PUT.
- Stop if identity resolution is ambiguous, contract ownership or status does not match, a payment is duplicate or stale, evidence is not finalized, preview is not `ready`, allocation totals do not match, or any warnings/variance remain. These cases require human investigation rather than an automated retry or post.
- Distinguish a successful HTTP response from a successfully posted payment; verify returned intake status and transactions after posting.
- Do not run the production mutation requests as part of collection validation.

## Acceptance criteria

- Bruno CLI can parse/lint and list/run a harmless read-only request from the collection without sending production mutation requests.
- Every requested workflow action has a concrete request matching the backend route and request schema.
- Signed slip upload uses the prepared URL and exact required headers, and evidence finalization is a distinct next step.
- Activation and payment posting are distinct requests that are never automatically chained.
- Collection variables and examples contain no production secrets, borrower identifiers, realistic financial data, or real evidence.
- A README explains environment setup, required manual inputs, request order, safe CLI usage, and which requests mutate production.

## Out of scope

- Changing backend REST routes or MCP tools.
- Performing production loan, payment, activation, upload, or posting requests.
- OCR, borrower resolution, automatic contract matching, or client-side financial calculations.
- General scheduled-loan support or disbursement flows; this collection's origination example is floating daily-interest as requested in context.
- Automated retries, environment provisioning, account creation, or deployment.
