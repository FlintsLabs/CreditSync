# implementation_plan.md

# Application Implementation Plan: CreditSync

## Goal Description
Build a **Multi-tenant, Mobile-First Loan Management System**.
Key features: **Role-Based Access**, **Cloudflare Tunnel Access**, **Webhook Automation (Line Bot)**, and **S3 Storage**.

## User Review Required
> [!IMPORTANT]
> **Frontend Framework**: I recommend **React (Vite)** over Next.js.
> *Reason*: You already have a dedicated high-performance backend (Bun + Elysia). Next.js would add a redundant server layer and complexity (double routing). React (Vite) allows for a clean "Static Client + API Server" architecture which is easier to deploy and scale in K8s.
> **Cloudflare**: Token management is critical. We will use K8s Secrets (`secret.yaml`) to store the Tunnel Token, never in GIT.

## Proposed Changes

### 1. Foundation & Infrastructure
#### [NEW] [k8s/tunnel.yaml](file:///mnt/c/Users/FT/Documents/AzureDevOps/CreditSync/k8s/tunnel.yaml)
- Deployment for `cloudflared` connected to the `frontend` and `backend` services.

#### [MODIFY] [backend/src/db/schema.ts](file:///mnt/c/Users/FT/Documents/AzureDevOps/CreditSync/backend/src/db/schema.ts)
- Add `tenant_config` table (webhook_secret, line_channel_token).
- Add `bot_uploads` table for files from webhooks (pending verification).

### 2. Feature: Advanced Automation (Webhooks)
#### [NEW] [backend/src/modules/webhook.ts](file:///mnt/c/Users/FT/Documents/AzureDevOps/CreditSync/backend/src/modules/webhook.ts)
- Endpoint `POST /webhook/line`: Verifies signature -> Downloads content -> Uploads to MinIO (Private Bucket) -> Records in `bot_uploads`.

### 3. Feature: Borrower Profile & OCR
- (Same as previous: OCR Service, Borrower Form)

### 4. Feature: Advanced Loan Calculator
- **Backend**: `calculator.ts` (Financial Logic), `loans.ts` (API).
- **Frontend**: `LoanWizard.tsx` (3-Step Form with Schedule Preview).
- **Status**: Completed.

### 5. Feature: Transaction Management
- **Backend**: `transactions.ts` (API for Repayment with Slip Upload).
- **Frontend**: `TransactionList.tsx` (History), `TransactionForm.tsx` (Record Paymemt).
- **Status**: In Progress (Manual Recording done).

## Verification Plan
### Infrastructure Verification
- **Tunnel Check**: Access `https://app.yourdomain.com` -> Should load React App.
- **Webhook Test**: Send a mock POST request with a dummy image to `/webhook/line` -> Verify file appears in MinIO folder `uploads/bot/<tenant_id>/`.
### Manual Verification
- **RBAC**: Login as Viewer -> Try to edit Loan -> Should fail.
- **Traceability**: Link Bank Loan -> Customer Loan -> Verify ROI calculation.
