# CreditSync Task List

- [x] **Phase 1: Foundation & Infrastructure**
    - [x] Analyze existing repository structure <!-- id: 0 -->
    - [x] Define Tech Stack (Bun, Elysia, React, Vite, Tailwind, PostgreSQL) <!-- id: 1 -->
    - [x] **[NEW] Configure Cloudflare Tunnel (Ingress & Secret Management)** <!-- id: 32 -->
    - [x] Configure MinIO (S3 Compatible) for Local Storage <!-- id: 25 -->
    - [x] Update Schema: Add `tenant_id` to all tables for Multi-tenancy <!-- id: 26 -->
    - [x] Setup Google OAuth (Sign in with Google) <!-- id: 3 -->
    - [ ] Configure Kubernetes Manifests for local deployment (inc. MinIO) <!-- id: 4 -->

- [x] **Phase 2: Authentication & RBAC**
    - [x] Implement Roles: Owner, Manager, Collector, Viewer <!-- id: 27 -->
    - [x] Middleware: Auth & Tenant Context Injection <!-- id: 28 -->
    - [x] Frontend: Login Page with Google Button <!-- id: 29 -->

- [ ] **Phase 3: Fund Management & Dashboard**
    - [x] Backend: Bank Profile & Bank Loan CRUD (Tenant-scoped) <!-- id: 5 -->
    - [x] Frontend: Dashboard for Bank Loans (Interest/ROI/Balance) <!-- id: 7 -->
    - [x] **[NEW] Fund Performance Dashboard (Combo Chart: Inflow/Outflow/Liability)** <!-- id: 34 -->

- [/] **Phase 4: Borrower Profile & OCR**
    - [x] Backend: Borrower CRUD with S3 Image Upload <!-- id: 8 -->
    - [x] Service: OCR Service (Tesseract or Vision API placeholder) <!-- id: 9 -->
    - [x] Frontend: Borrower Registration Form (Upload ID -> OCR) <!-- id: 10 -->

- [x] **Phase 5: Loan Engine & Calculation**
    - [x] Logic: Interest Calculator (Daily, Weekly, Monthly, Floating) <!-- id: 12 -->
    - [x] Feature: Loan Closing Calculator (Pro-rated + Copy to Clipboard) <!-- id: 30 -->
    - [x] Frontend: Loan Creation Wizard (Calculator & Simulator) <!-- id: 16 -->

- [/] **Phase 6: Transactions & Automation**
    - [/] Backend: Transaction Recording (Repayment) with Slip Upload <!-- id: 17 -->
    - [ ] Feature: Slip Matching (Select Loan/Borrower/Installment) <!-- id: 31 -->
    - [ ] **[NEW] Webhook Service: Handle incoming slip images from Bots (Line)** <!-- id: 33 -->
    - [ ] Report: Traceability (Bank Loan -> Customer Loan -> ROI) <!-- id: 22 -->

- [x] **Phase 7: Mobile-First UX Polish**
    - [x] Theme: Shadcn UI + Tailwind Optimization <!-- id: 23 -->
    - [x] Review: Mobile Responsiveness Check <!-- id: 24 -->

- [ ] **Phase 8: Operational Efficiency & Security [NEW]**
    - [ ] Feature: Audit Logs & Activity History (Loan/Borrower updates) <!-- id: 35 -->
    - [ ] Feature: Notification System (Due Date Reminders, Payment Receipts via Line/Email) <!-- id: 36 -->
    - [ ] Feature: Document Generation (PDF Contracts, Excel Export) <!-- id: 37 -->
    - [ ] Feature: Smart Slip Verification Queue (Side-by-side view) <!-- id: 38 -->

- [ ] **Phase 9: Advanced Analytics & AI [NEW]**
    - [ ] Dashboard: Cashflow Forecasting (Expected vs Upcoming Payments) <!-- id: 39 -->
    - [ ] Feature: AI Credit Scoring (Reliability Score from payment history) <!-- id: 40 -->
    - [ ] Feature: Geolocation Tracking for Field Collectors <!-- id: 41 -->
