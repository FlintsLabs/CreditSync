import { pgTable, text, serial, timestamp, numeric, boolean, integer, date } from "drizzle-orm/pg-core";

// Users (Admins/Lenders)
export const users = pgTable("users", {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name"),
    picture: text("picture"),
    role: text("role").default("admin"),
    createdAt: timestamp("created_at").defaultNow(),
});

// Bank Profiles (Source of Funds)
export const bankProfiles = pgTable("bank_profiles", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(), // e.g., "SCB Personal Loan", "KBank Credit Card"
    type: text("type").notNull(), // "bank", "personal_savings"
    creditLimit: numeric("credit_limit"),
    createdAt: timestamp("created_at").defaultNow(),
});

// Bank Loans (Money borrowed from Bank)
export const bankLoans = pgTable("bank_loans", {
    id: serial("id").primaryKey(),
    bankProfileId: integer("bank_profile_id").references(() => bankProfiles.id),
    amount: numeric("amount").notNull(), // e.g. 200000
    interestRate: numeric("interest_rate"), // e.g. 20 (% per year)
    startDate: date("start_date"),
    termMonths: integer("term_months"),
    status: text("status").default("active"), // active, closed
    createdAt: timestamp("created_at").defaultNow(),
});

// Borrowers (End Customers)
export const borrowers = pgTable("borrowers", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    idCardNumber: text("id_card_number"),
    address: text("address"),
    phone: text("phone"),
    photoUrl: text("photo_url"), // Profile picture
    idCardImageUrl: text("id_card_image_url"), // OCR Image source
    creditScore: integer("credit_score").default(100),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow(),
});

// Lending Loans (Money lent to Borrowers)
export const loans = pgTable("loans", {
    id: serial("id").primaryKey(),
    borrowerId: integer("borrower_id").references(() => borrowers.id).notNull(),
    bankLoanId: integer("bank_loan_id").references(() => bankLoans.id), // Traceability to source
    principalAmount: numeric("principal_amount").notNull(),
    interestRate: numeric("interest_rate").notNull(), // Calculated rate for borrower
    repaymentType: text("repayment_type").notNull(), // "daily", "monthly", "floating"
    installmentAmount: numeric("installment_amount"), // e.g. 400 per day
    totalInstallments: integer("total_installments"),
    startDate: date("start_date").defaultNow(),
    status: text("status").default("draft"), // draft, active, paid, defaulted
    createdAt: timestamp("created_at").defaultNow(),
});

// Transactions (Repayments from Borrowers)
export const transactions = pgTable("transactions", {
    id: serial("id").primaryKey(),
    loanId: integer("loan_id").references(() => loans.id).notNull(),
    amount: numeric("amount").notNull(),
    type: text("type").default("repayment"), // repayment, close_account
    slipUrl: text("slip_url"), // Uploaded slip image
    transactionDate: timestamp("transaction_date").defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow(),
});

// Bank Transactions (Repayments to Bank)
export const bankTransactions = pgTable("bank_transactions", {
    id: serial("id").primaryKey(),
    bankLoanId: integer("bank_loan_id").references(() => bankLoans.id).notNull(),
    amount: numeric("amount").notNull(),
    type: text("type").default("repayment"),
    transactionDate: timestamp("transaction_date").defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow(),
});
