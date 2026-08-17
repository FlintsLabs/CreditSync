import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    bankLoans,
    bankProfiles,
    borrowers,
    loanDisbursementEvents,
    loanFundingAllocations,
    loanReplacementCorrections,
    loanReplacements,
    loanSchedules,
    loans,
    transactions,
    users,
} from "../db/schema";
import type { CommandContext } from "./command-context";
import { createLoanDraft, type LoanDraftInput } from "./loan-application-service";
import {
    executeLoanReplacement,
    previewLoanReplacement,
    reverseLoanReplacement,
    type LoanReplacementExecution,
    type LoanReplacementPreview,
    type LoanReplacementReversal,
} from "./loan-replacement-service";

type UserRow = typeof users.$inferSelect;
type BorrowerRow = typeof borrowers.$inferSelect;
type LoanRow = typeof loans.$inferSelect;
type BankProfileRow = typeof bankProfiles.$inferSelect;
type BankLoanRow = typeof bankLoans.$inferSelect;

export interface SeedReplacementFixtureOptions {
    tenantId?: string;
    funding?: "drawdown" | "own_capital";
    sourceCapacity?: string;
    oldLoan?: Partial<typeof loans.$inferInsert>;
    replacementDraft?: Partial<LoanDraftInput>;
    partialDraftAllocation?: string;
}

export interface ReplacementFixtureCounts {
    replacementRows: number;
    oldSchedules: number;
    replacementSchedules: number;
    oldAllocations: number;
    replacementAllocations: number;
    corrections: number;
    executionAudits: number;
    reversalAudits: number;
    payments: number;
    disbursements: number;
}

export interface ReplacementFixture {
    tenantId: string;
    actor: UserRow;
    borrower: BorrowerRow;
    oldLoan: LoanRow;
    replacementDraft: LoanRow;
    source: { profile: BankProfileRow; drawdown: BankLoanRow | null };
    context(idempotencyKey?: string): CommandContext;
    preview(reason?: string): Promise<LoanReplacementPreview>;
    execute(
        preview: LoanReplacementPreview,
        idempotencyKey?: string,
        reason?: string,
    ): Promise<LoanReplacementExecution>;
    reverse(
        replacementPublicId: string,
        idempotencyKey?: string,
        reason?: string,
    ): Promise<LoanReplacementReversal>;
    counts(): Promise<ReplacementFixtureCounts>;
}

let fixtureSequence = 0;

export async function resetReplacementDatabase(): Promise<void> {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE users, bank_profiles RESTART IDENTITY CASCADE`);
}

export function replacementContext(
    tenantId: string,
    actorUserId: number,
    idempotencyKey = "replacement-preview",
): CommandContext {
    return {
        tenantId,
        actorUserId,
        actorSource: "web",
        requestId: `req-${idempotencyKey}`,
        correlationId: `corr-${idempotencyKey}`,
        idempotencyKey,
    };
}

export async function seedReplacementFixture(
    options: SeedReplacementFixtureOptions = {},
): Promise<ReplacementFixture> {
    fixtureSequence += 1;
    const tenantId = options.tenantId ?? `replacement-${fixtureSequence}`;
    const actor = await db.insert(users).values({
        tenantId,
        email: `manager-${fixtureSequence}@example.test`,
        role: "manager",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId,
        ownerUserId: actor.id,
        name: `Replacement Borrower ${fixtureSequence}`,
    }).returning().then((rows) => rows[0]!);
    const funding = options.funding ?? "drawdown";
    const profile = await db.insert(bankProfiles).values({
        tenantId,
        name: funding === "drawdown" ? "TTB" : "Own Capital",
        type: "bank",
        status: "active",
        accountingMode: funding === "drawdown" ? "external_liability" : "capital_pool",
        creditLimit: funding === "own_capital" ? (options.sourceCapacity ?? "72000.00") : null,
    }).returning().then((rows) => rows[0]!);
    const drawdown = funding === "drawdown"
        ? await db.insert(bankLoans).values({
            tenantId,
            bankProfileId: profile.id,
            amount: options.sourceCapacity ?? "72000.00",
            interestRate: "0.00",
            termMonths: 12,
            status: "active",
            startDate: "2026-07-01",
        }).returning().then((rows) => rows[0]!)
        : null;
    const oldLoan = await db.insert(loans).values({
        tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        bankLoanId: drawdown?.id ?? null,
        fundingBankProfileId: drawdown ? null : profile.id,
        principalAmount: "36000.00",
        interestRate: "0.00",
        repaymentType: "daily",
        termMonths: 7,
        totalInstallments: 200,
        installmentAmount: "201.00",
        startDate: "2026-07-12",
        status: "active",
        outstandingPrincipal: "36000.00",
        outstandingInterest: "4200.00",
        outstandingFees: "0.00",
        nextDueDate: "2026-07-13",
        ...options.oldLoan,
    }).returning().then((rows) => rows[0]!);
    await db.insert(loanSchedules).values([
        {
            tenantId,
            loanId: oldLoan.id,
            installmentNo: 1,
            dueDate: "2026-07-13",
            scheduledPrincipal: "180.00",
            scheduledInterest: "21.00",
            scheduledFee: "0.00",
            scheduledTotal: "201.00",
            paidTotal: "0.00",
            paidPenalty: "0.00",
            remainingDue: "201.00",
            status: "pending",
        },
        {
            tenantId,
            loanId: oldLoan.id,
            installmentNo: 2,
            dueDate: "2026-07-14",
            scheduledPrincipal: "180.00",
            scheduledInterest: "21.00",
            scheduledFee: "0.00",
            scheduledTotal: "201.00",
            paidTotal: "0.00",
            paidPenalty: "0.00",
            remainingDue: "201.00",
            status: "pending",
        },
    ]);
    await db.insert(loanFundingAllocations).values({
        tenantId,
        loanId: oldLoan.id,
        bankLoanId: drawdown?.id ?? null,
        bankProfileId: profile.id,
        allocatedAmount: "36000.00",
        allocationDate: "2026-07-12",
        allocationType: "initial",
        allocationGroupId: crypto.randomUUID(),
        createdByUserId: actor.id,
    });

    const replacementDraftInput: LoanDraftInput = {
        borrowerPublicId: borrower.publicId,
        bankLoanPublicId: drawdown?.publicId ?? null,
        bankProfilePublicId: drawdown ? null : profile.publicId,
        principal: "36000.00",
        interestRate: "0.00",
        repaymentType: "daily",
        termMonths: 7,
        totalInstallments: 200,
        installmentAmount: "300.00",
        startDate: "2026-07-11",
        ...options.replacementDraft,
    };
    const createdDraft = await createLoanDraft(
        replacementContext(tenantId, actor.id, `draft-${fixtureSequence}`),
        replacementDraftInput,
    );
    const replacementDraft = await db.query.loans.findFirst({
        where: and(eq(loans.tenantId, tenantId), eq(loans.publicId, createdDraft.publicId)),
    });
    if (!replacementDraft) throw new Error("Replacement test draft was not persisted");
    if (options.partialDraftAllocation) {
        await db.insert(loanFundingAllocations).values({
            tenantId,
            loanId: replacementDraft.id,
            bankLoanId: drawdown?.id ?? null,
            bankProfileId: profile.id,
            allocatedAmount: options.partialDraftAllocation,
            allocationDate: "2026-07-11",
            allocationType: "initial",
            allocationGroupId: crypto.randomUUID(),
            createdByUserId: actor.id,
        });
    }

    function context(idempotencyKey = "replacement-preview") {
        return replacementContext(tenantId, actor.id, idempotencyKey);
    }

    return {
        tenantId,
        actor,
        borrower,
        oldLoan,
        replacementDraft,
        source: { profile, drawdown },
        context,
        preview: (reason = "Corrected start date") => previewLoanReplacement(context(), {
            oldLoanPublicId: oldLoan.publicId,
            replacementDraftPublicId: replacementDraft.publicId,
            reason,
        }),
        execute: (preview, key = "replacement-execute", why = "Corrected start date") => executeLoanReplacement(
            context(key),
            {
                replacementPublicId: preview.publicId,
                previewHash: preview.previewHash,
                expectedOldBalanceVersion: preview.oldBalanceVersion,
                expectedReplacementDraftVersion: preview.replacementDraftVersion,
                reason: why,
                confirmed: true,
            },
        ),
        reverse: (replacementPublicId, key = "replacement-reverse", why = "Reverse replacement") => reverseLoanReplacement(
            context(key),
            { replacementPublicId, reason: why },
        ),
        counts: async () => {
            const [replacementRows, oldSchedules, replacementSchedules, oldAllocations, replacementAllocations, corrections, executionAudits, reversalAudits, payments, disbursements] = await Promise.all([
                db.select().from(loanReplacements).where(eq(loanReplacements.tenantId, tenantId)),
                db.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, tenantId), eq(loanSchedules.loanId, oldLoan.id))),
                db.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, tenantId), eq(loanSchedules.loanId, replacementDraft.id))),
                db.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, tenantId), eq(loanFundingAllocations.loanId, oldLoan.id))),
                db.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, tenantId), eq(loanFundingAllocations.loanId, replacementDraft.id))),
                db.select().from(loanReplacementCorrections).where(eq(loanReplacementCorrections.tenantId, tenantId)),
                db.select().from(auditLogs).where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.entityType, "loan_replacement"), eq(auditLogs.action, "executed"))),
                db.select().from(auditLogs).where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.entityType, "loan_replacement"), eq(auditLogs.action, "reversed"))),
                db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.loanId, replacementDraft.id))),
                db.select().from(loanDisbursementEvents).where(and(eq(loanDisbursementEvents.tenantId, tenantId), eq(loanDisbursementEvents.loanId, replacementDraft.id))),
            ]);
            return {
                replacementRows: replacementRows.length,
                oldSchedules: oldSchedules.length,
                replacementSchedules: replacementSchedules.length,
                oldAllocations: oldAllocations.length,
                replacementAllocations: replacementAllocations.length,
                corrections: corrections.length,
                executionAudits: executionAudits.length,
                reversalAudits: reversalAudits.length,
                payments: payments.length,
                disbursements: disbursements.length,
            };
        },
    };
}
