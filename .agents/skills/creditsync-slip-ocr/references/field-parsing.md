# Thai Payment Slip Field Parsing

Guidance for turning raw OCR text into structured candidate fields. All values
extracted here are **candidates for human confirmation**, never authoritative
financial data.

## Target fields

| Field | Slip wording (typical) | Notes |
|---|---|---|
| `transferredAt` | e.g. `12 เม.ย. 69 18:55 น.` | Thai Buddhist year (ค.ศ. = BE). Subtract 543 to get CE. Banks vary: 69 = 2026. |
| `payerName` | near `จาก` / above "โอนเงินสำเร็จ", often prefixed ด.ญ./น.ส./นาย | Honorific is part of the account display name, not the borrower record. |
| `receiverName` | near `ถึง` / `รับเงิน` | Should match the operator's receiving account profile; mismatch is a warning. |
| `amount` | `จำนวน: 150.00 บาท` | Two-decimal THB string. Beware OCR turning 0 into ๐ or digits into noise. |
| `fee` | `ค่าธรรมเนียม: 0.00 บาท` | Usually 0 for PromptPay. |
| `reference` | `เลขที่รายการ: 016102185528BPP05515` | Alphanumeric; use for duplicate detection (hash it before storing/logging). |

## Thai month tokens and common OCR confusions

Months: ม.ค. ก.พ. มี.ค. เม.ย. พ.ค. มิ.ย. ก.ค. ส.ค. ก.ย. ต.ค. พ.ย. ธ.ค.

Frequent misreads on small fonts:

- `เม.ย.` misread as `ม.ค.` / `เมย` / `เม.ูย` — when the date is ambiguous, prefer the crop region over the full-image read and flag the ambiguity.
- `วันวิสา` vs unrelated names — compare against the borrower's known `payer_name` history before claiming a match.
- Leading zeros in reference numbers may be dropped; length-check (K+ ~20 chars ending in digit cluster).

## Cross-checking workflow

1. Parse from both `full` and the zoomed crops. If a field disagrees between
   reads, treat it as ambiguous and say so in the output.
2. Compare `payerName` against `payment_intakes.payer_name` history for the
   candidate borrower.
3. Compare `transferredAt` against the loan schedule (`loan_schedules.due_date`)
   — payments normally land on or near a due date.
4. Never conclude "this slip is valid for loan X" from OCR alone; present the
   evidence and let the human confirm before any MCP write (intake → preview →
   explicit confirmation → post).
