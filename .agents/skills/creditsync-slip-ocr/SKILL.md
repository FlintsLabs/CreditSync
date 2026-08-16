---
name: creditsync-slip-ocr
description: Extract structured fields (date, payer, receiver, amount, reference) from Thai payment slips / transfer receipts for CreditSync lending operations. Use whenever the user shares a payment slip image (K+, PromptPay, bank transfer receipt), asks to ตรวจสลิป / อ่านสลิป / ตรวจสอบการชำระ, or wants OCR of borrower payment evidence — even if they don't say "OCR".
---

# CreditSync Payment Slip OCR

Read Thai payment slip images and turn them into structured, human-confirmable
field candidates. OCR output is evidence for review, never a financial write.

## Workflow

1. **Locate the image.** If the user attached a file, use that path (often under
   a prompt-attachments temp dir). If the slip exists in the system (payment
   evidence), fetch it from MinIO/storage instead of asking the user to re-send.
2. **Run the OCR script** (Bun, ~2–3s, caches deps in `~/.cache/creditsync-slip-ocr`):
   ```bash
   bun <skill-dir>/scripts/ocr.ts <image-path>
   ```
   It prints JSON with `full` (whole image) plus zoomed 4x crops `date`,
   `sender`, `receiver` — small Thai fonts misread at full scale, and the crops
   exist to verify the critical fields.
3. **Parse fields.** Read `references/field-parsing.md` and extract:
   `transferredAt` (convert Buddhist year), `payerName`, `receiverName`,
   `amount`, `fee`, `reference`. When `full` and a crop disagree on a field,
   prefer the crop but report the disagreement as an ambiguity.
4. **Cross-check before claiming a match.** For "is this borrower X's payment?":
   - Compare `payerName` with the borrower's payment history
     (`payment_intakes.payer_name` via psql or MCP).
   - Compare `transferredAt` with `loan_schedules.due_date` for the loan.
   - Match `receiverName` against the operator's receiving profile.
   Disagreement on any of these = ambiguous, not a match. State it plainly.
5. **Report** a field table plus confidence notes, then stop.

## Hard rules

- Never log or echo the raw OCR text into permanent files, commits, or
  changelogs — it contains personal data (names, account numbers).
- Never post a payment, create an intake, or attach evidence based on OCR
  alone. Ambiguity (name mismatch, date outside the loan, unreadable field)
  always stops for human review. Only a clearly valid, human-confirmed result
  may continue into the MCP payment workflow.
- Money stays a two-decimal string; do not convert to Number.
