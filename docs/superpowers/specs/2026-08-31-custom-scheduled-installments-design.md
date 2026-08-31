# Custom Scheduled Installments Design

## Goal

รองรับสินเชื่อแบบรายสัปดาห์หรือรายเดือนที่กำหนดจำนวนงวดและยอดชำระต่องวดเอง เช่น เงินต้น ฿30,000.00 ดอกเบี้ยรวม ฿20,000.00 และชำระ ฿5,000.00 จำนวน 10 งวดรายสัปดาห์

## Current limitation

ตัวคำนวณกำหนดจำนวนงวดของสินเชื่อรายสัปดาห์เป็น `termMonths * 4` และไม่ใช้ `totalInstallments` หรือ `installmentAmount` เป็น custom schedule ทำให้สัญญา 10 งวดไม่สามารถแสดงผลตรงตามข้อตกลงได้

## Chosen design

- สำหรับ `weekly` และ `monthly` ถ้ามี `totalInstallments` และ `installmentAmount` ให้ถือเป็น custom fixed-total schedule
- จำนวนงวดที่ระบุเป็นแหล่งความจริงของตาราง; `termMonths` ยังคงเป็นฟิลด์ที่จำเป็นเพื่อความเข้ากันได้ของ API แต่ไม่ใช้กำหนดจำนวนงวดในโหมด custom
- ยอดรวมสัญญา = `installmentAmount × totalInstallments`; ดอกเบี้ยตามตาราง = ยอดรวมสัญญา - เงินต้น
- กระจายเงินต้นและดอกเบี้ยด้วย `FinancialDecimal` และให้แถวสุดท้ายรับเศษจากการปัดทศนิยม
- ถ้ามีเพียงหนึ่งในสองฟิลด์ custom ให้ reject ด้วย validation ที่ชัดเจน
- ถ้าไม่ได้ระบุ custom pair ให้คงพฤติกรรมเดิม: weekly ใช้ 4 งวดต่อเดือน, monthly ใช้ 1 งวดต่อเดือน และคำนวณดอกเบี้ยจากอัตรารายปี
- ห้ามให้ยอดรวม custom ต่ำกว่าเงินต้น
- ใช้วันเริ่มชำระที่มีอยู่ (`paymentStartDate` ถ้ามี มิฉะนั้น `startDate`) และเพิ่มทีละ 1 สัปดาห์หรือ 1 เดือนตาม repayment type

## Example

สำหรับ `principal=30000.00`, `totalInstallments=10`, `installmentAmount=5000.00`, `repaymentType=weekly`, `startDate=2026-08-31`, `paymentStartDate` ไม่ระบุ:

- 10 งวด วันที่ 2026-09-07 ถึง 2026-11-09
- แต่ละงวด: เงินต้น ฿3,000.00 + ดอกเบี้ย ฿2,000.00 = ฿5,000.00
- ดอกเบี้ยรวม ฿20,000.00 และเงินต้นคงเหลือเป็นศูนย์ในงวดสุดท้าย

## Scope

- Backend calculator, normalization, loan preview/draft/activation paths, and route/MCP contract tests
- Frontend loan workflow model/form/preview so custom weekly/monthly terms are preserved and visible
- Locales, README guidance if workflow/setup behavior changes, and CHANGELOG
- No migration is required: existing `installmentAmount` and `totalInstallments` columns already exist; semantics are extended only when both are supplied

## Safety and compatibility

- Existing daily custom schedules remain unchanged
- Existing weekly/monthly requests without both custom fields remain unchanged
- Financial values remain decimal strings and all calculations use `FinancialDecimal`
- No payment, disbursement, draft, or activation is created as part of this implementation

## Verification

- Unit tests prove custom weekly/monthly schedule behavior, mismatch validation, residual allocation, and legacy behavior
- Backend route/MCP tests prove preview and draft serialization
- Frontend tests prove form model serialization and preview display
- Run backend disposable PostgreSQL tests/typecheck and frontend test/lint/build as available
