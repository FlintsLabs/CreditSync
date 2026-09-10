# Independent checkpoint review — must fix before acceptance

Partial diff against fde6b51 is NOT accepted. Reviewer found:

1. Execute validates stored hashes only then fresh previewPaymentMatch: lacks recomputed financial state/revision/membership/evidence and exact components parity. Must reject stale confirmed semantics.
2. Execute still iterates itemOrder, not actual chronological sequence. Shuffle09/07/08 integration must match07/08/09.
3. Floating previews repeatedly plan from same DB state; no projected consumed accruals. Scheduled components still all principal. Need shared authoritative sequential projection.
4. Chronology discovers standalone drafts only via originLoanId, missing resolved proposal allocations. Single post still intake/loan lock protocol and no batch-member rejection. All writers borrower-first locking needed.
5. Staging evidence checks tenant but NOT owner batch access; ready evidence still signed PUT; no expiry/MIME/maxsize checks. Must reuse existing access/storage policy and immutable ready return.
6. Stage A+B, review only A: preview/execute considers A alone and posts subset! Require all original staging members reviewed/evidence-ready unless explicit audited split. Review must lock parent, reject cancelled/posted, increment revision/invalidate preview.
7. Restore combines provenance by loan (40+60 =>100) but execute searches amount40/60 separately; preview incorrectly ready. Missing provenance also ready. Ensure complete per-source coverage and consistent mapping.
8. Restore reuses preview plans without current capacity check; later payments can consume reversed accrual. Need append-only downstream reflow or preview failclosed (full approved plan includes reflow, not merely blocking).
9. Review retry returns numeric IDs and ignores changed amount/time/key; execute retries return empty audit/newcorrelation without checking stored requesthash. Persist exact immutable receipts with fingerprint.

Still required: actual multi-borrower input/resolution, audited revision-bound gap acknowledgement/reason/range, split/dependencies, conditional schedule/floating DB constraints, immutable receipts/provenance, actual DB tests (not source text), UI fourstep upload OCR, MCP contract sync. No completed boxes until acceptance truly met.

## Immediate worker checkpoint

Work ONLY on Task 1 staging/evidence/review safety for this checkpoint, not UI/restore/floating code. Preserve all existing partial changes; do not revert user/supervisor files. Finish read-only snapshot of existing review gaps. Then TDD actual disposable DB tests for: stage A+B reviewA blocks preview/execute; cancelled/posted parent rejects write; tenant-local restricted actor access rejects; ready prepare no PUT; expiry/MIME/size; samekey samepayload exact public-UUID receipt; samekey changedpayload conflict; batch revision invalidation; concurrent review exactly one intake; zero transactions throughout. Implement proper append-only operation receipts and evidence immutability. Use current uncommitted0065 only (never published), no rewrite prior migrations. Run targeted DB suite+typecheck. Do NOT commit whole mixed diff. Report changed Task1 files and test results, then stop at this checkpoint so supervisor can review before assigning remaining tasks. Full user task remains incomplete.
