# Reverse With Interest Accrual Design

## Goal

ให้การ reverse payment ของ floating loan สามารถ materialize ดอกเบี้ยค้างที่ขาดหายจนถึง business date ของ payment เดิมได้อย่าง atomic, ตรวจสอบย้อนหลังได้ และนำไป reconcile เป็น interest-only payment ได้โดยไม่สร้างเงินรับซ้ำอัตโนมัติ

## Scope

- คงพฤติกรรม `payment.reverse` เดิมไว้สำหรับ reverse ปกติ
- เพิ่ม workflow ใหม่แบบ preview/execute สำหรับ reverse พร้อมดอกเบี้ยค้าง
- รองรับเฉพาะ floating loan และสร้างเฉพาะ `loan_interest_accruals`
- ไม่แก้หรือลบ transaction หรือ accrual เดิม
- ไม่โพสต์ payment ใหม่อัตโนมัติหลัง reverse

## Non-goals

- ไม่เปลี่ยนกติกาการคำนวณดอกเบี้ยที่ backend ใช้อยู่
- ไม่ให้ agent หรือ UI คำนวณเงินเอง
- ไม่รองรับการสร้าง accrual ด้วย SQL หรือคำสั่ง MCP แบบ free-form
- ไม่เปลี่ยน scheduled-loan interest เป็น accrual ledger

## Behavior

`restore_existing_only` เป็นโหมดเดิม: reverse จะคืน `paidAmount` ของ accrual ที่ payment เดิมอ้างถึงเท่านั้น

`ensure_due_through_payment_date` เป็นโหมดใหม่: หลังสร้าง compensating reversal แล้ว เรียก floating-interest materialization ภายใน transaction เดียวกัน โดยใช้ business date ของ `payment.receivedAt` เป็น `throughDate` การ materialization เป็น idempotent ผ่าน unique active accrual ต่อ loan/date และคืนรายการ accrual ที่สร้างหรือ promote ให้ผู้ดำเนินการนำไป reconcile ต่อ

โหมดใหม่ต้องหยุดเมื่อ loan ไม่ active, ไม่มี rate coverage, ไม่สามารถคำนวณ provenance ได้, หรือมี state conflict; ความล้มเหลวต้อง rollback ทั้ง reversal และ accrual materialization

## API/MCP

เพิ่ม command pair ใหม่เพื่อไม่เปลี่ยน frozen `payment.reverse` 1.0:

- `payment.reverse-with-accrual.preview`: read-only preview ของ transaction ที่จะ compensate, accrual เดิม, accrual ที่คาดว่าจะสร้าง, exact through date, hash และ balance version
- `payment.reverse-with-accrual.execute`: destructive write ที่รับ payment intake, reason, `interestAccrualMode`, confirmation, unchanged preview hash/version และ idempotency key

Execute ต้องคืน source payment, reversal transaction IDs, created/promoted accrual IDs, audit IDs และ correlation ID โดยไม่คืน raw evidence หรือ QR payload

## Data provenance

เพิ่มข้อมูล lineage สำหรับ accrual ที่ materialize จาก reversal: source payment intake, source reversal transaction และ materialization reason/source โดยไม่ใช้ `sourceTransactionId` เดิมผิดความหมาย การ insert ต้องเก็บ rate/period/principal snapshot ที่ calculation engine คืนมา

## Atomic sequence

1. Lock payment intake, original transactions, loans และ active accrual rows ตามลำดับ canonical
2. Validate posted/latest/attribution constraints
3. Create compensating reversal transactions and allocation reversals
4. Restore balances and existing accrual paid amounts
5. Materialize missing floating accruals through original payment business date
6. Attach lineage and write one audit event containing created/promoted IDs
7. Refresh loan rollups and commit

## Safety rules

- Default old reverse remains `restore_existing_only`
- New mode is available only through explicit preview/confirmation
- Same idempotency key and same inputs return the original result
- Active accrual duplicate is never inserted
- Accrual correction is append-only; no direct update/delete path is introduced
- A later payment still blocks reversal using existing `REVERSAL_NOT_LATEST` behavior

## Verification

Tests must cover: successful floating reverse with newly materialized due accrual; existing accrual idempotency; principal-only original payment followed by interest-only reconciliation; rollback when rate provenance is unavailable; rejection for scheduled loans; stale preview; duplicate execute; and unchanged legacy reverse behavior.
