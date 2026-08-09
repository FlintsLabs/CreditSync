import { sql } from "drizzle-orm";
import { pgTable, text, serial, timestamp, numeric, integer, date, pgEnum, jsonb, uuid } from "drizzle-orm/pg-core";

// Enums
export const roleEnum = pgEnum("role", ["owner", "manager", "collector", "viewer"]);

// Common Columns helper
const tenantId = text("tenant_id").notNull(); // All tables must have this

// Users (Admins/Lenders)
export const users = pgTable("users", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    email: text("email").notNull().unique(),
    name: text("name"),
    picture: text("picture"),
    role: roleEnum("role").default("viewer"),
    createdAt: timestamp("created_at").defaultNow(),
});

// Tenant Configuration (Secrets, Tokens)
export const tenantConfigs = pgTable("tenant_configs", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: text("tenant_id").notNull().unique(),
    lineChannelToken: text("line_channel_token"),
    webhookSecret: text("webhook_secret"), // For verifying incoming webhook signatures
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

// Bank Profiles (Source of Funds)
export const bankProfiles = pgTable("bank_profiles", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    name: text("name").notNull(), // e.g., "SCB Personal Loan", "KBank Credit Card"
    type: text("type").notNull(), // "bank", "personal_savings"
    providerName: text("provider_name"),
    referenceNo: text("reference_no"),
    status: text("status").default("active"),
    note: text("note"),
    creditLimit: numeric("credit_limit"),
    accountingMode: text("accounting_mode").default("external_liability").notNull(), // external_liability, capital_pool
    reinvestProfitMode: text("reinvest_profit_mode").default("manual_distribution").notNull(), // manual_distribution, retain_in_pool
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

// Bank Loans (Money borrowed from Bank)
export const bankLoans = pgTable("bank_loans", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    bankProfileId: integer("bank_profile_id").references(() => bankProfiles.id),
    amount: numeric("amount").notNull(), // e.g. 200000
    interestRate: numeric("interest_rate"), // e.g. 20 (% per year)
    startDate: date("start_date"),
    termMonths: integer("term_months"),
    repaymentCycle: text("repayment_cycle").default("monthly"), // daily, weekly, monthly, custom
    repaymentMode: text("repayment_mode").default("fixed_installment"), // fixed_installment, minimum_due, interest_only, custom
    installmentAmount: numeric("installment_amount"),
    totalInstallments: integer("total_installments"),
    processingFeeAmount: numeric("processing_fee_amount").default("0"),
    utilizationFeeAmount: numeric("utilization_fee_amount").default("0"),
    vatRate: numeric("vat_rate").default("0"),
    lateFeeMode: text("late_fee_mode").default("none"),
    lateFeeAmount: numeric("late_fee_amount").default("0"),
    gracePeriodDays: integer("grace_period_days").default(0),
    nextDueDate: date("next_due_date"),
    outstandingPrincipal: numeric("outstanding_principal").default("0"),
    outstandingInterest: numeric("outstanding_interest").default("0"),
    outstandingFees: numeric("outstanding_fees").default("0"),
    outstandingPenalties: numeric("outstanding_penalties").default("0"),
    status: text("status").default("active"), // active, closed
    closedAt: timestamp("closed_at"),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

export const bankLoanSchedules = pgTable("bank_loan_schedules", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    bankLoanId: integer("bank_loan_id").references(() => bankLoans.id).notNull(),
    installmentNo: integer("installment_no").notNull(),
    dueDate: date("due_date").notNull(),
    scheduledPrincipal: numeric("scheduled_principal").default("0").notNull(),
    scheduledInterest: numeric("scheduled_interest").default("0").notNull(),
    scheduledFee: numeric("scheduled_fee").default("0").notNull(),
    scheduledVat: numeric("scheduled_vat").default("0").notNull(),
    scheduledTotal: numeric("scheduled_total").default("0").notNull(),
    paidTotal: numeric("paid_total").default("0").notNull(),
    paidPenalty: numeric("paid_penalty").default("0").notNull(),
    overdueDays: integer("overdue_days").default(0).notNull(),
    remainingDue: numeric("remaining_due").default("0").notNull(),
    status: text("status").default("pending").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

export const bankLoanRepayments = pgTable("bank_loan_repayments", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    bankLoanId: integer("bank_loan_id").references(() => bankLoans.id).notNull(),
    scheduleId: integer("schedule_id").references(() => bankLoanSchedules.id),
    paymentDate: timestamp("payment_date").defaultNow().notNull(),
    amount: numeric("amount").notNull(),
    principalComponent: numeric("principal_component").default("0").notNull(),
    interestComponent: numeric("interest_component").default("0").notNull(),
    feeComponent: numeric("fee_component").default("0").notNull(),
    vatComponent: numeric("vat_component").default("0").notNull(),
    penaltyComponent: numeric("penalty_component").default("0").notNull(),
    paymentMethod: text("payment_method"),
    reference: text("reference"),
    note: text("note"),
    recordedByUserId: integer("recorded_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
});

// Borrowers (End Customers)
export const borrowers = pgTable("borrowers", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    ownerUserId: integer("owner_user_id").references(() => users.id),
    name: text("name").notNull(),
    idCardNumber: text("id_card_number"),
    address: text("address"),
    phone: text("phone"),
    photoUrl: text("photo_url"), // Profile picture URL (MinIO)
    idCardImageUrl: text("id_card_image_url"), // OCR Image source
    creditScore: integer("credit_score").default(100),
    tags: text("tags").array(), // Array of tags
    googleMapsUrl: text("google_maps_url"), // URL for Google Maps location
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

// Lending Loans (Money lent to Borrowers)
export const loans = pgTable("loans", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    ownerUserId: integer("owner_user_id").references(() => users.id),
    borrowerId: integer("borrower_id").references(() => borrowers.id).notNull(),
    bankLoanId: integer("bank_loan_id").references(() => bankLoans.id), // Traceability to source
    principalAmount: numeric("principal_amount").notNull(),
    interestRate: numeric("interest_rate").notNull(), // Calculated rate for borrower
    repaymentType: text("repayment_type").notNull(), // "daily", "monthly", "floating"
    installmentAmount: numeric("installment_amount"), // e.g. 400 per day
    totalInstallments: integer("total_installments"),
    gracePeriodDays: integer("grace_period_days").default(0),
    lateFeeMode: text("late_fee_mode").default("none"),
    lateFeeAmount: numeric("late_fee_amount").default("0"),
    startDate: date("start_date").defaultNow(),
    nextDueDate: date("next_due_date"),
    outstandingPrincipal: numeric("outstanding_principal").default("0"),
    outstandingInterest: numeric("outstanding_interest").default("0"),
    outstandingFees: numeric("outstanding_fees").default("0"),
    status: text("status").default("draft"), // draft, active, paid, defaulted
    clonedFromLoanId: integer("cloned_from_loan_id"), // traceability for Refinance/Top-up
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

export const loanSchedules = pgTable("loan_schedules", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    loanId: integer("loan_id").references(() => loans.id).notNull(),
    installmentNo: integer("installment_no").notNull(),
    dueDate: date("due_date").notNull(),
    scheduledPrincipal: numeric("scheduled_principal").default("0").notNull(),
    scheduledInterest: numeric("scheduled_interest").default("0").notNull(),
    scheduledFee: numeric("scheduled_fee").default("0").notNull(),
    scheduledTotal: numeric("scheduled_total").default("0").notNull(),
    paidTotal: numeric("paid_total").default("0").notNull(),
    paidPenalty: numeric("paid_penalty").default("0").notNull(),
    overdueDays: integer("overdue_days").default(0).notNull(),
    remainingDue: numeric("remaining_due").default("0").notNull(),
    status: text("status").default("pending").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

export const loanFundingAllocations = pgTable("loan_funding_allocations", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    bankProfileId: integer("bank_profile_id").references(() => bankProfiles.id),
    bankLoanId: integer("bank_loan_id").references(() => bankLoans.id),
    loanId: integer("loan_id").references(() => loans.id).notNull(),
    allocatedAmount: numeric("allocated_amount").notNull(),
    allocationDate: date("allocation_date").notNull(),
    allocationType: text("allocation_type").default("initial").notNull(), // initial, manual_adjustment, reallocation_in, reallocation_out
    note: text("note"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
});

// Transactions (Repayments from Borrowers)
export const transactions = pgTable("transactions", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    ownerUserId: integer("owner_user_id").references(() => users.id),
    loanId: integer("loan_id").references(() => loans.id).notNull(),
    scheduleId: integer("schedule_id").references(() => loanSchedules.id),
    amount: numeric("amount").notNull(),
    principalComponent: numeric("principal_component").default("0").notNull(),
    interestComponent: numeric("interest_component").default("0").notNull(),
    feeComponent: numeric("fee_component").default("0").notNull(),
    penaltyComponent: numeric("penalty_component").default("0").notNull(),
    type: text("type").default("repayment"), // repayment, close_account
    slipUrl: text("slip_url"), // Uploaded slip image
    transactionDate: timestamp("transaction_date").defaultNow(),
    notes: text("notes"),
    recordedByUserId: integer("recorded_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

export const fundRolloverEntries = pgTable("fund_rollover_entries", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    fromBankProfileId: integer("from_bank_profile_id").references(() => bankProfiles.id),
    fromBankLoanId: integer("from_bank_loan_id").references(() => bankLoans.id),
    toBankProfileId: integer("to_bank_profile_id").references(() => bankProfiles.id),
    toBankLoanId: integer("to_bank_loan_id").references(() => bankLoans.id),
    entryType: text("entry_type").notNull(), // surplus_transfer, deficit_support, refinance_in, refinance_out, capitalization, manual_adjustment
    amount: numeric("amount").notNull(),
    effectiveDate: date("effective_date").notNull(),
    note: text("note"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
});

export const fundLedgerEntries = pgTable("fund_ledger_entries", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    bankProfileId: integer("bank_profile_id").references(() => bankProfiles.id).notNull(),
    bankLoanId: integer("bank_loan_id").references(() => bankLoans.id),
    loanId: integer("loan_id").references(() => loans.id),
    transactionId: integer("transaction_id").references(() => transactions.id),
    bankRepaymentId: integer("bank_repayment_id").references(() => bankLoanRepayments.id),
    rolloverEntryId: integer("rollover_entry_id").references(() => fundRolloverEntries.id),
    entryDate: timestamp("entry_date").defaultNow().notNull(),
    entryType: text("entry_type").notNull(), // loan_allocation_out, principal_return_in, interest_income_in, fee_income_in, bank_repayment_out, rollover_in, rollover_out
    amount: numeric("amount").notNull(),
    note: text("note"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actorUserId: integer("actor_user_id").references(() => users.id),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at").defaultNow(),
});

// Files (MinIO Objects)
export const files = pgTable("files", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    ownerUserId: integer("owner_user_id").references(() => users.id),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(), // S3 Key
    originalName: text("original_name"),
    mimeType: text("mime_type"),
    size: integer("size"),
    url: text("url"), // Stored file reference, resolved to a signed URL at read time
    createdAt: timestamp("created_at").defaultNow(),
});

// Bot Uploads (Unprocessed images from Webhooks)
export const botUploads = pgTable("bot_uploads", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    fileId: integer("file_id").references(() => files.id),
    source: text("source").default("line"), // line, telegram
    senderId: text("sender_id"), // User ID from the bot platform
    status: text("status").default("pending"), // pending, matched, discarded
    createdAt: timestamp("created_at").defaultNow(),
});

// Bank Transactions (Repayments to Bank)
export const bankTransactions = pgTable("bank_transactions", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    bankLoanId: integer("bank_loan_id").references(() => bankLoans.id).notNull(),
    amount: numeric("amount").notNull(),
    type: text("type").default("repayment"),
    transactionDate: timestamp("transaction_date").defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow(),
});

export const reconciliationEntries = pgTable("reconciliation_entries", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    entityType: text("entity_type").notNull(), // borrower_transaction, bank_loan_repayment, bot_upload
    entityId: integer("entity_id").notNull(),
    uploadId: integer("upload_id").references(() => botUploads.id),
    status: text("status").default("matched").notNull(), // matched, manual, ignored
    note: text("note"),
    matchedByUserId: integer("matched_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});
