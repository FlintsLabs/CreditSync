# Refactor All IDs to UUID Implementation Plan

## Goal Description
Migrate **ALL** database tables from using Serial (Integer) IDs to UUIDs (GUIDs). This supports future scalability, distributed systems availability, and easier data merging.

## User Review Required
> [!WARNING]
> This is a **GLOBAL BREAKING CHANGE**. All existing data will be incompatible. We will DROP all tables and recreate them.

## Proposed Changes

### Database Schema ([schema.ts](file:///home/flintstone/github/CreditSync/backend/src/db/schema.ts))
- Change `id` in **ALL tables** to `uuid("id").primaryKey().defaultRandom()`.
- Update **ALL foreign keys** to `uuid()` type.
    - `users.id`
    - `tenantConfigs.id`
    - `bankProfiles.id`
    - `bankLoans.id` / `bankLoans.bankProfileId`
    - `borrowers.id`
    - `loans.id` / `loans.borrowerId` / `loans.bankLoanId` / `loans.clonedFromLoanId`
    - `transactions.id` / `transactions.loanId`
    - `files.id`
    - `botUploads.id` / `botUploads.fileId`
    - `bankTransactions.id` / `bankTransactions.bankLoanId`

### Backend Modules
Update input validation (change `t.Numeric()` or `t.Number()` to `t.String()` for IDs) in:
- `backend/src/modules/auth.ts` (if any ID used)
- `backend/src/modules/bank-profiles.ts`
- `backend/src/modules/bank-loans.ts`
- `backend/src/modules/borrowers.ts`
- `backend/src/modules/loans.ts`
- `backend/src/modules/transactions.ts`
- `backend/src/modules/files.ts`
- `backend/src/modules/webhook.ts`

### Frontend Application
- **Search & Replace**: Find usages of `number` type for IDs in interfaces and change to `string`.
- **Logic**: Remove any `parseInt(id)` or `Number(id)` before sending to API.
- **Routing**: Ensure routes like `/dashboard/loans/:id` handle UUID strings (should be automatic).

## Verification Plan

### Manual Verification
1.  **Reset DB**: Delete `backend/drizzle` folder (if any migrations exist) or just force push schema.
2.  **Start Backend**: Verify Drizzle applies new schema.
3.  **Frontend Walkthrough**:
    - Login (creates `users` record with UUID).
    - Create Bank Profile (UUID).
    - Create Borrower (UUID).
    - Create Loan (UUID).
    - Upload File (UUID).
    - Verify all linkages work (Foreign Keys).
