# CreditSync Task List

- [x] **Phase 1: Foundation & Infrastructure**
    - [x] Analyze existing repository structure <!-- id: 0 -->
    - [x] Define Tech Stack (Bun, Elysia, React, Vite, Tailwind, PostgreSQL) <!-- id: 1 -->
    - [x] **[NEW] Configure Cloudflare Tunnel (Ingress & Secret Management)** <!-- id: 32 -->
    - [x] Configure MinIO (S3 Compatible) for Local Storage <!-- id: 25 -->
    - [x] Update Schema: Add `tenant_id` to all tables for Multi-tenancy <!-- id: 26 -->
    - [x] Setup Google OAuth (Sign in with Google) <!-- id: 3 -->
    - [ ] Configure Kubernetes Manifests for local deployment (inc. MinIO) <!-- id: 4 -->

- [/] **Phase 2: Authentication & RBAC**
    - [x] Implement Roles: Owner, Manager, Collector, Viewer <!-- id: 27 -->
    - [ ] Middleware: Auth & Tenant Context Injection <!-- id: 28 -->
    - [/] Frontend: Login Page with Google Button <!-- id: 29 -->

- [ ] **Phase 3: Fund Management & Dashboard**
    - [x] Backend: Bank Profile & Bank Loan CRUD (Tenant-scoped) <!-- id: 5 -->
    - [x] Frontend: Dashboard for Bank Loans (Interest/ROI/Balance) <!-- id: 7 -->

- [/] **Phase 4: Borrower Profile & OCR**
    - [x] Backend: Borrower CRUD with S3 Image Upload <!-- id: 8 -->
    - [/] Service: OCR Service (Tesseract or Vision API placeholder) <!-- id: 9 -->
    - [x] Frontend: Borrower Registration Form (Upload ID -> OCR) <!-- id: 10 -->

- [/] **Phase 5: Loan Engine & Calculation**
    - [x] Logic: Interest Calculator (Daily, Weekly, Monthly, Floating) <!-- id: 12 -->
    - [ ] Feature: Loan Closing Calculator (Pro-rated + Copy to Clipboard) <!-- id: 30 -->
    - [x] Frontend: Loan Creation Wizard (Calculator & Simulator) <!-- id: 16 -->

- [/] **Phase 6: Transactions & Automation**
    - [/] Backend: Transaction Recording (Repayment) with Slip Upload <!-- id: 17 -->
    - [ ] Feature: Slip Matching (Select Loan/Borrower/Installment) <!-- id: 31 -->
    - [ ] **[NEW] Webhook Service: Handle incoming slip images from Bots (Line)** <!-- id: 33 -->
    - [ ] Report: Traceability (Bank Loan -> Customer Loan -> ROI) <!-- id: 22 -->

- [ ] **Phase 7: Mobile-First UX Polish**
    - [x] Theme: Shadcn UI + Tailwind Optimization <!-- id: 23 -->
    - [ ] Review: Mobile Responsiveness Check <!-- id: 24 -->
