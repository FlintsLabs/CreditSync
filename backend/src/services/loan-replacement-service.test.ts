import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db";
import {
    auditLogs,
    bankLoans,
    bankProfiles,
    borrowers,
    intermediaries,
    intermediatedDisbursementGroups,
    intermediaryCollections,
    intermediaryRemittanceAllocations,
    intermediaryRemittances,
    loanAdjustments,
    loanCommissionParticipants,
    loanDisbursementEvents,
    loanFundingAllocations,
    loanIntermediaryAssignments,
    loanOpeningBalanceComponents,
    loanRenewals,
    loanReplacementCorrections,
    loanReplacements,
    loanRestructures,
    loanRestructureWaivers,
    loanSchedules,
    loanSettlementPreviews,
    loans,
    transactions,
    users,
} from "../db/schema";
import { FinancialDecimal } from "../lib/financial-decimal";
import { createLoanDraft } from "./loan-application-service";
import { createIntermediaryCollection } from "./intermediary-service";
import { assignIntermediaryToLoan } from "./intermediary-profile-service";
import { addLoanCommissionParticipant } from "./loan-commission-service";
import { createDisbursementDraft, postDisbursement } from "./loan-disbursement-service";
import { createFundingAllocation } from "./loan-funding-service";
import { executeLoanWaiver, previewLoanWaiver } from "./loan-waiver-service";
import { resetReplacementDatabase, seedReplacementFixture, type ReplacementFixture } from "./loan-replacement-test-fixture";
import {
    executeLoanReplacement,
    previewLoanReplacement,
    reverseLoanReplacement,
    type LoanReplacementExecution,
    type LoanReplacementPreview,
    type LoanReplacementProposal,
} from "./loan-replacement-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

function rejectedReason<T>(result: PromiseSettledResult<T>): unknown {
    if (result.status !== "rejected") throw new Error("Expected a rejected promise result");
    return result.reason;
}

async function waitForPostgresLockWaiters(
    observer: ReturnType<typeof postgres>,
    minimum: number,
): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        const rows = await observer<{ count: number }[]>`
            SELECT count(DISTINCT pid)::int AS count
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
        `;
        if ((rows[0]?.count ?? 0) >= minimum) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${minimum} PostgreSQL lock waiters`);
}

async function expectUnchangedPreviewState(
    fixture: ReplacementFixture,
    expectedOldOutstandingInterest = "4200.00",
): Promise<void> {
    const [oldLoan, draft, replacement, correctionRows, executionAudits] = await Promise.all([
        db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) }),
        db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) }),
        db.query.loanReplacements.findFirst({ where: eq(loanReplacements.tenantId, fixture.tenantId) }),
        db.select().from(loanReplacementCorrections).where(eq(loanReplacementCorrections.tenantId, fixture.tenantId)),
        db.select().from(auditLogs).where(and(
            eq(auditLogs.tenantId, fixture.tenantId),
            eq(auditLogs.entityType, "loan_replacement"),
            eq(auditLogs.action, "executed"),
        )),
    ]);
    expect(oldLoan).toMatchObject({
        status: "active",
        outstandingPrincipal: "36000.00",
        outstandingInterest: expectedOldOutstandingInterest,
        nextDueDate: "2026-07-13",
    });
    expect(draft).toMatchObject({ status: "draft", activationIdempotencyKey: null });
    expect(replacement).toMatchObject({ status: "preview", executeIdempotencyKey: null });
    expect(correctionRows).toHaveLength(0);
    expect(executionAudits).toHaveLength(0);
}

type LoanRow = typeof loans.$inferSelect;
type DownstreamSeeder = (
    fixture: ReplacementFixture,
    targetLoan: LoanRow,
) => Promise<string>;

let downstreamSequence = 0;

function nextDownstreamKey(label: string): string {
    downstreamSequence += 1;
    return `${label}-${downstreamSequence}`;
}

async function prepareChainedReplacement(fixture: ReplacementFixture): Promise<{
    draft: LoanRow;
    preview: LoanReplacementPreview;
    reason: string;
}> {
    const draftResult = await createLoanDraft(fixture.context(nextDownstreamKey("chain-draft")), {
        borrowerPublicId: fixture.borrower.publicId,
        bankLoanPublicId: fixture.source.drawdown?.publicId ?? null,
        bankProfilePublicId: fixture.source.drawdown ? null : fixture.source.profile.publicId,
        principal: "36000.00",
        interestRate: "0.00",
        repaymentType: "daily",
        termMonths: 7,
        totalInstallments: 200,
        installmentAmount: "300.00",
        startDate: "2026-07-11",
    });
    const draft = await db.query.loans.findFirst({ where: and(
        eq(loans.tenantId, fixture.tenantId),
        eq(loans.publicId, draftResult.publicId),
    ) });
    if (!draft) throw new Error("Chained replacement draft was not persisted");
    const reason = "Replace the current replacement contract";
    const preview = await previewLoanReplacement(
        fixture.context(nextDownstreamKey("chain-preview")),
        {
            oldLoanPublicId: fixture.replacementDraft.publicId,
            replacementDraftPublicId: draft.publicId,
            reason,
        },
    );
    return { draft, preview, reason };
}

async function executeChainedReplacement(fixture: ReplacementFixture): Promise<{
    draft: LoanRow;
    execution: LoanReplacementExecution;
}> {
    const { draft, preview, reason } = await prepareChainedReplacement(fixture);
    const execution = await executeLoanReplacement(
        fixture.context(nextDownstreamKey("chain-execute")),
        {
            replacementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            expectedOldBalanceVersion: preview.oldBalanceVersion,
            expectedReplacementDraftVersion: preview.replacementDraftVersion,
            reason,
            confirmed: true,
        },
    );
    return { draft, execution };
}

function otherLoan(fixture: ReplacementFixture, targetLoan: LoanRow): LoanRow {
    return targetLoan.id === fixture.oldLoan.id ? fixture.replacementDraft : fixture.oldLoan;
}

async function historicalPredecessor(fixture: ReplacementFixture): Promise<LoanRow> {
    return db.insert(loans).values({
        tenantId: fixture.tenantId,
        ownerUserId: fixture.actor.id,
        borrowerId: fixture.borrower.id,
        principalAmount: "1.00",
        interestRate: "0.00",
        repaymentType: "monthly",
        status: "replaced",
        outstandingPrincipal: "0.00",
        outstandingInterest: "0.00",
        outstandingFees: "0.00",
    }).returning().then((rows) => rows[0]!);
}

async function seedWorkflowAudit(
    fixture: ReplacementFixture,
    entityType: string,
    entityId: string,
): Promise<typeof auditLogs.$inferSelect> {
    return db.insert(auditLogs).values({
        tenantId: fixture.tenantId,
        entityType,
        entityId,
        action: "executed",
        actorSource: "system",
        correlationId: nextDownstreamKey("audit"),
    }).returning().then((rows) => rows[0]!);
}

async function insertExecutedRestructure(
    fixture: ReplacementFixture,
    targetLoan: LoanRow,
    targetIsOldLoan: boolean,
    peerLoan: LoanRow = otherLoan(fixture, targetLoan),
): Promise<typeof loanRestructures.$inferSelect> {
    const oldLoan = targetIsOldLoan ? targetLoan : peerLoan;
    const newLoan = targetIsOldLoan ? peerLoan : targetLoan;
    const audit = await seedWorkflowAudit(fixture, "loan_restructure", targetLoan.publicId);
    const key = nextDownstreamKey("restructure");
    return db.insert(loanRestructures).values({
        tenantId: fixture.tenantId,
        oldLoanId: oldLoan.id,
        newLoanId: newLoan.id,
        settlementDate: "2026-08-17",
        oldBalanceVersion: `v1:${"a".repeat(64)}`,
        status: "executed",
        previewHash: `v1:${"b".repeat(64)}`,
        requestHash: "c".repeat(64),
        requestedReplacementTerms: {},
        grossPrincipal: "1.00",
        grossInterest: "0.00",
        grossFees: "0.00",
        grossPenalty: "0.00",
        netPrincipal: "1.00",
        netInterest: "0.00",
        netFees: "0.00",
        netPenalty: "0.00",
        cashDirection: "none",
        cashAmount: "0.00",
        reason: "Downstream blocker fixture",
        createdActorSource: "system",
        executeActorSource: "system",
        correlationId: key,
        executeIdempotencyKey: key,
        executeRequestHash: "d".repeat(64),
        executedAuditPublicId: audit.publicId,
        preExecutionOldLoanState: {
            status: "active",
            outstandingPrincipal: "1.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            nextDueDate: null,
        },
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        executedAt: new Date("2026-08-17T00:00:00.000Z"),
    }).returning().then((rows) => rows[0]!);
}

async function prepareOldLoanWaiver(fixture: ReplacementFixture) {
    const predecessor = await historicalPredecessor(fixture);
    const restructure = await insertExecutedRestructure(fixture, fixture.oldLoan, false, predecessor);
    await db.insert(loanOpeningBalanceComponents).values({
        tenantId: fixture.tenantId,
        restructureId: restructure.id,
        loanId: fixture.oldLoan.id,
        componentKind: "carried_interest",
        amount: "10.00",
        sourceType: "loan_restructure",
        sourcePublicId: restructure.publicId,
        createdByUserId: fixture.actor.id,
    });
    return previewLoanWaiver(
        fixture.context(),
        fixture.oldLoan.publicId,
        { component: "interest", amount: "1.00", reason: "Approved assistance" },
    );
}

async function seedIntermediary(
    fixture: ReplacementFixture,
): Promise<typeof intermediaries.$inferSelect> {
    const key = nextDownstreamKey("intermediary");
    return db.insert(intermediaries).values({
        tenantId: fixture.tenantId,
        ownerUserId: fixture.actor.id,
        name: `Replacement intermediary ${key}`,
        normalizedName: `replacement-intermediary-${key}`,
        createdByUserId: fixture.actor.id,
        updatedByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
}

const seedPostedPayment: DownstreamSeeder = async (fixture, targetLoan) => {
    const row = await db.insert(transactions).values({
        tenantId: fixture.tenantId,
        ownerUserId: fixture.actor.id,
        loanId: targetLoan.id,
        amount: "1.00",
        principalComponent: "1.00",
        type: "repayment",
        entryType: "repayment",
        idempotencyKey: nextDownstreamKey("payment"),
        postedAt: new Date("2026-08-17T00:00:00.000Z"),
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const seedPostedDisbursement: DownstreamSeeder = async (fixture, targetLoan) => {
    const row = await db.insert(loanDisbursementEvents).values({
        tenantId: fixture.tenantId,
        loanId: targetLoan.id,
        grossAmount: "1.00",
        loanAttributedAmount: "1.00",
        channel: "bank_transfer",
        sourceBankProfileId: fixture.source.profile.id,
        status: "posted",
        disbursedAt: new Date("2026-08-17T00:00:00.000Z"),
        postedAt: new Date("2026-08-17T00:00:01.000Z"),
        postIdempotencyKey: nextDownstreamKey("disbursement"),
        createdByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const seedExecutedRenewal: DownstreamSeeder = async (fixture, targetLoan) => {
    const row = await db.insert(loanRenewals).values({
        tenantId: fixture.tenantId,
        oldLoanId: targetLoan.id,
        newLoanId: otherLoan(fixture, targetLoan).id,
        status: "executed",
        previewHash: `v1:${"e".repeat(64)}`,
        requestedPrincipal: "1.00",
        outstandingPrincipal: "1.00",
        cashDirection: "none",
        cashAmount: "0.00",
        idempotencyKey: nextDownstreamKey("renewal"),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        executedAt: new Date("2026-08-17T00:00:00.000Z"),
        createdByUserId: fixture.actor.id,
        executedByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const seedExecutedRestructure: DownstreamSeeder = async (fixture, targetLoan) => {
    const row = await insertExecutedRestructure(fixture, targetLoan, true);
    return row.publicId;
};

const seedExecutedSettlement: DownstreamSeeder = async (fixture, targetLoan) => {
    const row = await db.insert(loanSettlementPreviews).values({
        tenantId: fixture.tenantId,
        loanId: targetLoan.id,
        asOfDate: "2026-08-17",
        outstandingPrincipal: "1.00",
        dueInterest: "0.00",
        accruedNotDueInterest: "0.00",
        outstandingFees: "0.00",
        outstandingPenalties: "0.00",
        originalOutstandingInterest: "0.00",
        nonRefundableAdvanceInterest: "0.00",
        settlementTotal: "1.00",
        balanceVersion: `v1:${"f".repeat(64)}`,
        previewHash: `v1:${"1".repeat(64)}`,
        status: "executed",
        executeIdempotencyKey: nextDownstreamKey("settlement"),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        executedAt: new Date("2026-08-17T00:00:00.000Z"),
        createdByUserId: fixture.actor.id,
        executedByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const seedExecutedWaiver: DownstreamSeeder = async (fixture, targetLoan) => {
    const predecessor = await historicalPredecessor(fixture);
    const restructure = await insertExecutedRestructure(fixture, targetLoan, false, predecessor);
    const audit = await seedWorkflowAudit(fixture, "loan_restructure_waiver", targetLoan.publicId);
    const row = await db.insert(loanRestructureWaivers).values({
        tenantId: fixture.tenantId,
        restructureId: restructure.id,
        loanId: targetLoan.id,
        componentKind: "interest",
        amount: "1.00",
        reason: "Downstream waiver fixture",
        status: "executed",
        actorSource: "system",
        correlationId: nextDownstreamKey("waiver-correlation"),
        executeIdempotencyKey: nextDownstreamKey("waiver"),
        executeRequestHash: "2".repeat(64),
        auditPublicId: audit.publicId,
        executedAt: new Date("2026-08-17T00:00:00.000Z"),
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const seedIntermediaryCollection: DownstreamSeeder = async (fixture, targetLoan) => {
    const intermediary = await seedIntermediary(fixture);
    const row = await db.insert(intermediaryCollections).values({
        tenantId: fixture.tenantId,
        ownerUserId: fixture.actor.id,
        intermediaryId: intermediary.id,
        borrowerId: fixture.borrower.id,
        loanId: targetLoan.id,
        amount: "1.00",
        borrowerPaidAt: new Date("2026-08-17T00:00:00.000Z"),
        status: "pending_remittance",
        idempotencyKey: nextDownstreamKey("collection"),
        createdByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const seedPostedRemittance: DownstreamSeeder = async (fixture, targetLoan) => {
    const intermediary = await seedIntermediary(fixture);
    const collection = await db.insert(intermediaryCollections).values({
        tenantId: fixture.tenantId,
        ownerUserId: fixture.actor.id,
        intermediaryId: intermediary.id,
        borrowerId: fixture.borrower.id,
        loanId: targetLoan.id,
        amount: "1.00",
        borrowerPaidAt: new Date("2026-08-17T00:00:00.000Z"),
        status: "allocated",
        idempotencyKey: nextDownstreamKey("remitted-collection"),
        createdByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
    const remittance = await db.insert(intermediaryRemittances).values({
        tenantId: fixture.tenantId,
        ownerUserId: fixture.actor.id,
        intermediaryId: intermediary.id,
        grossAmount: "1.00",
        receivedAt: new Date("2026-08-17T00:00:00.000Z"),
        status: "posted",
        idempotencyKey: nextDownstreamKey("remittance-draft"),
        postIdempotencyKey: nextDownstreamKey("remittance-post"),
        postedByUserId: fixture.actor.id,
        postedAt: new Date("2026-08-17T00:00:01.000Z"),
        createdByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
    await db.insert(intermediaryRemittanceAllocations).values({
        tenantId: fixture.tenantId,
        remittanceId: remittance.id,
        collectionId: collection.id,
        allocationOrder: 1,
        createdByUserId: fixture.actor.id,
    });
    return remittance.publicId;
};

const seedIntermediaryAssignment: DownstreamSeeder = async (fixture, targetLoan) => {
    const intermediary = await seedIntermediary(fixture);
    const row = await db.insert(loanIntermediaryAssignments).values({
        tenantId: fixture.tenantId,
        loanId: targetLoan.id,
        intermediaryId: intermediary.id,
        role: "collection",
        effectiveFrom: new Date("2026-08-17T00:00:00.000Z"),
        status: "active",
        idempotencyKey: nextDownstreamKey("assignment"),
        createdByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const seedCommissionParticipant: DownstreamSeeder = async (fixture, targetLoan) => {
    const intermediary = await seedIntermediary(fixture);
    const audit = await seedWorkflowAudit(fixture, "loan_commission_participant", targetLoan.publicId);
    const key = nextDownstreamKey("commission");
    const row = await db.insert(loanCommissionParticipants).values({
        tenantId: fixture.tenantId,
        loanId: targetLoan.id,
        intermediaryId: intermediary.id,
        commissionRate: "1.0000",
        role: "collector",
        effectiveFrom: new Date("2026-08-17T00:00:00.000Z"),
        status: "active",
        idempotencyKey: key,
        auditPublicId: audit.publicId,
        actorSource: "web",
        requestId: `req-${key}`,
        correlationId: `corr-${key}`,
        createdByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const seedIntermediatedDisbursement: DownstreamSeeder = async (fixture, targetLoan) => {
    const intermediary = await seedIntermediary(fixture);
    const row = await db.insert(intermediatedDisbursementGroups).values({
        tenantId: fixture.tenantId,
        loanId: targetLoan.id,
        intermediaryId: intermediary.id,
        expectedFundingAmount: "1.00",
        expectedBorrowerPayoutAmount: "1.00",
        expectedAdvanceInterestReturnAmount: "0.00",
        retainedBalanceAmount: "0.00",
        status: "posted",
        idempotencyKey: nextDownstreamKey("intermediated-disbursement"),
        postIdempotencyKey: nextDownstreamKey("intermediated-disbursement-post"),
        createdByUserId: fixture.actor.id,
        postedByUserId: fixture.actor.id,
        postedAt: new Date("2026-08-17T00:00:00.000Z"),
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const seedPostedAdjustment: DownstreamSeeder = async (fixture, targetLoan) => {
    const row = await db.insert(loanAdjustments).values({
        tenantId: fixture.tenantId,
        loanId: targetLoan.id,
        adjustmentType: "manual_correction",
        amount: "1.00",
        status: "posted",
        idempotencyKey: nextDownstreamKey("adjustment"),
        reason: "Downstream adjustment fixture",
        createdByUserId: fixture.actor.id,
    }).returning().then((rows) => rows[0]!);
    return row.publicId;
};

const downstreamBlockers: Array<{
    name: string;
    seed: DownstreamSeeder;
    executeCode: string;
}> = [
    { name: "posted payment", seed: seedPostedPayment, executeCode: "REPLACEMENT_DOWNSTREAM_ACTIVITY" },
    { name: "effective posted disbursement", seed: seedPostedDisbursement, executeCode: "REPLACEMENT_DOWNSTREAM_ACTIVITY" },
    { name: "executed renewal", seed: seedExecutedRenewal, executeCode: "REPLACEMENT_DEPENDENT_WORKFLOW" },
    { name: "executed restructure", seed: seedExecutedRestructure, executeCode: "REPLACEMENT_DEPENDENT_WORKFLOW" },
    { name: "executed settlement", seed: seedExecutedSettlement, executeCode: "REPLACEMENT_DEPENDENT_WORKFLOW" },
    { name: "executed waiver", seed: seedExecutedWaiver, executeCode: "REPLACEMENT_DOWNSTREAM_ACTIVITY" },
    { name: "intermediary collection", seed: seedIntermediaryCollection, executeCode: "REPLACEMENT_DOWNSTREAM_ACTIVITY" },
    { name: "posted remittance allocation", seed: seedPostedRemittance, executeCode: "REPLACEMENT_DOWNSTREAM_ACTIVITY" },
    { name: "intermediary assignment", seed: seedIntermediaryAssignment, executeCode: "REPLACEMENT_DOWNSTREAM_ACTIVITY" },
    { name: "commission participant", seed: seedCommissionParticipant, executeCode: "REPLACEMENT_DOWNSTREAM_ACTIVITY" },
    { name: "intermediated disbursement", seed: seedIntermediatedDisbursement, executeCode: "REPLACEMENT_DOWNSTREAM_ACTIVITY" },
    { name: "posted loan adjustment", seed: seedPostedAdjustment, executeCode: "REPLACEMENT_DOWNSTREAM_ACTIVITY" },
];

describe("loan replacement service database invariants", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(resetReplacementDatabase);
    afterEach(() => setSystemTime());

    // Break caught: preview carries the erroneous interest into the replacement, uses the wrong daily terms, or execution duplicates financial rows.
    integrationTest("executes the approved no-cash replacement exactly once", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();

        expect(preview).toMatchObject({
            cash: { direction: "none", amount: "0.00" },
            correction: {
                principal: "36000.00",
                interest: "4200.00",
                fee: "0.00",
                penalty: "0.00",
            },
            replacement: {
                loanPublicId: fixture.replacementDraft.publicId,
                startDate: "2026-07-11",
                firstDueDate: "2026-07-12",
                lastDueDate: "2027-01-27",
                totalRepayment: "60000.00",
                fundingSourcePublicId: fixture.source.drawdown!.publicId,
                fundingSourceName: "TTB",
            },
            warnings: [{
                code: "OUTSTANDING_INTEREST_CORRECTED_TO_ZERO",
                details: {
                    amount: "4200.00",
                    correctedAmount: "0.00",
                    collected: false,
                    carriedForward: false,
                },
            }],
        });

        const executed = await fixture.execute(preview);
        const replay = await fixture.execute(preview);
        expect(replay).toEqual(executed);
        expect(await fixture.counts()).toEqual({
            replacementRows: 1,
            oldSchedules: 2,
            replacementSchedules: 200,
            oldAllocations: 1,
            replacementAllocations: 1,
            corrections: 1,
            executionAudits: 1,
            reversalAudits: 0,
            payments: 0,
            disbursements: 0,
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) })).toMatchObject({
            status: "replaced",
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            nextDueDate: null,
        });
        const replacementAllocations = await db.select().from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, fixture.tenantId),
            eq(loanFundingAllocations.loanId, fixture.replacementDraft.id),
        ));
        expect(replacementAllocations).toMatchObject([{
            bankLoanId: fixture.source.drawdown!.id,
            bankProfileId: fixture.source.profile.id,
            allocatedAmount: "36000.00",
        }]);
    });

    // Break caught: idempotent execution/reversal replay returns the retry request's correlation
    // instead of the immutable correlation attached to the original financial audit.
    integrationTest("replays execution and reversal with their persisted audit correlations", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const executionReason = "Corrected start date";
        const executionContext = fixture.context("persisted-execution-correlation");
        const executionInput = {
            replacementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            expectedOldBalanceVersion: preview.oldBalanceVersion,
            expectedReplacementDraftVersion: preview.replacementDraftVersion,
            reason: executionReason,
            confirmed: true as const,
        };
        const execution = await executeLoanReplacement(executionContext, executionInput);
        const executionReplay = await executeLoanReplacement({
            ...executionContext,
            requestId: "retry-execution-request",
            correlationId: "retry-execution-correlation",
        }, executionInput);
        expect(executionReplay).toEqual(execution);

        const reversalReason = "Undo corrected dates";
        const reversalContext = fixture.context("persisted-reversal-correlation");
        const reversal = await fixture.reverse(
            execution.replacementPublicId,
            "persisted-reversal-correlation",
            reversalReason,
        );
        const reversalReplay = await reverseLoanReplacement({
            ...reversalContext,
            requestId: "retry-reversal-request",
            correlationId: "retry-reversal-correlation",
        }, {
            replacementPublicId: execution.replacementPublicId,
            reason: reversalReason,
            confirmed: true,
        });
        expect(reversalReplay).toEqual(reversal);
    });

    // Break caught: execution replay ignores the aggregate's persisted audit FK and returns a
    // different generic audit with the same entity/action after the FK is corrupted.
    integrationTest("fails closed when the persisted execution audit does not describe this execution", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const executed = await fixture.execute(preview);
        const mismatchedAudit = await db.insert(auditLogs).values({
            tenantId: fixture.tenantId,
            entityType: "loan_replacement",
            entityId: executed.replacementPublicId,
            action: "executed",
            actorSource: "system",
            correlationId: "wrong-execution-audit",
            payload: {
                idempotencyKey: "wrong-execution-key",
                requestHash: "0".repeat(64),
                proposal: { schemaVersion: 0 },
            },
        }).returning().then((rows) => rows[0]!);

        await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL session_replication_role = replica`);
            await tx.update(loanReplacements).set({
                executedAuditPublicId: mismatchedAudit.publicId,
            }).where(and(
                eq(loanReplacements.tenantId, fixture.tenantId),
                eq(loanReplacements.publicId, executed.replacementPublicId),
            ));
        });

        await expect(fixture.execute(preview)).rejects.toMatchObject({
            code: "REPLACEMENT_AUDIT_MISMATCH",
            details: {
                reviewRequired: true,
                blockerPublicIds: [executed.replacementPublicId],
            },
        });
    });

    // Break caught: reversal replay silently returns an empty audit UUID when the exact audit
    // referenced by the immutable aggregate is absent.
    integrationTest("fails closed when the persisted reversal audit is missing", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const executed = await fixture.execute(preview);
        const reversalKey = "missing-reversal-audit";
        const reversalReason = "Restore the original agreement";
        const reversed = await fixture.reverse(
            executed.replacementPublicId,
            reversalKey,
            reversalReason,
        );

        await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL session_replication_role = replica`);
            await tx.delete(auditLogs).where(and(
                eq(auditLogs.tenantId, fixture.tenantId),
                eq(auditLogs.publicId, reversed.auditPublicId),
            ));
        });

        await expect(fixture.reverse(
            executed.replacementPublicId,
            reversalKey,
            reversalReason,
        )).rejects.toMatchObject({
            code: "REPLACEMENT_AUDIT_MISSING",
            details: {
                reviewRequired: true,
                blockerPublicIds: [executed.replacementPublicId],
            },
        });
    });

    // Break caught: an old-loan collectible rollup changes after confirmation without invalidating the preview.
    integrationTest("rejects execution when the old balance version is stale", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        await db.update(loans).set({ outstandingInterest: "4199.99" })
            .where(and(eq(loans.tenantId, fixture.tenantId), eq(loans.id, fixture.oldLoan.id)));

        await expect(fixture.execute(preview)).rejects.toMatchObject({
            code: "REPLACEMENT_PREVIEW_STALE",
            details: { reviewRequired: true },
        });
        await expectUnchangedPreviewState(fixture, "4199.99");
    });

    // Break caught: a material replacement term omitted from the draft fingerprint can change after confirmation.
    integrationTest("rejects execution when the replacement draft version is stale", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        await db.update(loans).set({ interestRate: "1.00" })
            .where(and(eq(loans.tenantId, fixture.tenantId), eq(loans.id, fixture.replacementDraft.id)));

        await expect(fixture.execute(preview)).rejects.toMatchObject({
            code: "REPLACEMENT_PREVIEW_STALE",
            details: { reviewRequired: true },
        });
        await expectUnchangedPreviewState(fixture);
    });

    // Break caught: a legacy/elevated writer can attach an effective payout to the replacement
    // draft, after which execution succeeds but is immediately non-reversible.
    integrationTest("rejects preview when the replacement draft has an effective disbursement", async () => {
        const fixture = await seedReplacementFixture();
        const blockerPublicId = await seedPostedDisbursement(fixture, fixture.replacementDraft);

        await expect(fixture.preview()).rejects.toMatchObject({
            code: "REPLACEMENT_DRAFT_DOWNSTREAM_ACTIVITY",
            details: {
                reviewRequired: true,
                blockerPublicIds: [blockerPublicId],
            },
        });
        expect(await db.select().from(loanReplacements).where(eq(
            loanReplacements.tenantId,
            fixture.tenantId,
        ))).toHaveLength(0);
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) }))
            .toMatchObject({ status: "active" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) }))
            .toMatchObject({ status: "draft" });
    });

    // Break caught: replacement-draft downstream history is omitted from the confirmation
    // fingerprint, so a compensated payout written after preview does not invalidate it.
    integrationTest("rejects execution when replacement draft downstream changes after preview", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const disbursement = await db.insert(loanDisbursementEvents).values({
            tenantId: fixture.tenantId,
            loanId: fixture.replacementDraft.id,
            grossAmount: "1.00",
            loanAttributedAmount: "1.00",
            channel: "bank_transfer",
            sourceBankProfileId: fixture.source.profile.id,
            status: "posted",
            disbursedAt: new Date("2026-08-17T00:00:00.000Z"),
            postedAt: new Date("2026-08-17T00:00:01.000Z"),
            postIdempotencyKey: nextDownstreamKey("stale-draft-disbursement"),
            createdByUserId: fixture.actor.id,
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanDisbursementEvents).values({
            tenantId: fixture.tenantId,
            loanId: fixture.replacementDraft.id,
            grossAmount: "1.00",
            loanAttributedAmount: "1.00",
            channel: "adjustment",
            status: "reversed",
            reversedEventId: disbursement.id,
            reversedAt: new Date("2026-08-17T00:00:02.000Z"),
            reversalIdempotencyKey: nextDownstreamKey("stale-draft-disbursement-reversal"),
            reversalRequestHash: "4".repeat(64),
            createdByUserId: fixture.actor.id,
        });

        await expect(fixture.execute(preview)).rejects.toMatchObject({
            code: "REPLACEMENT_PREVIEW_STALE",
            details: {
                reviewRequired: true,
                blockerPublicIds: [fixture.oldLoan.publicId, fixture.replacementDraft.publicId],
            },
        });
        await expectUnchangedPreviewState(fixture);
    });

    // Break caught: a draft owned by another borrower is accepted as the replacement.
    integrationTest("rejects a replacement draft for a different borrower", async () => {
        const fixture = await seedReplacementFixture();
        const otherBorrower = await db.insert(borrowers).values({
            tenantId: fixture.tenantId,
            ownerUserId: fixture.actor.id,
            name: "Different Borrower",
        }).returning().then((rows) => rows[0]!);
        await db.update(loans).set({ borrowerId: otherBorrower.id }).where(eq(loans.id, fixture.replacementDraft.id));

        await expect(fixture.preview()).rejects.toMatchObject({
            code: "REPLACEMENT_SCOPE_MISMATCH",
            details: {
                reviewRequired: true,
                blockerPublicIds: [fixture.oldLoan.publicId, fixture.replacementDraft.publicId],
            },
        });
        expect(await db.select().from(loanReplacements).where(eq(loanReplacements.tenantId, fixture.tenantId))).toHaveLength(0);
    });

    // Break caught: a draft administered by another owner scope is accepted as the replacement.
    integrationTest("rejects a replacement draft for a different owner", async () => {
        const fixture = await seedReplacementFixture();
        const otherOwner = await db.insert(users).values({
            tenantId: fixture.tenantId,
            email: "other-owner@example.test",
            role: "manager",
        }).returning().then((rows) => rows[0]!);
        await db.update(loans).set({ ownerUserId: otherOwner.id }).where(eq(loans.id, fixture.replacementDraft.id));

        await expect(fixture.preview()).rejects.toMatchObject({
            code: "REPLACEMENT_SCOPE_MISMATCH",
            details: { reviewRequired: true },
        });
        expect(await db.select().from(loanReplacements).where(eq(loanReplacements.tenantId, fixture.tenantId))).toHaveLength(0);
    });

    // Break caught: an allocation from a different source is silently treated as valid replacement funding.
    integrationTest("rejects replacement allocation from the wrong funding source", async () => {
        const fixture = await seedReplacementFixture();
        const otherProfile = await db.insert(bankProfiles).values({
            tenantId: fixture.tenantId,
            name: "Other Bank",
            type: "bank",
            status: "active",
            accountingMode: "external_liability",
        }).returning().then((rows) => rows[0]!);
        const otherDrawdown = await db.insert(bankLoans).values({
            tenantId: fixture.tenantId,
            bankProfileId: otherProfile.id,
            amount: "1000.00",
            interestRate: "0.00",
            termMonths: 1,
            status: "active",
            startDate: "2026-07-01",
        }).returning().then((rows) => rows[0]!);
        const wrongAllocation = await db.insert(loanFundingAllocations).values({
            tenantId: fixture.tenantId,
            bankProfileId: otherProfile.id,
            bankLoanId: otherDrawdown.id,
            loanId: fixture.replacementDraft.id,
            allocatedAmount: "100.00",
            allocationDate: "2026-07-11",
            allocationType: "initial",
            allocationGroupId: crypto.randomUUID(),
            createdByUserId: fixture.actor.id,
        }).returning().then((rows) => rows[0]!);

        await expect(fixture.preview()).rejects.toMatchObject({
            code: "REPLACEMENT_FUNDING_MISMATCH",
            details: {
                reviewRequired: true,
                blockerPublicIds: [wrongAllocation.publicId, fixture.source.drawdown!.publicId],
            },
        });
    });

    // Break caught: a configured source can become inactive without stopping replacement execution.
    integrationTest("rejects inactive replacement funding", async () => {
        const fixture = await seedReplacementFixture();
        await db.update(bankLoans).set({ status: "closed" }).where(eq(bankLoans.id, fixture.source.drawdown!.id));

        await expect(fixture.preview()).rejects.toMatchObject({
            code: "REPLACEMENT_FUNDING_INVALID",
            details: {
                reviewRequired: true,
                blockerPublicIds: [fixture.source.drawdown!.publicId],
            },
        });
    });

    // Break caught: the replacement activates even though the configured source cannot fund the remaining principal.
    integrationTest("rejects insufficient replacement funding capacity", async () => {
        const fixture = await seedReplacementFixture({ sourceCapacity: "71999.99" });

        await expect(fixture.preview()).rejects.toMatchObject({
            code: "REPLACEMENT_FUNDING_INSUFFICIENT",
            details: {
                reviewRequired: true,
                blockerPublicIds: [fixture.source.drawdown!.publicId],
            },
        });
    });

    // Break caught: activation skips the missing delta when a draft is validly but only partially funded.
    integrationTest("adds only the missing funding delta for a partially funded draft", async () => {
        const fixture = await seedReplacementFixture({ partialDraftAllocation: "10000.00" });
        const preview = await fixture.preview();
        await fixture.execute(preview);

        const allocations = await db.select().from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, fixture.tenantId),
            eq(loanFundingAllocations.loanId, fixture.replacementDraft.id),
        )).orderBy(asc(loanFundingAllocations.id));
        expect(allocations.map((row) => row.allocatedAmount)).toEqual(["10000.00", "26000.00"]);
        expect(allocations.reduce(
            (total, row) => total.plus(row.allocatedAmount),
            new FinancialDecimal(0),
        ).toFixed(2)).toBe("36000.00");
    });

    // Break caught: parallel identical retries duplicate schedules, corrections, allocations, or audits.
    integrationTest("serializes parallel identical execution into one financial mutation", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();

        const results = await Promise.all([
            fixture.execute(preview, "parallel-identical"),
            fixture.execute(preview, "parallel-identical"),
        ]);
        expect(results[1]).toEqual(results[0]);
        expect(await fixture.counts()).toMatchObject({
            replacementRows: 1,
            replacementSchedules: 200,
            replacementAllocations: 1,
            corrections: 1,
            executionAudits: 1,
        });
    });

    // Break caught: parallel requests with different keys both execute the same confirmed preview.
    integrationTest("allows only one of parallel conflicting execution keys", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();

        const results = await Promise.allSettled([
            fixture.execute(preview, "parallel-key-a"),
            fixture.execute(preview, "parallel-key-b"),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(rejectedReason(results.find((result) => result.status === "rejected")!)).toMatchObject({
            code: "IDEMPOTENCY_CONFLICT",
        });
        expect(await fixture.counts()).toMatchObject({
            replacementSchedules: 200,
            replacementAllocations: 1,
            corrections: 1,
            executionAudits: 1,
        });
    });

    // Break caught: a tenant-wide execution key race falls through to a raw unique-index error.
    integrationTest("returns a stable conflict for a cross-record execution key race", async () => {
        const first = await seedReplacementFixture({ tenantId: "cross-record-execute" });
        const second = await seedReplacementFixture({ tenantId: "cross-record-execute" });
        const [firstPreview, secondPreview] = await Promise.all([first.preview(), second.preview()]);

        const results = await Promise.allSettled([
            first.execute(firstPreview, "shared-execution-key"),
            second.execute(secondPreview, "shared-execution-key"),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(rejectedReason(results.find((result) => result.status === "rejected")!)).toMatchObject({
            code: "IDEMPOTENCY_CONFLICT",
        });
        const replacements = await db.select().from(loanReplacements).where(eq(
            loanReplacements.tenantId,
            "cross-record-execute",
        ));
        expect(replacements.filter((row) => row.status === "executed")).toHaveLength(1);
        expect(replacements.filter((row) => row.status === "preview")).toHaveLength(1);
    });

    // Break caught: an activation error commits an old-loan correction or terminal status before the failure surfaces.
    integrationTest("rolls back every mutation when replacement activation fails", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const functionName = `test_fail_replacement_activation_${fixture.replacementDraft.id}`;
        const triggerName = `test_fail_replacement_activation_trigger_${fixture.replacementDraft.id}`;
        await db.execute(sql.raw(`
            CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.loan_id = ${fixture.replacementDraft.id} THEN
                RAISE EXCEPTION 'test-only replacement activation failure';
              END IF;
              RETURN NEW;
            END; $$;
            CREATE TRIGGER ${triggerName}
              BEFORE INSERT ON loan_schedules
              FOR EACH ROW EXECUTE FUNCTION ${functionName}();
        `));
        try {
            await expect(fixture.execute(preview)).rejects.toThrow();
        } finally {
            await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON loan_schedules`));
            await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
        }

        await expectUnchangedPreviewState(fixture);
        expect(await fixture.counts()).toMatchObject({
            oldSchedules: 2,
            replacementSchedules: 0,
            oldAllocations: 1,
            replacementAllocations: 0,
            corrections: 0,
            executionAudits: 0,
        });
        expect(await db.select().from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, fixture.tenantId),
            eq(loanSchedules.loanId, fixture.oldLoan.id),
        ))).toMatchObject([
            { status: "pending", remainingDue: "201.00" },
            { status: "pending", remainingDue: "201.00" },
        ]);
    });

    // Break caught: a disbursement draft can cross the replacement terminal-state boundary without either command stopping.
    integrationTest("serializes replacement execution against disbursement creation", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const results = await Promise.allSettled([
            fixture.execute(preview, "execute-vs-disbursement"),
            createDisbursementDraft(
                fixture.context("create-vs-replacement"),
                fixture.oldLoan.publicId,
                {
                    grossAmount: "1.00",
                    loanAttributedAmount: "1.00",
                    channel: "bank_transfer",
                    sourceBankProfilePublicId: fixture.source.profile.publicId,
                    disbursedAt: "2026-08-17T00:00:00.000Z",
                },
            ),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const oldLoan = await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) });
        const events = await db.select().from(loanDisbursementEvents).where(eq(
            loanDisbursementEvents.loanId,
            fixture.oldLoan.id,
        ));
        expect(oldLoan?.status === "replaced" ? events : []).toHaveLength(0);
    });

    // Break caught: an existing draft can be posted after replacement because the posting
    // transaction locks the parent loan but does not revalidate its terminal status.
    integrationTest("rejects disbursement posting after the loan is replaced", async () => {
        const fixture = await seedReplacementFixture();
        const draft = await createDisbursementDraft(
            fixture.context("draft-before-replacement"),
            fixture.oldLoan.publicId,
            {
                grossAmount: "1.00",
                loanAttributedAmount: "1.00",
                channel: "bank_transfer",
                sourceBankProfilePublicId: fixture.source.profile.publicId,
                disbursedAt: "2026-08-17T00:00:00.000Z",
            },
        );
        const preview = await fixture.preview();
        await fixture.execute(preview);

        await expect(postDisbursement(
            fixture.context("post-after-replacement"),
            draft.publicId,
        )).rejects.toMatchObject({ code: "LOAN_DISBURSEMENT_LOCKED", status: 409 });
        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(
            loanDisbursementEvents.publicId,
            draft.publicId,
        ) })).toMatchObject({ status: "draft", postIdempotencyKey: null });
    });

    // Break caught: replacement can commit while an existing disbursement draft waits on the
    // parent lock, after which the waiting command posts against the now-terminal old loan.
    integrationTest("serializes replacement execution against disbursement posting", async () => {
        const fixture = await seedReplacementFixture();
        const draft = await createDisbursementDraft(
            fixture.context("race-draft-before-replacement"),
            fixture.oldLoan.publicId,
            {
                grossAmount: "1.00",
                loanAttributedAmount: "1.00",
                channel: "bank_transfer",
                sourceBankProfilePublicId: fixture.source.profile.publicId,
                disbursedAt: "2026-08-17T00:00:00.000Z",
            },
        );
        const preview = await fixture.preview();
        const functionName = `test_pause_replacement_post_${fixture.replacementDraft.id}`;
        const triggerName = `test_pause_replacement_post_trigger_${fixture.replacementDraft.id}`;
        const advisoryKey = 8_171_000_000 + fixture.replacementDraft.id;
        const databaseUrl = process.env.TEST_DATABASE_URL!;
        const blocker = postgres(databaseUrl, { max: 1 });
        const observer = postgres(databaseUrl, { max: 1 });
        let releaseBlocker!: () => void;
        let confirmLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const locked = new Promise<void>((resolve) => { confirmLocked = resolve; });
        const blockerTransaction = blocker.begin(async (connection) => {
            await connection`SELECT pg_advisory_xact_lock(${advisoryKey})`;
            confirmLocked();
            await release;
        });

        await db.execute(sql.raw(`
            CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              PERFORM pg_advisory_xact_lock(${advisoryKey});
              RETURN NEW;
            END; $$;
            CREATE TRIGGER ${triggerName}
              BEFORE INSERT ON loan_schedules
              FOR EACH ROW
              WHEN (NEW.loan_id = ${fixture.replacementDraft.id})
              EXECUTE FUNCTION ${functionName}();
        `));

        try {
            await locked;
            const executePromise = fixture.execute(preview, "race-execute-vs-post");
            await waitForPostgresLockWaiters(observer, 1);
            const postPromise = postDisbursement(
                fixture.context("race-post-vs-execute"),
                draft.publicId,
            );
            await waitForPostgresLockWaiters(observer, 2);
            releaseBlocker();

            const results = await Promise.allSettled([executePromise, postPromise]);
            expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
            const [oldLoan, event] = await Promise.all([
                db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) }),
                db.query.loanDisbursementEvents.findFirst({ where: eq(
                    loanDisbursementEvents.publicId,
                    draft.publicId,
                ) }),
            ]);
            if (oldLoan?.status === "replaced") expect(event?.status).toBe("draft");
            else expect(event?.status).toBe("posted");
        } finally {
            releaseBlocker();
            await blockerTransaction.catch(() => undefined);
            await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON loan_schedules`));
            await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
            await Promise.all([blocker.end(), observer.end()]);
        }
    }, 15_000);

    // Break caught: waiver execution re-reads a locked loan but does not reject the replacement
    // terminal state before appending an effective financial waiver.
    integrationTest("rejects waiver execution after the loan is replaced", async () => {
        const fixture = await seedReplacementFixture();
        const waiverPreview = await prepareOldLoanWaiver(fixture);
        const replacementPreview = await fixture.preview();
        await fixture.execute(replacementPreview);

        await expect(executeLoanWaiver(
            fixture.context("waiver-after-replacement"),
            waiverPreview.publicId,
            {
                confirmed: true,
                previewHash: waiverPreview.previewHash,
                expectedBalanceVersion: waiverPreview.balanceVersion,
                reason: "Approved assistance",
            },
        )).rejects.toMatchObject({ code: "LOAN_WAIVER_LOCKED", status: 409 });
        expect(await db.select().from(loanRestructureWaivers).where(and(
            eq(loanRestructureWaivers.tenantId, fixture.tenantId),
            eq(loanRestructureWaivers.loanId, fixture.oldLoan.id),
        ))).toHaveLength(0);
    });

    // Break caught: a funding writer and replacement can both commit across the old-loan terminal transition.
    integrationTest("serializes replacement execution against old-loan funding allocation", async () => {
        const fixture = await seedReplacementFixture({ sourceCapacity: "100000.00" });
        const preview = await fixture.preview();
        const results = await Promise.allSettled([
            fixture.execute(preview, "execute-vs-funding"),
            createFundingAllocation(fixture.context("fund-vs-replacement"), {
                loanPublicId: fixture.oldLoan.publicId,
                bankLoanPublicId: fixture.source.drawdown!.publicId,
                allocatedAmount: "1.00",
                allocationDate: "2026-08-17",
                allocationType: "manual_adjustment",
            }),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const oldLoan = await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) });
        const allocations = await db.select().from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, fixture.tenantId),
            eq(loanFundingAllocations.loanId, fixture.oldLoan.id),
        ));
        expect(oldLoan?.status === "replaced" ? allocations : []).toHaveLength(1);
    });

    // Break caught: collection creation reads the active loan before its transaction, so a
    // replacement can cross the terminal-state boundary while the collection insert is paused.
    integrationTest("serializes replacement execution against intermediary collection creation", async () => {
        const fixture = await seedReplacementFixture();
        const intermediary = await seedIntermediary(fixture);
        const preview = await fixture.preview();
        const functionName = `test_pause_collection_${fixture.oldLoan.id}`;
        const triggerName = `test_pause_collection_trigger_${fixture.oldLoan.id}`;
        const advisoryKey = 8_170_000_000 + fixture.oldLoan.id;
        const databaseUrl = process.env.TEST_DATABASE_URL!;
        const blocker = postgres(databaseUrl, { max: 1 });
        const observer = postgres(databaseUrl, { max: 1 });
        let releaseBlocker!: () => void;
        let confirmLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const locked = new Promise<void>((resolve) => { confirmLocked = resolve; });
        const blockerTransaction = blocker.begin(async (connection) => {
            await connection`SELECT pg_advisory_xact_lock(${advisoryKey})`;
            confirmLocked();
            await release;
        });

        await db.execute(sql.raw(`
            CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              PERFORM pg_advisory_xact_lock(${advisoryKey});
              RETURN NEW;
            END; $$;
            CREATE TRIGGER ${triggerName}
              BEFORE INSERT ON intermediary_collections
              FOR EACH ROW
              WHEN (NEW.loan_id = ${fixture.oldLoan.id})
              EXECUTE FUNCTION ${functionName}();
        `));

        try {
            await locked;
            const collectionPromise = createIntermediaryCollection(
                fixture.context("collection-vs-replacement"),
                {
                    intermediaryPublicId: intermediary.publicId,
                    borrowerPublicId: fixture.borrower.publicId,
                    loanPublicId: fixture.oldLoan.publicId,
                    amount: "1.00",
                    borrowerPaidAt: "2026-08-17T00:00:00.000Z",
                },
            );
            await waitForPostgresLockWaiters(observer, 1);

            let executeSettled = false;
            const executePromise = fixture.execute(preview, "execute-vs-collection");
            void executePromise.then(
                () => { executeSettled = true; },
                () => { executeSettled = true; },
            );
            let serialized = false;
            for (let attempt = 0; attempt < 500; attempt += 1) {
                const rows = await observer<{ count: number }[]>`
                    SELECT count(DISTINCT pid)::int AS count
                    FROM pg_stat_activity
                    WHERE datname = current_database()
                      AND pid <> pg_backend_pid()
                      AND wait_event_type = 'Lock'
                `;
                if ((rows[0]?.count ?? 0) >= 2) {
                    serialized = true;
                    break;
                }
                if (executeSettled) break;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (!serialized && !executeSettled) {
                throw new Error("Timed out observing replacement/collection serialization");
            }
            releaseBlocker();

            const results = await Promise.allSettled([executePromise, collectionPromise]);
            expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
            const oldLoan = await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) });
            const collections = await db.select().from(intermediaryCollections).where(and(
                eq(intermediaryCollections.tenantId, fixture.tenantId),
                eq(intermediaryCollections.loanId, fixture.oldLoan.id),
            ));
            if (oldLoan?.status === "replaced") expect(collections).toHaveLength(0);
            else expect(collections).toHaveLength(1);
        } finally {
            releaseBlocker();
            await blockerTransaction.catch(() => undefined);
            await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON intermediary_collections`));
            await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
            await Promise.all([blocker.end(), observer.end()]);
        }
    }, 15_000);

    // Break caught: a borrower collection can be attached after replacement has made the loan terminal.
    integrationTest("rejects intermediary collection creation for a replaced loan", async () => {
        const fixture = await seedReplacementFixture();
        const intermediary = await seedIntermediary(fixture);
        const preview = await fixture.preview();
        await fixture.execute(preview);

        await expect(createIntermediaryCollection(
            fixture.context("collection-after-replacement"),
            {
                intermediaryPublicId: intermediary.publicId,
                borrowerPublicId: fixture.borrower.publicId,
                loanPublicId: fixture.oldLoan.publicId,
                amount: "1.00",
                borrowerPaidAt: "2026-08-17T00:00:00.000Z",
            },
        )).rejects.toMatchObject({ code: "LOAN_COLLECTION_LOCKED", status: 409 });
        expect(await db.select().from(intermediaryCollections).where(eq(
            intermediaryCollections.loanId,
            fixture.oldLoan.id,
        ))).toHaveLength(0);
    });

    // Break caught: a new intermediary assignment can be appended to a replaced contract.
    integrationTest("rejects intermediary assignment creation for a replaced loan", async () => {
        const fixture = await seedReplacementFixture();
        const intermediary = await seedIntermediary(fixture);
        const preview = await fixture.preview();
        await fixture.execute(preview);

        await expect(assignIntermediaryToLoan(
            fixture.context("assignment-after-replacement"),
            fixture.oldLoan.publicId,
            {
                intermediaryPublicId: intermediary.publicId,
                role: "collection",
                effectiveFrom: "2026-08-17T00:00:00.000Z",
            },
        )).rejects.toMatchObject({ code: "LOAN_INTERMEDIARY_ASSIGNMENT_LOCKED", status: 409 });
        expect(await db.select().from(loanIntermediaryAssignments).where(eq(
            loanIntermediaryAssignments.loanId,
            fixture.oldLoan.id,
        ))).toHaveLength(0);
    });

    // Break caught: a new commission agreement can be appended to a replaced contract.
    integrationTest("rejects commission participant creation for a replaced loan", async () => {
        const fixture = await seedReplacementFixture();
        const intermediary = await seedIntermediary(fixture);
        const preview = await fixture.preview();
        await fixture.execute(preview);

        await expect(addLoanCommissionParticipant(
            fixture.context("commission-after-replacement"),
            {
                loanPublicId: fixture.oldLoan.publicId,
                intermediaryPublicId: intermediary.publicId,
                commissionRate: "1.00",
                role: "collector",
                effectiveFrom: "2026-08-17T00:00:00.000Z",
            },
        )).rejects.toMatchObject({ code: "LOAN_COMMISSION_LOCKED", status: 409 });
        expect(await db.select().from(loanCommissionParticipants).where(eq(
            loanCommissionParticipants.loanId,
            fixture.oldLoan.id,
        ))).toHaveLength(0);
    });

    // Break caught: reversal marks the replacement child cancelled, but downstream writers that
    // only recognize `replaced` can append new financial/workflow records after that terminal state.
    integrationTest("rejects downstream writers for the cancelled replacement loan after reversal", async () => {
        const fixture = await seedReplacementFixture();
        const intermediary = await seedIntermediary(fixture);
        const preview = await fixture.preview();
        const executed = await fixture.execute(preview);
        await fixture.reverse(executed.replacementPublicId);

        await expect(createIntermediaryCollection(
            fixture.context("collection-after-reversal"),
            {
                intermediaryPublicId: intermediary.publicId,
                borrowerPublicId: fixture.borrower.publicId,
                loanPublicId: fixture.replacementDraft.publicId,
                amount: "1.00",
                borrowerPaidAt: "2026-08-17T00:00:00.000Z",
            },
        )).rejects.toMatchObject({ code: "LOAN_COLLECTION_LOCKED", status: 409 });
        await expect(assignIntermediaryToLoan(
            fixture.context("assignment-after-reversal"),
            fixture.replacementDraft.publicId,
            {
                intermediaryPublicId: intermediary.publicId,
                role: "collection",
                effectiveFrom: "2026-08-17T00:00:00.000Z",
            },
        )).rejects.toMatchObject({ code: "LOAN_INTERMEDIARY_ASSIGNMENT_LOCKED", status: 409 });
        await expect(addLoanCommissionParticipant(
            fixture.context("commission-after-reversal"),
            {
                loanPublicId: fixture.replacementDraft.publicId,
                intermediaryPublicId: intermediary.publicId,
                commissionRate: "1.00",
                role: "collector",
                effectiveFrom: "2026-08-17T00:00:00.000Z",
            },
        )).rejects.toMatchObject({ code: "LOAN_COMMISSION_LOCKED", status: 409 });
    });

    for (const blocker of downstreamBlockers) {
        // Break caught: a downstream record created after preview is ignored during locked execution revalidation.
        integrationTest(`blocks execution after ${blocker.name}`, async () => {
            const fixture = await seedReplacementFixture();
            const preview = await fixture.preview();
            const blockerPublicId = await blocker.seed(fixture, fixture.oldLoan);

            await expect(fixture.execute(preview)).rejects.toMatchObject({
                code: blocker.executeCode,
                details: {
                    reviewRequired: true,
                    blockerPublicIds: expect.arrayContaining([blockerPublicId]),
                },
            });
            await expectUnchangedPreviewState(fixture);
        });

        // Break caught: reversal restores an old contract despite a dependent record on the replacement contract.
        integrationTest(`blocks reversal after ${blocker.name}`, async () => {
            const fixture = await seedReplacementFixture();
            const preview = await fixture.preview();
            const executed = await fixture.execute(preview);
            const blockerPublicId = await blocker.seed(fixture, fixture.replacementDraft);
            const countsBefore = await fixture.counts();

            await expect(fixture.reverse(executed.replacementPublicId)).rejects.toMatchObject({
                code: "REPLACEMENT_REVERSAL_DOWNSTREAM_ACTIVITY",
                details: {
                    reviewRequired: true,
                    blockerPublicIds: expect.arrayContaining([blockerPublicId]),
                },
            });
            expect(await fixture.counts()).toEqual(countsBefore);
            expect(await db.query.loanReplacements.findFirst({
                where: eq(loanReplacements.publicId, executed.replacementPublicId),
            })).toMatchObject({ status: "executed", reversalIdempotencyKey: null });
            expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) }))
                .toMatchObject({ status: "replaced", outstandingPrincipal: "0.00" });
            expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) }))
                .toMatchObject({ status: "active", outstandingPrincipal: "36000.00" });
        });
    }

    // Break caught: replacement locks loan→collection while a valid collection workflow locks
    // collection→loan, producing PostgreSQL 40P01 instead of a stable review-required blocker.
    integrationTest("returns a stable blocker instead of deadlocking with a child-first writer", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const collectionPublicId = await seedIntermediaryCollection(fixture, fixture.oldLoan);
        const databaseUrl = process.env.TEST_DATABASE_URL!;
        const childWriter = postgres(databaseUrl, { max: 1 });
        let confirmChildLocked!: () => void;
        const childLocked = new Promise<void>((resolve) => { confirmChildLocked = resolve; });
        const childWriterTransaction = childWriter.begin(async (connection) => {
            await connection`SELECT id FROM intermediary_collections
                WHERE tenant_id = ${fixture.tenantId} AND public_id = ${collectionPublicId}
                FOR UPDATE`;
            confirmChildLocked();
            await new Promise((resolve) => setTimeout(resolve, 100));
            await connection`SELECT id FROM loans
                WHERE tenant_id = ${fixture.tenantId} AND id = ${fixture.oldLoan.id}
                FOR UPDATE`;
        });

        try {
            await childLocked;
            const [executionResult, childWriterResult] = await Promise.allSettled([
                fixture.execute(preview, "child-first-deadlock-execution"),
                childWriterTransaction,
            ]);
            expect(childWriterResult.status).toBe("fulfilled");
            expect(executionResult.status).toBe("rejected");
            expect(rejectedReason(executionResult)).toMatchObject({
                code: "REPLACEMENT_DOWNSTREAM_ACTIVITY",
                details: {
                    reviewRequired: true,
                    blockerPublicIds: [collectionPublicId],
                },
            });
        } finally {
            await childWriterTransaction.catch(() => undefined);
            await childWriter.end();
        }
    }, 15_000);

    // Break caught: A→B can be reversed after B→C executes because replacement lineage is
    // absent from B's effective downstream graph, leaving C active beside restored A.
    integrationTest("blocks ancestor reversal after the replacement loan is replaced again", async () => {
        const fixture = await seedReplacementFixture({ sourceCapacity: "144000.00" });
        const firstPreview = await fixture.preview();
        const firstExecution = await fixture.execute(firstPreview, "first-chain-execution");
        const chained = await executeChainedReplacement(fixture);

        await expect(fixture.reverse(
            firstExecution.replacementPublicId,
            "ancestor-chain-reversal",
        )).rejects.toMatchObject({
            code: "REPLACEMENT_REVERSAL_LIFECYCLE_CHANGED",
            details: {
                reviewRequired: true,
                blockerPublicIds: [fixture.replacementDraft.publicId],
            },
        });
        expect(await db.query.loanReplacements.findFirst({ where: eq(
            loanReplacements.publicId,
            firstExecution.replacementPublicId,
        ) })).toMatchObject({ status: "executed", reversalIdempotencyKey: null });
        expect(await db.query.loanReplacements.findFirst({ where: eq(
            loanReplacements.publicId,
            chained.execution.replacementPublicId,
        ) })).toMatchObject({ status: "executed" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) }))
            .toMatchObject({ status: "replaced" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) }))
            .toMatchObject({ status: "replaced" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, chained.draft.id) }))
            .toMatchObject({ status: "active" });
    });

    // Break caught: ancestor reversal and a chained replacement execution can both pass their
    // pre-lock reads and commit because the reversal does not revalidate replacement lineage.
    integrationTest("serializes ancestor reversal against chained replacement execution", async () => {
        const fixture = await seedReplacementFixture({ sourceCapacity: "144000.00" });
        const firstPreview = await fixture.preview();
        const firstExecution = await fixture.execute(firstPreview, "first-race-chain-execution");
        const chained = await prepareChainedReplacement(fixture);
        const functionName = `test_pause_chained_replacement_${chained.draft.id}`;
        const triggerName = `test_pause_chained_replacement_trigger_${chained.draft.id}`;
        const advisoryKey = 8_172_000_000 + chained.draft.id;
        const databaseUrl = process.env.TEST_DATABASE_URL!;
        const blocker = postgres(databaseUrl, { max: 1 });
        const observer = postgres(databaseUrl, { max: 1 });
        let releaseBlocker!: () => void;
        let confirmLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const locked = new Promise<void>((resolve) => { confirmLocked = resolve; });
        const blockerTransaction = blocker.begin(async (connection) => {
            await connection`SELECT pg_advisory_xact_lock(${advisoryKey})`;
            confirmLocked();
            await release;
        });

        await db.execute(sql.raw(`
            CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              PERFORM pg_advisory_xact_lock(${advisoryKey});
              RETURN NEW;
            END; $$;
            CREATE TRIGGER ${triggerName}
              BEFORE INSERT ON loan_schedules
              FOR EACH ROW
              WHEN (NEW.loan_id = ${chained.draft.id})
              EXECUTE FUNCTION ${functionName}();
        `));

        try {
            await locked;
            const chainedExecutionPromise = executeLoanReplacement(
                fixture.context("race-chained-execution"),
                {
                    replacementPublicId: chained.preview.publicId,
                    previewHash: chained.preview.previewHash,
                    expectedOldBalanceVersion: chained.preview.oldBalanceVersion,
                    expectedReplacementDraftVersion: chained.preview.replacementDraftVersion,
                    reason: chained.reason,
                    confirmed: true,
                },
            );
            await waitForPostgresLockWaiters(observer, 1);
            const reversalPromise = fixture.reverse(
                firstExecution.replacementPublicId,
                "race-ancestor-reversal",
            );
            await waitForPostgresLockWaiters(observer, 2);
            releaseBlocker();

            const [chainResult, reversalResult] = await Promise.allSettled([
                chainedExecutionPromise,
                reversalPromise,
            ]);
            expect(chainResult.status).toBe("fulfilled");
            expect(reversalResult.status).toBe("rejected");
            expect(rejectedReason(reversalResult)).toMatchObject({
                code: "REPLACEMENT_REVERSAL_LIFECYCLE_CHANGED",
                details: {
                    reviewRequired: true,
                    blockerPublicIds: [fixture.replacementDraft.publicId],
                },
            });
            expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) }))
                .toMatchObject({ status: "replaced" });
            expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) }))
                .toMatchObject({ status: "replaced" });
            expect(await db.query.loans.findFirst({ where: eq(loans.id, chained.draft.id) }))
                .toMatchObject({ status: "active" });
        } finally {
            releaseBlocker();
            await blockerTransaction.catch(() => undefined);
            await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON loan_schedules`));
            await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
            await Promise.all([blocker.end(), observer.end()]);
        }
    }, 15_000);

    // Break caught: a safe reversal edits or deletes financial history instead of appending exact compensation and restoring the snapshot.
    integrationTest("reverses a dependency-free replacement with exact compensating rows", async () => {
        const fixture = await seedReplacementFixture();
        const oldSchedulesBefore = await db.select({
            publicId: loanSchedules.publicId,
            installmentNo: loanSchedules.installmentNo,
            status: loanSchedules.status,
            remainingDue: loanSchedules.remainingDue,
            paidTotal: loanSchedules.paidTotal,
            paidPenalty: loanSchedules.paidPenalty,
        }).from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, fixture.tenantId),
            eq(loanSchedules.loanId, fixture.oldLoan.id),
        )).orderBy(asc(loanSchedules.installmentNo));
        const preview = await fixture.preview();
        const executed = await fixture.execute(preview);

        const reversed = await fixture.reverse(executed.replacementPublicId, "safe-reversal");
        const replay = await fixture.reverse(executed.replacementPublicId, "safe-reversal");
        expect(replay).toEqual(reversed);
        expect(await fixture.counts()).toEqual({
            replacementRows: 1,
            oldSchedules: 2,
            replacementSchedules: 200,
            oldAllocations: 1,
            replacementAllocations: 2,
            corrections: 2,
            executionAudits: 1,
            reversalAudits: 1,
            payments: 0,
            disbursements: 0,
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) })).toMatchObject({
            status: "active",
            outstandingPrincipal: "36000.00",
            outstandingInterest: "4200.00",
            outstandingFees: "0.00",
            nextDueDate: "2026-07-13",
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) })).toMatchObject({
            status: "cancelled",
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            nextDueDate: null,
        });
        expect(await db.select({
            publicId: loanSchedules.publicId,
            installmentNo: loanSchedules.installmentNo,
            status: loanSchedules.status,
            remainingDue: loanSchedules.remainingDue,
            paidTotal: loanSchedules.paidTotal,
            paidPenalty: loanSchedules.paidPenalty,
        }).from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, fixture.tenantId),
            eq(loanSchedules.loanId, fixture.oldLoan.id),
        )).orderBy(asc(loanSchedules.installmentNo))).toEqual(oldSchedulesBefore);
        expect(await db.select().from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, fixture.tenantId),
            eq(loanSchedules.loanId, fixture.replacementDraft.id),
        ))).toHaveLength(200);
        expect((await db.select().from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, fixture.tenantId),
            eq(loanSchedules.loanId, fixture.replacementDraft.id),
        ))).every((row) => row.status === "cancelled" && row.remainingDue === "0.00")).toBe(true);
        expect(await db.select({
            status: loanReplacementCorrections.status,
            principal: loanReplacementCorrections.principal,
            interest: loanReplacementCorrections.interest,
            fee: loanReplacementCorrections.fee,
            penalty: loanReplacementCorrections.penalty,
            reversedCorrectionId: loanReplacementCorrections.reversedCorrectionId,
        }).from(loanReplacementCorrections).where(eq(
            loanReplacementCorrections.tenantId,
            fixture.tenantId,
        )).orderBy(asc(loanReplacementCorrections.id))).toEqual([
            {
                status: "posted",
                principal: "36000.00",
                interest: "4200.00",
                fee: "0.00",
                penalty: "0.00",
                reversedCorrectionId: null,
            },
            {
                status: "reversed",
                principal: "-36000.00",
                interest: "-4200.00",
                fee: "0.00",
                penalty: "0.00",
                reversedCorrectionId: expect.any(Number),
            },
        ]);
        expect(await db.select({
            allocatedAmount: loanFundingAllocations.allocatedAmount,
            allocationType: loanFundingAllocations.allocationType,
            reversedAllocationId: loanFundingAllocations.reversedAllocationId,
        }).from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, fixture.tenantId),
            eq(loanFundingAllocations.loanId, fixture.replacementDraft.id),
        )).orderBy(asc(loanFundingAllocations.id))).toEqual([
            { allocatedAmount: "36000.00", allocationType: "initial", reversedAllocationId: null },
            {
                allocatedAmount: "-36000.00",
                allocationType: "reallocation_out",
                reversedAllocationId: expect.any(Number),
            },
        ]);
    });

    // Break caught: the reversal audit records only lifecycle labels and omits the exact public
    // financial state, restored/cancelled schedules, funding compensation, and correction IDs.
    integrationTest("audits the complete reversal with safe public before and after state", async () => {
        const fixture = await seedReplacementFixture({
            replacementDraft: {
                termMonths: 1,
                totalInstallments: 2,
                installmentAmount: "18000.00",
            },
        });
        const executionReason = "Correct the contract start date";
        const preview = await fixture.preview(executionReason);
        const executed = await fixture.execute(preview, "full-reversal-audit-execute", executionReason);
        const persisted = await db.query.loanReplacements.findFirst({ where: and(
            eq(loanReplacements.tenantId, fixture.tenantId),
            eq(loanReplacements.publicId, executed.replacementPublicId),
        ) });
        expect(persisted).toBeDefined();
        const [oldSchedulesBefore, replacementSchedulesBefore, correctionsBefore, fundingBefore] = await Promise.all([
            db.select().from(loanSchedules).where(and(
                eq(loanSchedules.tenantId, fixture.tenantId),
                eq(loanSchedules.loanId, fixture.oldLoan.id),
            )).orderBy(asc(loanSchedules.installmentNo)),
            db.select().from(loanSchedules).where(and(
                eq(loanSchedules.tenantId, fixture.tenantId),
                eq(loanSchedules.loanId, fixture.replacementDraft.id),
            )).orderBy(asc(loanSchedules.installmentNo)),
            db.select().from(loanReplacementCorrections).where(and(
                eq(loanReplacementCorrections.tenantId, fixture.tenantId),
                eq(loanReplacementCorrections.replacementId, persisted!.id),
            )).orderBy(asc(loanReplacementCorrections.id)),
            db.select().from(loanFundingAllocations).where(and(
                eq(loanFundingAllocations.tenantId, fixture.tenantId),
                eq(loanFundingAllocations.loanId, fixture.replacementDraft.id),
            )).orderBy(asc(loanFundingAllocations.id)),
        ]);
        expect(oldSchedulesBefore).toHaveLength(2);
        expect(replacementSchedulesBefore).toHaveLength(2);
        expect(correctionsBefore).toHaveLength(1);
        expect(fundingBefore).toHaveLength(1);

        const reversalKey = "full-reversal-audit-reverse";
        const reversalReason = "Restore the original contract after review";
        const reversed = await fixture.reverse(executed.replacementPublicId, reversalKey, reversalReason);
        const [reversedAggregate, reversalAudit, oldSchedulesAfter, replacementSchedulesAfter, correctionsAfter, fundingAfter] = await Promise.all([
            db.query.loanReplacements.findFirst({ where: and(
                eq(loanReplacements.tenantId, fixture.tenantId),
                eq(loanReplacements.publicId, executed.replacementPublicId),
            ) }),
            db.query.auditLogs.findFirst({ where: and(
                eq(auditLogs.tenantId, fixture.tenantId),
                eq(auditLogs.publicId, reversed.auditPublicId),
            ) }),
            db.select().from(loanSchedules).where(and(
                eq(loanSchedules.tenantId, fixture.tenantId),
                eq(loanSchedules.loanId, fixture.oldLoan.id),
            )).orderBy(asc(loanSchedules.installmentNo)),
            db.select().from(loanSchedules).where(and(
                eq(loanSchedules.tenantId, fixture.tenantId),
                eq(loanSchedules.loanId, fixture.replacementDraft.id),
            )).orderBy(asc(loanSchedules.installmentNo)),
            db.select().from(loanReplacementCorrections).where(and(
                eq(loanReplacementCorrections.tenantId, fixture.tenantId),
                eq(loanReplacementCorrections.replacementId, persisted!.id),
            )).orderBy(asc(loanReplacementCorrections.id)),
            db.select().from(loanFundingAllocations).where(and(
                eq(loanFundingAllocations.tenantId, fixture.tenantId),
                eq(loanFundingAllocations.loanId, fixture.replacementDraft.id),
            )).orderBy(asc(loanFundingAllocations.id)),
        ]);
        expect(reversalAudit).toBeDefined();
        expect(reversedAggregate?.reversalRequestHash).toMatch(/^[0-9a-f]{64}$/);
        expect(correctionsAfter).toHaveLength(2);
        expect(fundingAfter).toHaveLength(2);

        expect(reversalAudit?.payload).toEqual({
            proposal: persisted!.previewSnapshot,
            reason: reversalReason,
            requestHash: reversedAggregate!.reversalRequestHash,
            idempotencyKey: reversalKey,
            before: {
                oldLoan: {
                    loanPublicId: fixture.oldLoan.publicId,
                    status: "replaced",
                    collectible: {
                        principal: "0.00",
                        interest: "0.00",
                        fee: "0.00",
                        penalty: "0.00",
                        nextDueDate: null,
                    },
                },
                replacementLoan: {
                    loanPublicId: fixture.replacementDraft.publicId,
                    status: "active",
                    collectible: {
                        principal: "36000.00",
                        interest: "0.00",
                        fee: "0.00",
                        penalty: "0.00",
                        nextDueDate: "2026-07-12",
                    },
                },
                oldLoanSchedules: [
                    {
                        schedulePublicId: oldSchedulesBefore[0]!.publicId,
                        installmentNo: 1,
                        dueDate: "2026-07-13",
                        scheduledPrincipal: "180.00",
                        scheduledInterest: "21.00",
                        scheduledFee: "0.00",
                        scheduledTotal: "201.00",
                        paidTotal: "0.00",
                        paidPenalty: "0.00",
                        remainingDue: "0.00",
                        status: "cancelled",
                    },
                    {
                        schedulePublicId: oldSchedulesBefore[1]!.publicId,
                        installmentNo: 2,
                        dueDate: "2026-07-14",
                        scheduledPrincipal: "180.00",
                        scheduledInterest: "21.00",
                        scheduledFee: "0.00",
                        scheduledTotal: "201.00",
                        paidTotal: "0.00",
                        paidPenalty: "0.00",
                        remainingDue: "0.00",
                        status: "cancelled",
                    },
                ],
                replacementLoanSchedules: [
                    {
                        schedulePublicId: replacementSchedulesBefore[0]!.publicId,
                        installmentNo: 1,
                        dueDate: "2026-07-12",
                        scheduledPrincipal: "18000.00",
                        scheduledInterest: "0.00",
                        scheduledFee: "0.00",
                        scheduledTotal: "18000.00",
                        paidTotal: "0.00",
                        paidPenalty: "0.00",
                        remainingDue: "18000.00",
                        status: "pending",
                    },
                    {
                        schedulePublicId: replacementSchedulesBefore[1]!.publicId,
                        installmentNo: 2,
                        dueDate: "2026-07-13",
                        scheduledPrincipal: "18000.00",
                        scheduledInterest: "0.00",
                        scheduledFee: "0.00",
                        scheduledTotal: "18000.00",
                        paidTotal: "0.00",
                        paidPenalty: "0.00",
                        remainingDue: "18000.00",
                        status: "pending",
                    },
                ],
                replacementFunding: [{
                    allocationPublicId: fundingBefore[0]!.publicId,
                    fundingSourceKind: "drawdown",
                    fundingSourcePublicId: fixture.source.drawdown!.publicId,
                    allocatedAmount: "36000.00",
                    allocationDate: "2026-07-11",
                    allocationType: "initial",
                    reversedAllocationPublicId: null,
                }],
                corrections: [{
                    correctionPublicId: correctionsBefore[0]!.publicId,
                    status: "posted",
                    principal: "36000.00",
                    interest: "4200.00",
                    fee: "0.00",
                    penalty: "0.00",
                    reason: executionReason,
                    reversedCorrectionPublicId: null,
                }],
            },
            after: {
                oldLoan: {
                    loanPublicId: fixture.oldLoan.publicId,
                    status: "active",
                    collectible: {
                        principal: "36000.00",
                        interest: "4200.00",
                        fee: "0.00",
                        penalty: "0.00",
                        nextDueDate: "2026-07-13",
                    },
                },
                replacementLoan: {
                    loanPublicId: fixture.replacementDraft.publicId,
                    status: "cancelled",
                    collectible: {
                        principal: "0.00",
                        interest: "0.00",
                        fee: "0.00",
                        penalty: "0.00",
                        nextDueDate: null,
                    },
                },
                oldLoanSchedules: [
                    {
                        schedulePublicId: oldSchedulesAfter[0]!.publicId,
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
                        schedulePublicId: oldSchedulesAfter[1]!.publicId,
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
                ],
                replacementLoanSchedules: [
                    {
                        schedulePublicId: replacementSchedulesAfter[0]!.publicId,
                        installmentNo: 1,
                        dueDate: "2026-07-12",
                        scheduledPrincipal: "18000.00",
                        scheduledInterest: "0.00",
                        scheduledFee: "0.00",
                        scheduledTotal: "18000.00",
                        paidTotal: "0.00",
                        paidPenalty: "0.00",
                        remainingDue: "0.00",
                        status: "cancelled",
                    },
                    {
                        schedulePublicId: replacementSchedulesAfter[1]!.publicId,
                        installmentNo: 2,
                        dueDate: "2026-07-13",
                        scheduledPrincipal: "18000.00",
                        scheduledInterest: "0.00",
                        scheduledFee: "0.00",
                        scheduledTotal: "18000.00",
                        paidTotal: "0.00",
                        paidPenalty: "0.00",
                        remainingDue: "0.00",
                        status: "cancelled",
                    },
                ],
                replacementFunding: [
                    {
                        allocationPublicId: fundingAfter[0]!.publicId,
                        fundingSourceKind: "drawdown",
                        fundingSourcePublicId: fixture.source.drawdown!.publicId,
                        allocatedAmount: "36000.00",
                        allocationDate: "2026-07-11",
                        allocationType: "initial",
                        reversedAllocationPublicId: null,
                    },
                    {
                        allocationPublicId: fundingAfter[1]!.publicId,
                        fundingSourceKind: "drawdown",
                        fundingSourcePublicId: fixture.source.drawdown!.publicId,
                        allocatedAmount: "-36000.00",
                        allocationDate: "2026-07-11",
                        allocationType: "reallocation_out",
                        reversedAllocationPublicId: fundingAfter[0]!.publicId,
                    },
                ],
                corrections: [
                    {
                        correctionPublicId: correctionsAfter[0]!.publicId,
                        status: "posted",
                        principal: "36000.00",
                        interest: "4200.00",
                        fee: "0.00",
                        penalty: "0.00",
                        reason: executionReason,
                        reversedCorrectionPublicId: null,
                    },
                    {
                        correctionPublicId: correctionsAfter[1]!.publicId,
                        status: "reversed",
                        principal: "-36000.00",
                        interest: "-4200.00",
                        fee: "0.00",
                        penalty: "0.00",
                        reason: reversalReason,
                        reversedCorrectionPublicId: correctionsAfter[0]!.publicId,
                    },
                ],
            },
            compensation: {
                correctionPublicIds: [correctionsAfter[1]!.publicId],
                fundingAllocationPublicIds: [fundingAfter[1]!.publicId],
            },
        });
        expect(JSON.stringify(reversalAudit?.payload)).not.toMatch(
            /"(?:id|loanId|scheduleId|bankProfileId|bankLoanId|replacementId|reversedCorrectionId|reversedAllocationId)":/,
        );
    });

    // Break caught: compensated payment and disbursement history is mistaken for effective downstream activity.
    integrationTest("allows reversal after payment and disbursement records are fully compensated", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const executed = await fixture.execute(preview);
        const payment = await db.insert(transactions).values({
            tenantId: fixture.tenantId,
            ownerUserId: fixture.actor.id,
            loanId: fixture.replacementDraft.id,
            amount: "1.00",
            principalComponent: "1.00",
            entryType: "repayment",
            idempotencyKey: nextDownstreamKey("compensated-payment"),
        }).returning().then((rows) => rows[0]!);
        await db.insert(transactions).values({
            tenantId: fixture.tenantId,
            ownerUserId: fixture.actor.id,
            loanId: fixture.replacementDraft.id,
            amount: "-1.00",
            principalComponent: "-1.00",
            entryType: "reversal",
            reversedTransactionId: payment.id,
            idempotencyKey: nextDownstreamKey("payment-reversal"),
        });
        const disbursement = await db.insert(loanDisbursementEvents).values({
            tenantId: fixture.tenantId,
            loanId: fixture.replacementDraft.id,
            grossAmount: "1.00",
            loanAttributedAmount: "1.00",
            channel: "bank_transfer",
            status: "posted",
            postedAt: new Date("2026-08-17T00:00:00.000Z"),
            postIdempotencyKey: nextDownstreamKey("compensated-disbursement"),
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanDisbursementEvents).values({
            tenantId: fixture.tenantId,
            loanId: fixture.replacementDraft.id,
            grossAmount: "1.00",
            loanAttributedAmount: "1.00",
            channel: "adjustment",
            status: "reversed",
            reversedEventId: disbursement.id,
            reversedAt: new Date("2026-08-17T00:00:01.000Z"),
            reversalIdempotencyKey: nextDownstreamKey("disbursement-reversal"),
            reversalRequestHash: "3".repeat(64),
        });

        await expect(fixture.reverse(executed.replacementPublicId, "compensated-history"))
            .resolves.toMatchObject({ status: "reversed" });
    });

    // Break caught: reversal compensates only the activation's initial allocation and leaves a
    // later -A/+B source reallocation attached to the cancelled replacement loan.
    integrationTest("blocks reversal after replacement-loan funding is reallocated", async () => {
        const fixture = await seedReplacementFixture({ sourceCapacity: "100000.00" });
        const preview = await fixture.preview();
        const executed = await fixture.execute(preview);
        const targetProfile = await db.insert(bankProfiles).values({
            tenantId: fixture.tenantId,
            name: "Replacement Reallocation Target",
            type: "bank",
            status: "active",
            accountingMode: "external_liability",
        }).returning().then((rows) => rows[0]!);
        const targetDrawdown = await db.insert(bankLoans).values({
            tenantId: fixture.tenantId,
            bankProfileId: targetProfile.id,
            amount: "10000.00",
            interestRate: "0.00",
            termMonths: 12,
            status: "active",
            startDate: "2026-08-17",
        }).returning().then((rows) => rows[0]!);
        const allocationGroupId = crypto.randomUUID();
        const reallocations = await db.insert(loanFundingAllocations).values([
            {
                tenantId: fixture.tenantId,
                bankProfileId: fixture.source.profile.id,
                bankLoanId: fixture.source.drawdown!.id,
                loanId: fixture.replacementDraft.id,
                allocatedAmount: "-1000.00",
                allocationDate: "2026-08-17",
                allocationType: "reallocation_out",
                allocationGroupId,
                createdByUserId: fixture.actor.id,
            },
            {
                tenantId: fixture.tenantId,
                bankProfileId: targetProfile.id,
                bankLoanId: targetDrawdown.id,
                loanId: fixture.replacementDraft.id,
                allocatedAmount: "1000.00",
                allocationDate: "2026-08-17",
                allocationType: "reallocation_in",
                allocationGroupId,
                createdByUserId: fixture.actor.id,
            },
        ]).returning();

        await expect(fixture.reverse(
            executed.replacementPublicId,
            "funding-reallocation-reversal",
        )).rejects.toMatchObject({
            code: "REPLACEMENT_REVERSAL_DOWNSTREAM_ACTIVITY",
            details: {
                reviewRequired: true,
                blockerPublicIds: expect.arrayContaining(reallocations.map((row) => row.publicId)),
            },
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) }))
            .toMatchObject({ status: "active" });
    });

    // Break caught: an editable payout draft survives reversal and can later be posted against
    // the cancelled replacement contract because only posted events were inspected.
    integrationTest("blocks reversal while a replacement disbursement draft exists", async () => {
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const executed = await fixture.execute(preview);
        const draft = await createDisbursementDraft(
            fixture.context("replacement-draft-before-reversal"),
            fixture.replacementDraft.publicId,
            {
                grossAmount: "1.00",
                loanAttributedAmount: "1.00",
                channel: "bank_transfer",
                sourceBankProfilePublicId: fixture.source.profile.publicId,
                disbursedAt: "2026-08-17T00:00:00.000Z",
            },
        );

        await expect(fixture.reverse(
            executed.replacementPublicId,
            "draft-disbursement-reversal",
        )).rejects.toMatchObject({
            code: "REPLACEMENT_REVERSAL_DOWNSTREAM_ACTIVITY",
            details: {
                reviewRequired: true,
                blockerPublicIds: [draft.publicId],
            },
        });
        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(
            loanDisbursementEvents.publicId,
            draft.publicId,
        ) })).toMatchObject({ status: "draft" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) }))
            .toMatchObject({ status: "active" });
    });

    // Break caught: a tenant-wide reversal key race falls through to a raw unique-index error.
    integrationTest("returns a stable conflict for a cross-record reversal key race", async () => {
        const first = await seedReplacementFixture({ tenantId: "cross-record-reverse" });
        const second = await seedReplacementFixture({ tenantId: "cross-record-reverse" });
        const [firstPreview, secondPreview] = await Promise.all([first.preview(), second.preview()]);
        const [firstExecution, secondExecution] = await Promise.all([
            first.execute(firstPreview, "first-execution"),
            second.execute(secondPreview, "second-execution"),
        ]);

        const results = await Promise.allSettled([
            first.reverse(firstExecution.replacementPublicId, "shared-reversal-key"),
            second.reverse(secondExecution.replacementPublicId, "shared-reversal-key"),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(rejectedReason(results.find((result) => result.status === "rejected")!)).toMatchObject({
            code: "IDEMPOTENCY_CONFLICT",
        });
        const replacements = await db.select().from(loanReplacements).where(eq(
            loanReplacements.tenantId,
            "cross-record-reverse",
        ));
        expect(replacements.filter((row) => row.status === "reversed")).toHaveLength(1);
        expect(replacements.filter((row) => row.status === "executed")).toHaveLength(1);
    });

    // Break caught: preview response, persisted aggregate, and audits rebuild three subtly different proposals.
    integrationTest("persists and reuses one canonical Bangkok-dated replacement proposal", async () => {
        setSystemTime(new Date("2026-08-16T17:30:00.000Z")); // 2026-08-17 00:30 Asia/Bangkok
        const fixture = await seedReplacementFixture({
            oldLoan: { gracePeriodDays: 0, lateFeeMode: "fixed", lateFeeAmount: "10.00" },
        });
        const preview = await fixture.preview("Correct the approved dates without carrying old interest");
        const expectedProposal = {
            schemaVersion: 1,
            asOfDate: "2026-08-17",
            reason: "Correct the approved dates without carrying old interest",
            oldLoan: {
                loanPublicId: fixture.oldLoan.publicId,
                statusBefore: "active",
                statusAfter: "replaced",
                principal: "36000.00",
                collectibleBefore: {
                    principal: "36000.00",
                    interest: "4200.00",
                    fee: "0.00",
                    penalty: "20.00",
                    nextDueDate: "2026-07-13",
                },
                collectibleAfter: {
                    principal: "0.00",
                    interest: "0.00",
                    fee: "0.00",
                    penalty: "0.00",
                    nextDueDate: null,
                },
            },
            cash: { direction: "none", amount: "0.00" },
            correction: {
                principal: "36000.00",
                interest: "4200.00",
                fee: "0.00",
                penalty: "20.00",
            },
            replacement: {
                loanPublicId: fixture.replacementDraft.publicId,
                statusBefore: "draft",
                statusAfter: "active",
                principal: "36000.00",
                interestRate: "0.00",
                repaymentType: "daily",
                termMonths: 7,
                totalInstallments: 200,
                installmentAmount: "300.00",
                startDate: "2026-07-11",
                firstDueDate: "2026-07-12",
                lastDueDate: "2027-01-27",
                totalRepayment: "60000.00",
                fundingSourceKind: "drawdown",
                fundingSourcePublicId: fixture.source.drawdown!.publicId,
            },
            warnings: [
                "Outstanding calculated interest of 4200.00 is corrected to zero and is neither collected nor carried forward.",
                "Outstanding penalty of 20.00 is corrected to zero and is not treated as borrower payment.",
            ],
        } satisfies LoanReplacementProposal;

        expect(preview).toMatchObject({
            ...expectedProposal,
            replacement: {
                ...expectedProposal.replacement,
                fundingSourceName: "TTB",
            },
            warnings: [
                {
                    code: "OUTSTANDING_INTEREST_CORRECTED_TO_ZERO",
                    details: {
                        amount: "4200.00",
                        correctedAmount: "0.00",
                        collected: false,
                        carriedForward: false,
                    },
                },
                {
                    code: "OUTSTANDING_PENALTY_CORRECTED_TO_ZERO",
                    details: {
                        amount: "20.00",
                        correctedAmount: "0.00",
                        treatedAsBorrowerPayment: false,
                    },
                },
            ],
        });
        const persisted = await db.query.loanReplacements.findFirst({
            where: eq(loanReplacements.publicId, preview.publicId),
        });
        expect(persisted?.previewAsOfDate).toBe("2026-08-17");
        expect(persisted?.previewSnapshot).toEqual(expectedProposal);
        const previewAudit = await db.query.auditLogs.findFirst({
            where: and(
                eq(auditLogs.tenantId, fixture.tenantId),
                eq(auditLogs.publicId, preview.auditPublicId),
            ),
        });
        expect(previewAudit?.payload).toMatchObject({
            proposal: expectedProposal,
            oldBalanceVersion: preview.oldBalanceVersion,
            replacementDraftVersion: preview.replacementDraftVersion,
            previewHash: preview.previewHash,
        });
        expect(await fixture.counts()).toEqual({
            replacementRows: 1,
            oldSchedules: 2,
            replacementSchedules: 0,
            oldAllocations: 1,
            replacementAllocations: 0,
            corrections: 0,
            executionAudits: 0,
            reversalAudits: 0,
            payments: 0,
            disbursements: 0,
        });

        const executed = await fixture.execute(
            preview,
            "canonical-proposal-execute",
            expectedProposal.reason,
        );
        const executionAudit = await db.query.auditLogs.findFirst({
            where: and(
                eq(auditLogs.tenantId, fixture.tenantId),
                eq(auditLogs.publicId, executed.auditPublicId),
            ),
        });
        expect(executionAudit?.payload).toMatchObject({ proposal: expectedProposal });
        expect(JSON.stringify(executionAudit?.payload)).not.toMatch(/"(?:id|loanId|scheduleId)":\d+/);
        const activationAudit = await db.query.auditLogs.findFirst({
            where: and(
                eq(auditLogs.tenantId, fixture.tenantId),
                eq(auditLogs.entityType, "loan"),
                eq(auditLogs.entityId, fixture.replacementDraft.publicId),
                eq(auditLogs.action, "activated"),
            ),
        });
        expect(activationAudit?.payload).toMatchObject({ replacementPublicId: preview.publicId });
        expect(activationAudit?.payload).not.toHaveProperty("replacementId");
        expect(await db.select().from(loanReplacementCorrections).where(eq(
            loanReplacementCorrections.tenantId,
            fixture.tenantId,
        ))).toMatchObject([{ penalty: "20.00" }]);
    });

    // Break caught: own-capital previews lose the only public funding-source identifier.
    integrationTest("presents the active own-capital profile as the canonical funding source", async () => {
        setSystemTime(new Date("2026-08-17T05:00:00.000Z"));
        const fixture = await seedReplacementFixture({ funding: "own_capital" });

        const preview = await fixture.preview();

        expect(preview).toMatchObject({
            asOfDate: "2026-08-17",
            replacement: {
                fundingSourceKind: "own_capital",
                fundingSourcePublicId: fixture.source.profile.publicId,
                fundingSourceName: "Own Capital",
            },
        });
        expect((await db.query.loanReplacements.findFirst({
            where: eq(loanReplacements.publicId, preview.publicId),
        }))?.previewSnapshot).toMatchObject({
            replacement: {
                fundingSourceKind: "own_capital",
                fundingSourcePublicId: fixture.source.profile.publicId,
            },
        });
    });

    // Break caught: a preview confirmed on the next Bangkok business date executes yesterday's penalty proposal.
    integrationTest("expires the confirmed proposal when Bangkok business date advances", async () => {
        setSystemTime(new Date("2026-08-17T16:59:00.000Z")); // 23:59 Bangkok
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        expect(preview.asOfDate).toBe("2026-08-17");
        setSystemTime(new Date("2026-08-17T17:00:01.000Z")); // 00:00:01 Bangkok next day

        await expect(fixture.execute(preview)).rejects.toMatchObject({
            code: "REPLACEMENT_PREVIEW_STALE",
            details: {
                reviewRequired: true,
                blockerPublicIds: [preview.publicId],
            },
        });
        await expectUnchangedPreviewState(fixture);
    });

    // Break caught: expiry is checked before waiting on the parent loan lock, allowing a request
    // that crosses the 15-minute deadline while blocked to execute with stale confirmation.
    integrationTest("rechecks preview expiry after waiting on the parent loan lock", async () => {
        setSystemTime(new Date("2026-08-17T05:00:00.000Z"));
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const databaseUrl = process.env.TEST_DATABASE_URL!;
        const blocker = postgres(databaseUrl, { max: 1 });
        const observer = postgres(databaseUrl, { max: 1 });
        let releaseBlocker!: () => void;
        let confirmLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const locked = new Promise<void>((resolve) => { confirmLocked = resolve; });
        const blockerTransaction = blocker.begin(async (connection) => {
            await connection`SELECT id FROM loans
                WHERE tenant_id = ${fixture.tenantId} AND id = ${fixture.oldLoan.id}
                FOR UPDATE`;
            confirmLocked();
            await release;
        });
        try {
            await locked;
            const executionPromise = fixture.execute(preview, "post-lock-expiry");
            await waitForPostgresLockWaiters(observer, 1);
            setSystemTime(new Date(preview.expiresAt.getTime() + 1));
            releaseBlocker();
            await expect(executionPromise).rejects.toMatchObject({
                code: "REPLACEMENT_PREVIEW_EXPIRED",
                details: { blockerPublicIds: [preview.publicId] },
            });
            await expectUnchangedPreviewState(fixture);
        } finally {
            releaseBlocker();
            await blockerTransaction.catch(() => undefined);
            await Promise.all([blocker.end(), observer.end()]);
        }
    }, 15_000);

    // Break caught: the Bangkok date is checked before a lock wait, so execution can commit a
    // prior-day penalty snapshot after midnight without fresh human confirmation.
    integrationTest("rechecks Bangkok business date after waiting on the parent loan lock", async () => {
        setSystemTime(new Date("2026-08-17T16:59:30.000Z")); // 23:59:30 Bangkok
        const fixture = await seedReplacementFixture();
        const preview = await fixture.preview();
        const databaseUrl = process.env.TEST_DATABASE_URL!;
        const blocker = postgres(databaseUrl, { max: 1 });
        const observer = postgres(databaseUrl, { max: 1 });
        let releaseBlocker!: () => void;
        let confirmLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const locked = new Promise<void>((resolve) => { confirmLocked = resolve; });
        const blockerTransaction = blocker.begin(async (connection) => {
            await connection`SELECT id FROM loans
                WHERE tenant_id = ${fixture.tenantId} AND id = ${fixture.oldLoan.id}
                FOR UPDATE`;
            confirmLocked();
            await release;
        });
        try {
            await locked;
            const executionPromise = fixture.execute(preview, "post-lock-business-date");
            await waitForPostgresLockWaiters(observer, 1);
            setSystemTime(new Date("2026-08-17T17:00:30.000Z")); // 00:00:30 Bangkok next day
            releaseBlocker();
            await expect(executionPromise).rejects.toMatchObject({
                code: "REPLACEMENT_PREVIEW_STALE",
                details: { blockerPublicIds: [preview.publicId] },
            });
            await expectUnchangedPreviewState(fixture);
        } finally {
            releaseBlocker();
            await blockerTransaction.catch(() => undefined);
            await Promise.all([blocker.end(), observer.end()]);
        }
    }, 15_000);
});
