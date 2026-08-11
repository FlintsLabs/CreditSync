import { sql } from "drizzle-orm";
import {
    check,
    date,
    foreignKey,
    index,
    integer,
    jsonb,
    numeric,
    pgEnum,
    pgTable,
    serial,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from "drizzle-orm/pg-core";

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
}, (table) => [
    uniqueIndex("users_tenant_id_id_unique").on(table.tenantId, table.id),
]);

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
    opportunityCostRate: numeric("opportunity_cost_rate").notNull().default("2.00"), // Annual non-cash cost for capital pools
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
}, (table) => [
    uniqueIndex("borrowers_tenant_id_id_unique").on(table.tenantId, table.id),
]);

// Lending Loans (Money lent to Borrowers)
export const loans = pgTable("loans", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    ownerUserId: integer("owner_user_id").references(() => users.id),
    borrowerId: integer("borrower_id").references(() => borrowers.id).notNull(),
    bankLoanId: integer("bank_loan_id").references(() => bankLoans.id), // Traceability to source
    fundingBankProfileId: integer("funding_bank_profile_id").references(() => bankProfiles.id), // Direct own-capital source
    dailyInterestMode: text("daily_interest_mode"), // per_thousand, percent; floating loans only
    dailyInterestRate: numeric("daily_interest_rate"),
    firstDayTreatment: text("first_day_treatment"), // deduct, start_next_day
    interestStartDate: date("interest_start_date"),
    dailyTermUnit: text("daily_term_unit"), // days, months; scheduled daily loans only
    dailyTermValue: integer("daily_term_value"),
    dailyEntryMode: text("daily_entry_mode"), // daily_payment, daily_interest
    dailyInterestInputMode: text("daily_interest_input_mode"), // percent, fixed_amount, per_thousand
    dailyInterestInputValue: numeric("daily_interest_input_value"),
    dailyFlatRatePercent: numeric("daily_flat_rate_percent"),
    principalAmount: numeric("principal_amount").notNull(),
    interestRate: numeric("interest_rate").notNull(), // Calculated rate for borrower
    repaymentType: text("repayment_type").notNull(), // "daily", "monthly", "floating"
    termMonths: integer("term_months"), // Nullable so pre-draft-workflow active loans remain compatible
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
}, (table) => [
    uniqueIndex("loans_tenant_id_id_unique").on(table.tenantId, table.id),
    check("loans_term_months_check", sql`${table.termMonths} IS NULL OR ${table.termMonths} > 0`),
    check("loans_one_funding_source_check", sql`${table.bankLoanId} IS NULL OR ${table.fundingBankProfileId} IS NULL`),
]);

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
}, (table) => [
    uniqueIndex("loan_schedules_tenant_id_id_unique").on(table.tenantId, table.id),
]);

type StoredRatePeriod = {
    publicId: string;
    effectiveDate: string;
    expiryDate: string | null;
    rateType: "percent" | "per_thousand";
    rate: string;
};

type StoredRateChangeRequest = {
    effectiveDate: string;
    expiryDate: string | null;
    rateType: "percent" | "per_thousand";
    rate: string;
};

export const loanInterestRatePeriods = pgTable("loan_interest_rate_periods", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    loanId: integer("loan_id").notNull(),
    effectiveDate: date("effective_date").notNull(),
    expiryDate: date("expiry_date"),
    rateType: text("rate_type").notNull(),
    rate: numeric("rate").notNull(),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("loan_interest_rate_periods_tenant_id_id_unique").on(table.tenantId, table.id),
    index("loan_interest_rate_periods_tenant_loan_effective_idx").on(table.tenantId, table.loanId, table.effectiveDate),
    foreignKey({
        name: "loan_interest_rate_periods_tenant_loan_fk",
        columns: [table.tenantId, table.loanId],
        foreignColumns: [loans.tenantId, loans.id],
    }),
    check("loan_interest_rate_periods_rate_positive_check", sql`${table.rate} > 0`),
    check("loan_interest_rate_periods_rate_scale_check", sql`scale(${table.rate}) <= 4`),
    check("loan_interest_rate_periods_rate_type_check", sql`${table.rateType} IN ('percent', 'per_thousand')`),
    check("loan_interest_rate_periods_date_order_check", sql`${table.expiryDate} IS NULL OR ${table.expiryDate} >= ${table.effectiveDate}`),
]);

export const loanInterestRatePreviews = pgTable("loan_interest_rate_previews", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    loanId: integer("loan_id").notNull(),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    request: jsonb("request").$type<StoredRateChangeRequest>().notNull(),
    requestHash: text("request_hash").notNull(),
    previewHash: text("preview_hash").notNull(),
    beforeTimeline: jsonb("before_timeline").$type<StoredRatePeriod[]>().notNull(),
    afterTimeline: jsonb("after_timeline").$type<StoredRatePeriod[]>().notNull(),
    timelineVersion: text("timeline_version").notNull(),
    status: text("status").default("ready").notNull(),
    executeIdempotencyKey: text("execute_idempotency_key"),
    executedAuditPublicId: uuid("executed_audit_public_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("loan_interest_rate_previews_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("loan_interest_rate_previews_tenant_execute_idempotency_unique")
        .on(table.tenantId, table.executeIdempotencyKey)
        .where(sql`${table.executeIdempotencyKey} IS NOT NULL`),
    index("loan_interest_rate_previews_tenant_loan_created_idx").on(table.tenantId, table.loanId, table.createdAt),
    foreignKey({
        name: "loan_interest_rate_previews_tenant_loan_fk",
        columns: [table.tenantId, table.loanId],
        foreignColumns: [loans.tenantId, loans.id],
    }),
    check("loan_interest_rate_previews_status_check", sql`${table.status} IN ('ready', 'executed', 'expired')`),
]);

export const loanInterestAccruals = pgTable("loan_interest_accruals", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    loanId: integer("loan_id").references(() => loans.id).notNull(),
    interestRatePeriodId: integer("interest_rate_period_id"),
    accrualDate: date("accrual_date").notNull(),
    openingPrincipal: numeric("opening_principal").notNull(),
    rateMode: text("rate_mode").notNull(),
    rate: numeric("rate").notNull(),
    interestAmount: numeric("interest_amount").notNull(),
    paidAmount: numeric("paid_amount").default("0").notNull(),
    status: text("status").default("accrued").notNull(),
    sourceTransactionId: integer("source_transaction_id").references(() => transactions.id),
    reversedAccrualId: integer("reversed_accrual_id"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
    uniqueIndex("loan_interest_accruals_tenant_loan_date_unique").on(table.tenantId, table.loanId, table.accrualDate),
    uniqueIndex("loan_interest_accruals_tenant_id_unique").on(table.tenantId, table.id),
    foreignKey({
        name: "loan_interest_accruals_tenant_rate_period_fk",
        columns: [table.tenantId, table.interestRatePeriodId],
        foreignColumns: [loanInterestRatePeriods.tenantId, loanInterestRatePeriods.id],
    }),
]);

export const loanDisbursements = pgTable("loan_disbursements", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    loanId: integer("loan_id").references(() => loans.id).notNull(),
    grossPrincipal: numeric("gross_principal").notNull(),
    firstDayInterestDeducted: numeric("first_day_interest_deducted").default("0").notNull(),
    netDisbursement: numeric("net_disbursement").notNull(),
    disbursedAt: timestamp("disbursed_at").defaultNow().notNull(),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
    uniqueIndex("loan_disbursements_tenant_loan_unique").on(table.tenantId, table.loanId),
]);

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
    renewalId: integer("renewal_id"),
    allocationGroupId: uuid("allocation_group_id"),
    reversedAllocationId: integer("reversed_allocation_id"),
    note: text("note"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
    uniqueIndex("loan_funding_allocations_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("loan_funding_allocations_tenant_reversed_allocation_unique")
        .on(table.tenantId, table.reversedAllocationId)
        .where(sql`${table.reversedAllocationId} IS NOT NULL`),
    foreignKey({
        name: "loan_funding_allocations_tenant_renewal_fk",
        columns: [table.tenantId, table.renewalId],
        foreignColumns: [loanRenewals.tenantId, loanRenewals.id],
    }),
    foreignKey({
        name: "loan_funding_allocations_tenant_reversed_allocation_fk",
        columns: [table.tenantId, table.reversedAllocationId],
        foreignColumns: [table.tenantId, table.id],
    }),
]);

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
    paymentIntakeId: integer("payment_intake_id"),
    entryType: text("entry_type").default("repayment").notNull(), // repayment, reversal
    reversedTransactionId: integer("reversed_transaction_id"),
    idempotencyKey: text("idempotency_key"),
    postedAt: timestamp("posted_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
    uniqueIndex("transactions_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("transactions_tenant_idempotency_unique")
        .on(table.tenantId, table.idempotencyKey)
        .where(sql`${table.idempotencyKey} IS NOT NULL`),
    uniqueIndex("transactions_tenant_reversed_transaction_unique")
        .on(table.tenantId, table.reversedTransactionId)
        .where(sql`${table.reversedTransactionId} IS NOT NULL`),
    check(
        "transactions_entry_type_reference_check",
        sql`(${table.entryType} = 'repayment' AND ${table.reversedTransactionId} IS NULL) OR (${table.entryType} = 'reversal' AND ${table.reversedTransactionId} IS NOT NULL)`,
    ),
    foreignKey({
        name: "transactions_tenant_payment_intake_fk",
        columns: [table.tenantId, table.paymentIntakeId],
        foreignColumns: [paymentIntakes.tenantId, paymentIntakes.id],
    }),
    foreignKey({
        name: "transactions_tenant_reversed_transaction_fk",
        columns: [table.tenantId, table.reversedTransactionId],
        foreignColumns: [table.tenantId, table.id],
    }),
]);

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

export const loanDisbursementEvents = pgTable("loan_disbursement_events", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    loanId: integer("loan_id").references(() => loans.id).notNull(),
    grossAmount: numeric("gross_amount").notNull(),
    loanAttributedAmount: numeric("loan_attributed_amount").notNull(),
    channel: text("channel").notNull(),
    sourceBankProfileId: integer("source_bank_profile_id").references(() => bankProfiles.id),
    payeeHint: text("payee_hint"),
    status: text("status").default("draft").notNull(),
    reversedEventId: integer("reversed_event_id"),
    note: text("note"),
    disbursedAt: timestamp("disbursed_at"),
    postedAt: timestamp("posted_at"),
    reversedAt: timestamp("reversed_at"),
    postIdempotencyKey: text("post_idempotency_key"),
    reversalIdempotencyKey: text("reversal_idempotency_key"),
    reversalRequestHash: text("reversal_request_hash"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
    index("loan_disbursement_events_tenant_loan_status_idx").on(table.tenantId, table.loanId, table.status),
    uniqueIndex("loan_disbursement_events_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("loan_disbursement_events_tenant_post_idempotency_unique").on(table.tenantId, table.postIdempotencyKey)
        .where(sql`${table.postIdempotencyKey} IS NOT NULL`),
    uniqueIndex("loan_disbursement_events_tenant_reversal_idempotency_unique").on(table.tenantId, table.reversalIdempotencyKey)
        .where(sql`${table.reversalIdempotencyKey} IS NOT NULL`),
    uniqueIndex("loan_disbursement_events_tenant_reversed_event_unique").on(table.tenantId, table.reversedEventId)
        .where(sql`${table.reversedEventId} IS NOT NULL`),
    check("loan_disbursement_events_channel_check", sql`${table.channel} IN ('bank_transfer', 'cash', 'adjustment')`),
    check("loan_disbursement_events_status_check", sql`${table.status} IN ('draft', 'posted', 'reversed')`),
    check("loan_disbursement_events_money_check", sql`${table.grossAmount} >= 0 AND ${table.loanAttributedAmount} >= 0`),
    foreignKey({
        name: "loan_disbursement_events_reversed_event_fk",
        columns: [table.reversedEventId],
        foreignColumns: [table.id],
    }),
]);

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
    actorSource: text("actor_source").default("system").notNull(), // web, mcp, system
    requestId: text("request_id"),
    correlationId: text("correlation_id"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
    check("audit_logs_actor_source_check", sql`${table.actorSource} IN ('web', 'mcp', 'system')`),
]);

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
}, (table) => [
    uniqueIndex("files_tenant_id_id_unique").on(table.tenantId, table.id),
]);

export const loanDisbursementEvidence = pgTable("loan_disbursement_evidence", {
    id: serial("id").primaryKey(),
    tenantId: tenantId,
    loanDisbursementEventId: integer("loan_disbursement_event_id").notNull(),
    fileId: integer("file_id").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
    uniqueIndex("loan_disbursement_evidence_event_file_unique").on(table.loanDisbursementEventId, table.fileId),
    foreignKey({
        name: "loan_disbursement_evidence_tenant_event_fk",
        columns: [table.tenantId, table.loanDisbursementEventId],
        foreignColumns: [loanDisbursementEvents.tenantId, loanDisbursementEvents.id],
    }),
    foreignKey({
        name: "loan_disbursement_evidence_tenant_file_fk",
        columns: [table.tenantId, table.fileId],
        foreignColumns: [files.tenantId, files.id],
    }),
]);

export const loanDisbursementEvidenceIntents = pgTable("loan_disbursement_evidence_intents", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    loanDisbursementEventId: integer("loan_disbursement_event_id").notNull(),
    fileId: integer("file_id").notNull(),
    status: text("status").default("pending").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    mimeType: text("mime_type").notNull(),
    declaredSize: integer("declared_size").notNull(),
    uploadExpiresAt: timestamp("upload_expires_at"),
    finalizedAt: timestamp("finalized_at"),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    updatedByUserId: integer("updated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
    uniqueIndex("loan_disbursement_evidence_intents_tenant_hash_unique").on(table.tenantId, table.evidenceHash),
    check("loan_disbursement_evidence_intents_status_check", sql`${table.status} IN ('pending', 'ready')`),
    foreignKey({
        name: "loan_disbursement_evidence_intents_tenant_event_fk",
        columns: [table.tenantId, table.loanDisbursementEventId],
        foreignColumns: [loanDisbursementEvents.tenantId, loanDisbursementEvents.id],
    }),
    foreignKey({
        name: "loan_disbursement_evidence_intents_tenant_file_fk",
        columns: [table.tenantId, table.fileId],
        foreignColumns: [files.tenantId, files.id],
    }),
]);

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

// Borrower names learned or confirmed by operators and payment-review workflows.
// The same normalized alias may identify more than one borrower; resolution must
// surface that ambiguity rather than selecting a borrower automatically.
export const borrowerAliases = pgTable("borrower_aliases", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    borrowerId: integer("borrower_id").notNull(),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    source: text("source").default("manual").notNull(), // manual, payment, import
    status: text("status").default("pending").notNull(), // pending, confirmed, inactive
    confirmedAt: timestamp("confirmed_at"),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("borrower_aliases_tenant_borrower_normalized_unique")
        .on(table.tenantId, table.borrowerId, table.normalizedAlias),
    check("borrower_aliases_status_check", sql`${table.status} IN ('pending', 'confirmed', 'inactive')`),
    foreignKey({
        name: "borrower_aliases_tenant_borrower_fk",
        columns: [table.tenantId, table.borrowerId],
        foreignColumns: [borrowers.tenantId, borrowers.id],
    }),
    foreignKey({
        name: "borrower_aliases_tenant_created_by_fk",
        columns: [table.tenantId, table.createdByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "borrower_aliases_tenant_updated_by_fk",
        columns: [table.tenantId, table.updatedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
]);

export const paymentIntakes = pgTable("payment_intakes", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    ownerUserId: integer("owner_user_id"),
    source: text("source").default("web").notNull(), // web, mcp, legacy
    status: text("status").default("draft").notNull(), // draft, needs_review, ready, posted, reversed, duplicate
    amount: numeric("amount").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    payerName: text("payer_name"),
    bankReference: text("bank_reference"),
    bankReferenceHash: text("bank_reference_hash"),
    qrPayloadHash: text("qr_payload_hash"),
    idempotencyKey: text("idempotency_key"),
    originLoanId: integer("origin_loan_id"),
    duplicateOfIntakeId: integer("duplicate_of_intake_id"),
    warnings: jsonb("warnings").$type<Array<Record<string, unknown>>>(),
    notes: text("notes"),
    postedAt: timestamp("posted_at"),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    postedByUserId: integer("posted_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("payment_intakes_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("payment_intakes_tenant_idempotency_unique")
        .on(table.tenantId, table.idempotencyKey)
        .where(sql`${table.idempotencyKey} IS NOT NULL`),
    uniqueIndex("payment_intakes_tenant_bank_reference_hash_unique")
        .on(table.tenantId, table.bankReferenceHash)
        .where(sql`${table.bankReferenceHash} IS NOT NULL`),
    uniqueIndex("payment_intakes_tenant_qr_payload_hash_unique")
        .on(table.tenantId, table.qrPayloadHash)
        .where(sql`${table.qrPayloadHash} IS NOT NULL`),
    index("payment_intakes_tenant_origin_loan_received_at_idx")
        .on(table.tenantId, table.originLoanId, table.receivedAt),
    check(
        "payment_intakes_status_check",
        sql`${table.status} IN ('draft', 'needs_review', 'ready', 'posted', 'reversed', 'duplicate')`,
    ),
    foreignKey({
        name: "payment_intakes_tenant_owner_fk",
        columns: [table.tenantId, table.ownerUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "payment_intakes_tenant_origin_loan_fk",
        columns: [table.tenantId, table.originLoanId],
        foreignColumns: [loans.tenantId, loans.id],
    }),
    foreignKey({
        name: "payment_intakes_tenant_duplicate_fk",
        columns: [table.tenantId, table.duplicateOfIntakeId],
        foreignColumns: [table.tenantId, table.id],
    }),
    foreignKey({
        name: "payment_intakes_tenant_created_by_fk",
        columns: [table.tenantId, table.createdByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "payment_intakes_tenant_updated_by_fk",
        columns: [table.tenantId, table.updatedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "payment_intakes_tenant_posted_by_fk",
        columns: [table.tenantId, table.postedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
]);

export const paymentEvidence = pgTable("payment_evidence", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    paymentIntakeId: integer("payment_intake_id").notNull(),
    fileId: integer("file_id"),
    evidenceType: text("evidence_type").default("slip").notNull(), // slip, qr, legacy_slip
    status: text("status").default("pending").notNull(), // pending, ready, rejected
    evidenceHash: text("evidence_hash"),
    mimeType: text("mime_type"),
    declaredSize: integer("declared_size"),
    legacyReference: text("legacy_reference"),
    uploadExpiresAt: timestamp("upload_expires_at"),
    finalizedAt: timestamp("finalized_at"),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("payment_evidence_tenant_evidence_hash_unique")
        .on(table.tenantId, table.evidenceHash)
        .where(sql`${table.evidenceHash} IS NOT NULL`),
    check("payment_evidence_status_check", sql`${table.status} IN ('pending', 'ready', 'rejected')`),
    foreignKey({
        name: "payment_evidence_tenant_intake_fk",
        columns: [table.tenantId, table.paymentIntakeId],
        foreignColumns: [paymentIntakes.tenantId, paymentIntakes.id],
    }),
    foreignKey({
        name: "payment_evidence_tenant_file_fk",
        columns: [table.tenantId, table.fileId],
        foreignColumns: [files.tenantId, files.id],
    }),
    foreignKey({
        name: "payment_evidence_tenant_created_by_fk",
        columns: [table.tenantId, table.createdByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "payment_evidence_tenant_updated_by_fk",
        columns: [table.tenantId, table.updatedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
]);

export const paymentMatchProposals = pgTable("payment_match_proposals", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    paymentIntakeId: integer("payment_intake_id").notNull(),
    version: integer("version").notNull(),
    proposalHash: text("proposal_hash").notNull(),
    status: text("status").default("draft").notNull(), // draft, needs_review, ready, posted, stale
    warnings: jsonb("warnings"),
    expiresAt: timestamp("expires_at"),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("payment_match_proposals_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("payment_match_proposals_tenant_intake_version_unique")
        .on(table.tenantId, table.paymentIntakeId, table.version),
    check(
        "payment_match_proposals_status_check",
        sql`${table.status} IN ('draft', 'needs_review', 'ready', 'posted', 'stale')`,
    ),
    foreignKey({
        name: "payment_match_proposals_tenant_intake_fk",
        columns: [table.tenantId, table.paymentIntakeId],
        foreignColumns: [paymentIntakes.tenantId, paymentIntakes.id],
    }),
    foreignKey({
        name: "payment_match_proposals_tenant_created_by_fk",
        columns: [table.tenantId, table.createdByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "payment_match_proposals_tenant_updated_by_fk",
        columns: [table.tenantId, table.updatedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
]);

export const paymentMatchAllocations = pgTable("payment_match_allocations", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    proposalId: integer("proposal_id").notNull(),
    allocationOrder: integer("allocation_order").notNull(),
    borrowerId: integer("borrower_id").notNull(),
    loanId: integer("loan_id").notNull(),
    scheduleId: integer("schedule_id"),
    amount: numeric("amount").notNull(),
    status: text("status").default("proposed").notNull(), // proposed, posted, reversed
    matchReason: text("match_reason"),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("payment_match_allocations_tenant_proposal_order_unique")
        .on(table.tenantId, table.proposalId, table.allocationOrder),
    check("payment_match_allocations_status_check", sql`${table.status} IN ('proposed', 'posted', 'reversed')`),
    foreignKey({
        name: "payment_match_allocations_tenant_proposal_fk",
        columns: [table.tenantId, table.proposalId],
        foreignColumns: [paymentMatchProposals.tenantId, paymentMatchProposals.id],
    }),
    foreignKey({
        name: "payment_match_allocations_tenant_borrower_fk",
        columns: [table.tenantId, table.borrowerId],
        foreignColumns: [borrowers.tenantId, borrowers.id],
    }),
    foreignKey({
        name: "payment_match_allocations_tenant_loan_fk",
        columns: [table.tenantId, table.loanId],
        foreignColumns: [loans.tenantId, loans.id],
    }),
    foreignKey({
        name: "payment_match_allocations_tenant_schedule_fk",
        columns: [table.tenantId, table.scheduleId],
        foreignColumns: [loanSchedules.tenantId, loanSchedules.id],
    }),
    foreignKey({
        name: "payment_match_allocations_tenant_created_by_fk",
        columns: [table.tenantId, table.createdByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "payment_match_allocations_tenant_updated_by_fk",
        columns: [table.tenantId, table.updatedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
]);

export const loanRenewals = pgTable("loan_renewals", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    oldLoanId: integer("old_loan_id").notNull(),
    newLoanId: integer("new_loan_id"),
    status: text("status").default("preview").notNull(), // preview, executed, reversed, expired
    previewHash: text("preview_hash").notNull(),
    requestedPrincipal: numeric("requested_principal").notNull(),
    outstandingPrincipal: numeric("outstanding_principal").notNull(),
    dueCharges: numeric("due_charges").default("0").notNull(),
    waivedCharges: numeric("waived_charges").default("0").notNull(),
    cashDirection: text("cash_direction"), // payout, collection, none
    cashAmount: numeric("cash_amount").default("0").notNull(),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key"),
    reversalIdempotencyKey: text("reversal_idempotency_key"),
    reversalRequestHash: text("reversal_request_hash"),
    preExecutionLoanState: jsonb("pre_execution_loan_state").$type<{
        status: string;
        outstandingPrincipal: string;
        outstandingInterest: string;
        outstandingFees: string;
        nextDueDate: string | null;
    }>(),
    expiresAt: timestamp("expires_at").notNull(),
    executedAt: timestamp("executed_at"),
    reversedAt: timestamp("reversed_at"),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    executedByUserId: integer("executed_by_user_id"),
    reversedByUserId: integer("reversed_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("loan_renewals_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("loan_renewals_tenant_idempotency_unique")
        .on(table.tenantId, table.idempotencyKey)
        .where(sql`${table.idempotencyKey} IS NOT NULL`),
    uniqueIndex("loan_renewals_tenant_reversal_idempotency_unique")
        .on(table.tenantId, table.reversalIdempotencyKey)
        .where(sql`${table.reversalIdempotencyKey} IS NOT NULL`),
    check("loan_renewals_status_check", sql`${table.status} IN ('preview', 'executed', 'reversed', 'expired')`),
    check("loan_renewals_cash_direction_check", sql`${table.cashDirection} IS NULL OR ${table.cashDirection} IN ('payout', 'collection', 'none')`),
    foreignKey({
        name: "loan_renewals_tenant_old_loan_fk",
        columns: [table.tenantId, table.oldLoanId],
        foreignColumns: [loans.tenantId, loans.id],
    }),
    foreignKey({
        name: "loan_renewals_tenant_new_loan_fk",
        columns: [table.tenantId, table.newLoanId],
        foreignColumns: [loans.tenantId, loans.id],
    }),
    foreignKey({
        name: "loan_renewals_tenant_created_by_fk",
        columns: [table.tenantId, table.createdByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "loan_renewals_tenant_updated_by_fk",
        columns: [table.tenantId, table.updatedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "loan_renewals_tenant_executed_by_fk",
        columns: [table.tenantId, table.executedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "loan_renewals_tenant_reversed_by_fk",
        columns: [table.tenantId, table.reversedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
]);

export const loanAdjustments = pgTable("loan_adjustments", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId: tenantId,
    loanId: integer("loan_id").notNull(),
    renewalId: integer("renewal_id"),
    adjustmentType: text("adjustment_type").notNull(), // principal_transfer, cash_payout, charge_settlement, charge_waiver, reversal
    amount: numeric("amount").notNull(),
    status: text("status").default("posted").notNull(), // posted, reversed
    idempotencyKey: text("idempotency_key"),
    reversedAdjustmentId: integer("reversed_adjustment_id"),
    reason: text("reason"),
    effectiveAt: timestamp("effective_at").defaultNow().notNull(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("loan_adjustments_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("loan_adjustments_tenant_idempotency_unique")
        .on(table.tenantId, table.idempotencyKey)
        .where(sql`${table.idempotencyKey} IS NOT NULL`),
    uniqueIndex("loan_adjustments_tenant_reversed_adjustment_unique")
        .on(table.tenantId, table.reversedAdjustmentId)
        .where(sql`${table.reversedAdjustmentId} IS NOT NULL`),
    check("loan_adjustments_status_check", sql`${table.status} IN ('posted', 'reversed')`),
    foreignKey({
        name: "loan_adjustments_tenant_loan_fk",
        columns: [table.tenantId, table.loanId],
        foreignColumns: [loans.tenantId, loans.id],
    }),
    foreignKey({
        name: "loan_adjustments_tenant_renewal_fk",
        columns: [table.tenantId, table.renewalId],
        foreignColumns: [loanRenewals.tenantId, loanRenewals.id],
    }),
    foreignKey({
        name: "loan_adjustments_tenant_reversed_adjustment_fk",
        columns: [table.tenantId, table.reversedAdjustmentId],
        foreignColumns: [table.tenantId, table.id],
    }),
    foreignKey({
        name: "loan_adjustments_tenant_created_by_fk",
        columns: [table.tenantId, table.createdByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
        name: "loan_adjustments_tenant_updated_by_fk",
        columns: [table.tenantId, table.updatedByUserId],
        foreignColumns: [users.tenantId, users.id],
    }),
]);

// Two-leg borrower collections routed through an intermediary. Capturing a
// collection is non-financial; loan effects are created only by settlement or
// an explicitly audited manual approval.
export const intermediaries = pgTable("intermediaries", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId,
    ownerUserId: integer("owner_user_id"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    aliases: jsonb("aliases").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    status: text("status").default("active").notNull(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("intermediaries_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("intermediaries_tenant_normalized_name_unique").on(table.tenantId, table.normalizedName),
    check("intermediaries_status_check", sql`${table.status} IN ('active', 'inactive')`),
    foreignKey({ name: "intermediaries_tenant_owner_fk", columns: [table.tenantId, table.ownerUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ name: "intermediaries_tenant_created_by_fk", columns: [table.tenantId, table.createdByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ name: "intermediaries_tenant_updated_by_fk", columns: [table.tenantId, table.updatedByUserId], foreignColumns: [users.tenantId, users.id] }),
]);

export const intermediaryCollections = pgTable("intermediary_collections", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId,
    ownerUserId: integer("owner_user_id"),
    intermediaryId: integer("intermediary_id").notNull(),
    borrowerId: integer("borrower_id").notNull(),
    loanId: integer("loan_id").notNull(),
    amount: numeric("amount").notNull(),
    borrowerPaidAt: timestamp("borrower_paid_at").notNull(),
    status: text("status").default("pending_remittance").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    bankReference: text("bank_reference"),
    bankReferenceHash: text("bank_reference_hash"),
    note: text("note"),
    manualApprovalReason: text("manual_approval_reason"),
    postedPaymentIntakeId: integer("posted_payment_intake_id"),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    approvedByUserId: integer("approved_by_user_id"),
    settledAt: timestamp("settled_at"),
    reversedAt: timestamp("reversed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("intermediary_collections_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("intermediary_collections_tenant_idempotency_unique").on(table.tenantId, table.idempotencyKey),
    uniqueIndex("intermediary_collections_tenant_bank_reference_unique").on(table.tenantId, table.bankReferenceHash).where(sql`${table.bankReferenceHash} IS NOT NULL`),
    index("intermediary_collections_tenant_intermediary_status_idx").on(table.tenantId, table.intermediaryId, table.status),
    check("intermediary_collections_status_check", sql`${table.status} IN ('pending_remittance', 'allocated', 'settled', 'manual_approved', 'reversed')`),
    check("intermediary_collections_amount_check", sql`${table.amount} > 0`),
    foreignKey({ name: "intermediary_collections_tenant_owner_fk", columns: [table.tenantId, table.ownerUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ name: "intermediary_collections_tenant_intermediary_fk", columns: [table.tenantId, table.intermediaryId], foreignColumns: [intermediaries.tenantId, intermediaries.id] }),
    foreignKey({ name: "intermediary_collections_tenant_borrower_fk", columns: [table.tenantId, table.borrowerId], foreignColumns: [borrowers.tenantId, borrowers.id] }),
    foreignKey({ name: "intermediary_collections_tenant_loan_fk", columns: [table.tenantId, table.loanId], foreignColumns: [loans.tenantId, loans.id] }),
    foreignKey({ name: "intermediary_collections_tenant_payment_intake_fk", columns: [table.tenantId, table.postedPaymentIntakeId], foreignColumns: [paymentIntakes.tenantId, paymentIntakes.id] }),
    foreignKey({ name: "intermediary_collections_tenant_created_by_fk", columns: [table.tenantId, table.createdByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ name: "intermediary_collections_tenant_updated_by_fk", columns: [table.tenantId, table.updatedByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ name: "intermediary_collections_tenant_approved_by_fk", columns: [table.tenantId, table.approvedByUserId], foreignColumns: [users.tenantId, users.id] }),
]);

export const intermediaryRemittances = pgTable("intermediary_remittances", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId,
    ownerUserId: integer("owner_user_id"),
    intermediaryId: integer("intermediary_id").notNull(),
    grossAmount: numeric("gross_amount").notNull(),
    receivedAt: timestamp("received_at").notNull(),
    bankReference: text("bank_reference"),
    bankReferenceHash: text("bank_reference_hash"),
    destinationHint: text("destination_hint"),
    note: text("note"),
    status: text("status").default("draft").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    postIdempotencyKey: text("post_idempotency_key"),
    reversalIdempotencyKey: text("reversal_idempotency_key"),
    reversalReason: text("reversal_reason"),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    postedByUserId: integer("posted_by_user_id"),
    reversedByUserId: integer("reversed_by_user_id"),
    postedAt: timestamp("posted_at"),
    reversedAt: timestamp("reversed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("intermediary_remittances_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("intermediary_remittances_tenant_idempotency_unique").on(table.tenantId, table.idempotencyKey),
    uniqueIndex("intermediary_remittances_tenant_bank_reference_unique").on(table.tenantId, table.bankReferenceHash).where(sql`${table.bankReferenceHash} IS NOT NULL`),
    uniqueIndex("intermediary_remittances_tenant_post_key_unique").on(table.tenantId, table.postIdempotencyKey).where(sql`${table.postIdempotencyKey} IS NOT NULL`),
    uniqueIndex("intermediary_remittances_tenant_reversal_key_unique").on(table.tenantId, table.reversalIdempotencyKey).where(sql`${table.reversalIdempotencyKey} IS NOT NULL`),
    index("intermediary_remittances_tenant_intermediary_status_idx").on(table.tenantId, table.intermediaryId, table.status),
    check("intermediary_remittances_status_check", sql`${table.status} IN ('draft', 'needs_review', 'ready', 'posted', 'reversed')`),
    check("intermediary_remittances_amount_check", sql`${table.grossAmount} > 0`),
    foreignKey({ name: "intermediary_remittances_tenant_owner_fk", columns: [table.tenantId, table.ownerUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ name: "intermediary_remittances_tenant_intermediary_fk", columns: [table.tenantId, table.intermediaryId], foreignColumns: [intermediaries.tenantId, intermediaries.id] }),
    foreignKey({ name: "intermediary_remittances_tenant_created_by_fk", columns: [table.tenantId, table.createdByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ name: "intermediary_remittances_tenant_updated_by_fk", columns: [table.tenantId, table.updatedByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ name: "intermediary_remittances_tenant_posted_by_fk", columns: [table.tenantId, table.postedByUserId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({ name: "intermediary_remittances_tenant_reversed_by_fk", columns: [table.tenantId, table.reversedByUserId], foreignColumns: [users.tenantId, users.id] }),
]);

export const intermediaryRemittanceAllocations = pgTable("intermediary_remittance_allocations", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId,
    remittanceId: integer("remittance_id").notNull(),
    collectionId: integer("collection_id").notNull(),
    allocationOrder: integer("allocation_order").notNull(),
    releasedAt: timestamp("released_at"),
    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("intermediary_remittance_allocations_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("intermediary_allocations_active_collection_unique").on(table.tenantId, table.collectionId).where(sql`${table.releasedAt} IS NULL`),
    uniqueIndex("intermediary_allocations_remittance_collection_unique").on(table.tenantId, table.remittanceId, table.collectionId),
    foreignKey({ name: "intermediary_allocations_tenant_remittance_fk", columns: [table.tenantId, table.remittanceId], foreignColumns: [intermediaryRemittances.tenantId, intermediaryRemittances.id] }),
    foreignKey({ name: "intermediary_allocations_tenant_collection_fk", columns: [table.tenantId, table.collectionId], foreignColumns: [intermediaryCollections.tenantId, intermediaryCollections.id] }),
    foreignKey({ name: "intermediary_allocations_tenant_created_by_fk", columns: [table.tenantId, table.createdByUserId], foreignColumns: [users.tenantId, users.id] }),
]);

export const intermediaryRemittanceProposals = pgTable("intermediary_remittance_proposals", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId,
    remittanceId: integer("remittance_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    selectedTotal: numeric("selected_total").notNull(),
    remainingBalance: numeric("remaining_balance").notNull(),
    stateHash: text("state_hash").notNull(),
    warnings: jsonb("warnings").$type<Array<Record<string, unknown>>>().default([]).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("intermediary_remittance_proposals_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("intermediary_remittance_proposals_version_unique").on(table.tenantId, table.remittanceId, table.version),
    check("intermediary_remittance_proposals_status_check", sql`${table.status} IN ('needs_review', 'ready', 'stale', 'expired')`),
    foreignKey({ name: "intermediary_proposals_tenant_remittance_fk", columns: [table.tenantId, table.remittanceId], foreignColumns: [intermediaryRemittances.tenantId, intermediaryRemittances.id] }),
    foreignKey({ name: "intermediary_proposals_tenant_created_by_fk", columns: [table.tenantId, table.createdByUserId], foreignColumns: [users.tenantId, users.id] }),
]);
