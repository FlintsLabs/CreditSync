# MCP Intake Evidence Contract Repair Design

## Problem

`intake.get` fails with `INVALID_TOOL_OUTPUT` whenever an intake has evidence. The payment service intentionally returns a tenant-scoped public `filePublicId` for each evidence row, but the strict MCP output schema does not declare that property. The MCP boundary therefore rejects an otherwise valid service response.

The existing all-tools test calls `intake.get` before evidence is prepared or finalized, so its empty evidence array does not exercise the failing contract path.

## Goals

- Make `intake.get` return finalized evidence through the strict public MCP contract.
- Preserve `filePublicId` as a nullable public UUID so agents can identify whether a protected file reference is available without exposing object keys, signed URLs, tokens, or evidence contents.
- Add a regression test that fails on the current contract mismatch and passes after the schema repair.
- Keep the frozen CreditSync plugin contract and validator output synchronized.
- Deploy the repaired backend and verify the previously failing production intake read without performing any financial write.

## Non-goals

- No changes to payment matching, allocation, posting, reversal, or intermediary-remittance behavior.
- No database migration or stored financial-data mutation.
- No change to the evidence upload/finalize lifecycle.
- No relaxation of strict MCP output validation.
- No frontend changes; the existing Payment Inbox already consumes the safe public file UUID.

## Design

### Public contract

Extend only the evidence item inside the `intake.get` output schema with:

```ts
filePublicId: uuid.nullable()
```

The field remains required on returned evidence rows and nullable when an evidence record has no attached tenant-owned file. The surrounding evidence object remains strict. This matches the existing service presenter and avoids allowing undeclared fields through the MCP boundary.

### Regression coverage

Add a real MCP integration path that creates an intake, prepares and finalizes evidence, then calls `intake.get`. Assert that the call succeeds and that the evidence row contains the finalized public evidence UUID and nullable/public-UUID `filePublicId` contract. The test must be observed failing with `INVALID_TOOL_OUTPUT` before the schema change.

The existing service-level evidence tests remain useful for tenant ownership and lifecycle behavior, but they do not replace the MCP boundary regression because the defect exists between the service response and the strict MCP output schema.

### Frozen plugin contract

Regenerate the frozen MCP tool contract using the repository's existing generator and run the CreditSync plugin validator/tests. The generated `intake.get` evidence schema must expose `filePublicId` as a UUID-or-null field while retaining closed object schemas. Keep plugin manifest/version unchanged if the repository validator accepts this additive repair; change metadata only if the existing synchronization tooling explicitly requires it.

### Error and security behavior

Invalid service responses must continue to return sanitized `INVALID_TOOL_OUTPUT`. The repair must not expose storage object keys, upload URLs, signed access URLs, raw evidence contents, or internal numeric IDs. `filePublicId` is only an opaque tenant-scoped public identifier; protected evidence access continues through the existing authenticated file-access endpoint.

## Verification and deployment

Run the focused MCP regression test, MCP server contract suite, backend typecheck, applicable plugin tests, and plugin validator/contract checks. No disposable PostgreSQL suite is required unless the selected regression uses database-backed service setup; if it does, use the repository's serialized disposable PostgreSQL script.

Commit the code, generated contract, tests, documentation, and changelog together as required by repository policy. Deploy by rebuilding only the production backend with `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend`. Then inspect backend startup/migration logs, check MCP health from inside the backend container, and call `intake.get` on a previously failing evidence-bearing intake. Production verification is read-only and must not preview, post, reverse, or otherwise mutate financial records.

## Success criteria

- `intake.get` succeeds for evidence-bearing intakes and returns `filePublicId` without leaking protected storage data.
- The regression test demonstrates red-before-fix and green-after-fix behavior.
- The frozen MCP contract and CreditSync plugin validator/tests pass.
- Backend typecheck and relevant tests pass.
- Production MCP health is successful and a previously failing intake can be inspected read-only after deployment.
