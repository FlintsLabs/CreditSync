import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    borrowers,
    loanInterestAccruals,
    loanInterestRatePeriods,
    loanSchedules,
    loans,
    paymentIntakes,
    paymentMatchAllocations,
    paymentMatchProposals,
    transactions,
    users,
} from "../db/schema";
import type { CommandContext } from "../services/command-context";
import { searchBorrowers } from "../services/borrower-service";
import { createDefaultMcpToolHandlers } from "./default";
import { compositeReadInternals, inspectLoanContext, matchPaymentContext, resolveAndPortfolio } from "./composite-reads";
import { MCP_TOOL_NAMES, advertisedMcpToolMetadata } from "./server";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;
const TENANT_ID = "tenant-mcp-composite-read-test";
const OTHER_TENANT_ID = "tenant-mcp-composite-read-other";
const ACTOR_EMAIL = "mcp-composite-read@example.test";
const UUID = "0198c481-3e2b-7000-8000-000000000001";

function context(actorUserId: number | null, tenantId = TENANT_ID): CommandContext {
    return {
        tenantId,
        actorUserId,
        actorSource: "mcp",
        requestId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
    };
}

beforeEach(async () => {
    if (!integrationEnabled) return;
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, loan_disbursement_events, payment_match_allocations, payment_match_proposals,
        payment_evidence, transactions, payment_intakes, loan_funding_allocations, loan_interest_accruals, loan_schedules,
        loans, borrower_aliases, borrowers, bank_loan_schedules, bank_loans, bank_profiles, files, users
        RESTART IDENTITY CASCADE`);
});

describe("bounded composite-read primitives", () => {
    test("pages without changing exact public money strings", () => {
        const items = [{ publicId: UUID, amount: "9007199254740992.00" }, { publicId: UUID, amount: "0.01" }];
        const first = compositeReadInternals.page(items, 1, undefined, {
            tool: "test", parentPublicId: UUID, view: "summary", collection: "loans",
        });
        expect(first).toMatchObject({
            items: [items[0]], limit: 1, hasMore: true,
        });
        expect(first.nextCursor).toMatch(/^mcp1\./u);
        const second = compositeReadInternals.page(items, 1, first.nextCursor, {
            tool: "test", parentPublicId: UUID, view: "summary", collection: "loans",
        });
        expect(second).toEqual({ items: [items[1]], limit: 1, hasMore: false, nextCursor: null });
        expect(second.items[0]!.amount).toBe("0.01");
    });

    test("rejects a cursor from another view or child collection", () => {
        const cursor = compositeReadInternals.page([1, 2], 1, undefined, {
            tool: "loan.inspect-context", parentPublicId: UUID, view: "schedule", collection: "schedule",
        }).nextCursor;
        expect(() => compositeReadInternals.page([1, 2], 1, cursor, {
            tool: "loan.inspect-context", parentPublicId: UUID, view: "history", collection: "history",
        })).toThrow(expect.objectContaining({ code: "INVALID_COMPOSITE_READ_INPUT" }));
    });

    test("rejects every cursor that is unused by the selected tool and view", async () => {
        const orphanCursors = {
            borrowerCandidates: "orphan",
            aliases: "orphan",
            loans: "orphan",
            allocations: "orphan",
            schedule: "orphan",
            history: "orphan",
            disbursements: "orphan",
            accruals: "orphan",
            allocationCursors: { [UUID]: "orphan" },
            scheduleCursors: { [UUID]: "orphan" },
            historyCursors: { [UUID]: "orphan" },
            accrualCursors: { [UUID]: "orphan" },
        };
        const borrowerAllowed = new Set(["aliases", "loans"]);
        for (const key of Object.keys(orphanCursors) as Array<keyof typeof orphanCursors>) {
            if (borrowerAllowed.has(key)) continue;
            await expect(resolveAndPortfolio(context(null), {
                borrowerPublicId: UUID, cursors: { [key]: orphanCursors[key] },
            })).rejects.toThrow(expect.objectContaining({ code: "INVALID_COMPOSITE_READ_INPUT" }));
            for (const view of ["summary", "schedule", "history"] as const) {
                const loanAllowed = new Set(view === "summary" ? [] : view === "schedule" ? ["schedule"] : ["history", "disbursements", "accruals"]);
                if (!loanAllowed.has(key)) {
                    await expect(inspectLoanContext(context(null), {
                        loanPublicId: UUID, view, cursors: { [key]: orphanCursors[key] },
                    })).rejects.toThrow(expect.objectContaining({ code: "INVALID_COMPOSITE_READ_INPUT" }));
                }
                const paymentAllowed = new Set(view === "summary"
                    ? ["borrowerCandidates", "allocations"]
                    : view === "schedule"
                        ? ["borrowerCandidates", "allocations", "loans", "allocationCursors", "scheduleCursors"]
                        : ["borrowerCandidates", "allocations", "loans", "allocationCursors", "historyCursors", "accrualCursors"]);
                if (!paymentAllowed.has(key)) {
                    await expect(matchPaymentContext(context(null), {
                        paymentIntakePublicId: UUID, view, cursors: { [key]: orphanCursors[key] },
                    })).rejects.toThrow(expect.objectContaining({ code: "INVALID_COMPOSITE_READ_INPUT" }));
                }
            }
        }
    });

    test("rejects a stale result-set cursor after the paged collection changes", () => {
        const initial = [{ publicId: UUID, name: "A" }, { publicId: "0198c481-3e2b-7000-8000-000000000002", name: "B" }];
        const first = compositeReadInternals.page(initial, 1, undefined, {
            tool: "borrower.resolve-and-portfolio", parentPublicId: UUID, view: "portfolio", collection: "loans",
        });
        expect(() => compositeReadInternals.page([...initial, { publicId: "0198c481-3e2b-7000-8000-000000000003", name: "C" }], 1, first.nextCursor, {
            tool: "borrower.resolve-and-portfolio", parentPublicId: UUID, view: "portfolio", collection: "loans",
        })).toThrow(expect.objectContaining({ code: "INVALID_COMPOSITE_READ_INPUT" }));
    });

    test("registers all three composites as read-only idempotent tools with closed inputs", () => {
        const names = ["borrower.resolve-and-portfolio", "loan.inspect-context", "payment.match-context"];
        const metadata = advertisedMcpToolMetadata();
        for (const name of names) {
            const tool = metadata.find((item) => item.name === name)!;
            expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
            expect(tool.inputSchema.additionalProperties).toBe(false);
            expect(typeof createDefaultMcpToolHandlers()[name as keyof ReturnType<typeof createDefaultMcpToolHandlers>]).toBe("function");
        }
        expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
    });
});

integrationTest("composes borrower, loan, and payment reads without financial writes", async () => {
    const actor = await db.insert(users).values({ tenantId: TENANT_ID, email: ACTOR_EMAIL, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId: TENANT_ID, ownerUserId: actor.id, name: "Composite borrower" }).returning().then((rows) => rows[0]!);
    const [loanA, loanB] = await db.insert(loans).values([
        {
            tenantId: TENANT_ID, ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "9007199254740992.00", interestRate: "0.00", repaymentType: "monthly",
            termMonths: 2, startDate: "2026-09-01", outstandingPrincipal: "9007199254740992.00", status: "active",
        },
        {
            tenantId: TENANT_ID, ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly",
            termMonths: 2, startDate: "2026-09-01", outstandingPrincipal: "100.00", status: "active",
        },
    ]).returning();
    await db.insert(loanSchedules).values([
        { tenantId: TENANT_ID, loanId: loanA!.id, installmentNo: 1, dueDate: "2026-09-15", scheduledPrincipal: "50.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "50.00", remainingDue: "50.00" },
        { tenantId: TENANT_ID, loanId: loanA!.id, installmentNo: 2, dueDate: "2026-10-15", scheduledPrincipal: "50.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "50.00", remainingDue: "50.00" },
    ]);
    const intake = await db.insert(paymentIntakes).values({
        tenantId: TENANT_ID, ownerUserId: actor.id, source: "mcp", status: "draft",
        amount: "9007199254740992.00", receivedAt: new Date("2026-09-13T03:00:00.000Z"), payerName: borrower.name,
        evidenceRequired: false, createdByUserId: actor.id, updatedByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    const ctx = context(actor.id);
    const auditBefore = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, TENANT_ID));

    const portfolio = await resolveAndPortfolio(ctx, { borrowerPublicId: borrower.publicId, limit: 1 });
    expect(portfolio.portfolio?.loans).toMatchObject({ items: [expect.objectContaining({ publicId: loanA!.publicId, principal: "9007199254740992.00" })], hasMore: true });
    const firstLoanPage = (portfolio.portfolio as { loans: { nextCursor: string | null } }).loans;
    const nextPortfolio = await resolveAndPortfolio(ctx, {
        borrowerPublicId: borrower.publicId, limit: 1,
        cursors: { loans: String(firstLoanPage.nextCursor) },
    });
    expect(nextPortfolio.portfolio?.loans).toMatchObject({ items: [expect.objectContaining({ publicId: loanB!.publicId })], hasMore: false, nextCursor: null });

    const inspected = await inspectLoanContext(ctx, { loanPublicId: loanA!.publicId, view: "schedule", limit: 1 });
    expect(inspected.schedule).toMatchObject({ items: [expect.objectContaining({ scheduledPrincipal: "50.00" })], hasMore: true });
    expect(inspected.history).toBeNull();

    const matched = await matchPaymentContext(ctx, { paymentIntakePublicId: intake.publicId, limit: 25 });
    expect(matched.intake.amount).toBe("9007199254740992.00");
    expect(matched.borrowerResolution).toMatchObject({ resolution: "unique", candidates: { items: [expect.objectContaining({ publicId: borrower.publicId })] } });
    expect(matched.proposal).toBeNull();
    expect(matched.loanContexts).toBeNull();

    const auditAfter = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, TENANT_ID));
    expect(auditAfter).toEqual(auditBefore);
    expect(await db.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, TENANT_ID), eq(paymentIntakes.id, intake.id)))).toHaveLength(1);
});

integrationTest("keeps ambiguous borrower resolution as candidates and preserves tenant authorization", async () => {
    const actor = await db.insert(users).values({ tenantId: TENANT_ID, email: ACTOR_EMAIL, role: "owner" }).returning().then((rows) => rows[0]!);
    await db.insert(borrowers).values([
        { tenantId: TENANT_ID, ownerUserId: actor.id, name: "Same borrower" },
        { tenantId: TENANT_ID, ownerUserId: actor.id, name: "Same borrower" },
        { tenantId: OTHER_TENANT_ID, ownerUserId: actor.id, name: "Same borrower" },
    ]);
    const ambiguous = await resolveAndPortfolio(context(actor.id), { query: "Same borrower" });
    expect(ambiguous.resolution).toBe("ambiguous");
    expect(ambiguous.selectedBorrowerPublicId).toBeNull();
    expect(ambiguous.portfolio).toBeNull();
    expect(ambiguous.candidates.items).toHaveLength(2);

    const foreign = await db.query.borrowers.findFirst({ where: eq(borrowers.tenantId, OTHER_TENANT_ID) });
    await expect(resolveAndPortfolio(context(actor.id), { borrowerPublicId: foreign!.publicId })).rejects.toThrow(expect.objectContaining({ code: "BORROWER_NOT_FOUND" }));
});

integrationTest("preserves authorized fuzzy candidate ranking in both composite reads", async () => {
    const actor = await db.insert(users).values({ tenantId: TENANT_ID, email: ACTOR_EMAIL, role: "owner" }).returning().then((rows) => rows[0]!);
    await db.insert(borrowers).values([
        { tenantId: TENANT_ID, ownerUserId: actor.id, name: "An" },
        { tenantId: TENANT_ID, ownerUserId: actor.id, name: "ZAnn" },
    ]);
    const ctx = context(actor.id);
    const serviceResult = await searchBorrowers(ctx, { query: "Ann" });
    const serviceCandidateIds = serviceResult.candidates.map((candidate) => candidate.publicId);
    expect(serviceResult.resolution).toBe("candidates");
    expect(serviceResult.candidates.map((candidate) => candidate.name)).toEqual(["ZAnn", "An"]);

    const portfolioResult = await resolveAndPortfolio(ctx, { query: "Ann" });
    expect(portfolioResult.resolution).toBe("candidates");
    expect(portfolioResult.selectedBorrowerPublicId).toBeNull();
    expect(portfolioResult.candidates.items.map((candidate) => candidate.publicId)).toEqual(serviceCandidateIds);

    const intake = await db.insert(paymentIntakes).values({
        tenantId: TENANT_ID, ownerUserId: actor.id, source: "mcp", status: "draft",
        amount: "1.00", receivedAt: new Date("2026-09-13T03:00:00.000Z"), payerName: "Ann",
        evidenceRequired: false, createdByUserId: actor.id, updatedByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    const paymentResult = await matchPaymentContext(ctx, { paymentIntakePublicId: intake.publicId, view: "summary" });
    expect(paymentResult.borrowerResolution.resolution).toBe("candidates");
    expect(paymentResult.borrowerResolution.candidates.items.map((candidate) => candidate.publicId)).toEqual(serviceCandidateIds);
});

integrationTest("bounds schedules, floating accruals, and every payment allocation without losing decomposition", async () => {
    const actor = await db.insert(users).values({ tenantId: TENANT_ID, email: ACTOR_EMAIL, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId: TENANT_ID, ownerUserId: actor.id, name: "Bounded borrower" }).returning().then((rows) => rows[0]!);
    const [scheduledLoan, floatingLoan] = await db.insert(loans).values([
        {
            tenantId: TENANT_ID, ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "9007199254740992.00", interestRate: "0.00", repaymentType: "monthly",
            termMonths: 101, startDate: "2026-09-01", outstandingPrincipal: "9007199254740992.00", status: "active",
        },
        {
            tenantId: TENANT_ID, ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "9007199254740992.00", interestRate: "0.00", repaymentType: "floating",
            dailyInterestMode: "per_thousand", dailyInterestRate: "1.0000", firstDayTreatment: "start_next_day",
            interestStartDate: "2026-09-01", floatingAccrualCycle: "daily", startDate: "2026-09-01",
            outstandingPrincipal: "9007199254740992.00", status: "active",
        },
    ]).returning();
    await db.insert(loanInterestRatePeriods).values({
        tenantId: TENANT_ID, loanId: floatingLoan!.id, effectiveDate: "2026-09-01", expiryDate: null,
        rateType: "per_thousand", rate: "1.0000", periodUnit: "day", periodLength: 1, createdByUserId: actor.id,
    });
    const schedules = await db.insert(loanSchedules).values(Array.from({ length: 101 }, (_, index) => ({
        tenantId: TENANT_ID, loanId: scheduledLoan!.id, installmentNo: index + 1,
        dueDate: new Date(Date.UTC(2026, 8, index + 1)).toISOString().slice(0, 10),
        scheduledPrincipal: "1.00", scheduledInterest: "0.00", scheduledFee: "0.00",
        scheduledTotal: "1.00", remainingDue: "1.00",
    }))).returning();
    await db.insert(loanInterestAccruals).values(Array.from({ length: 101 }, (_, index) => ({
        tenantId: TENANT_ID, loanId: floatingLoan!.id,
        accrualDate: new Date(Date.UTC(2026, 8, index + 1)).toISOString().slice(0, 10),
        openingPrincipal: "9007199254740992.00", rateMode: "per_thousand", rate: "1.0000",
        periodStartDate: null, periodEndDate: null, periodDayIndex: null, periodDays: null,
        interestAmount: "9007199254740.99", paidAmount: "0.00", periodUnit: null, periodLength: null,
        contractualInterestAmount: null, cumulativeInterestAmount: null, dailyIncrementAmount: null,
        status: "accrued", createdByUserId: actor.id,
    })));
    const intake = await db.insert(paymentIntakes).values({
        tenantId: TENANT_ID, ownerUserId: actor.id, source: "mcp", status: "ready",
        amount: "100.01", receivedAt: new Date("2026-09-13T03:00:00.000Z"), payerName: borrower.name,
        evidenceRequired: false, createdByUserId: actor.id, updatedByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    const proposal = await db.insert(paymentMatchProposals).values({
        tenantId: TENANT_ID, paymentIntakeId: intake.id, version: 1, proposalHash: "composite-read-proposal",
        status: "ready", warnings: [], createdByUserId: actor.id, updatedByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    await db.insert(paymentMatchAllocations).values(schedules.map((schedule, index) => ({
        tenantId: TENANT_ID, proposalId: proposal.id, allocationOrder: index + 1,
        borrowerId: borrower.id, loanId: scheduledLoan!.id, scheduleId: schedule.id,
        amount: index === schedules.length - 1 ? "0.01" : "1.00", matchReason: "exact",
        createdByUserId: actor.id, updatedByUserId: actor.id,
    })));

    const ctx = context(actor.id);
    const before = {
        loans: await db.select().from(loans).where(eq(loans.tenantId, TENANT_ID)),
        schedules: await db.select().from(loanSchedules).where(eq(loanSchedules.tenantId, TENANT_ID)),
        accruals: await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.tenantId, TENANT_ID)),
        transactions: await db.select().from(transactions).where(eq(transactions.tenantId, TENANT_ID)),
        audits: await db.select().from(auditLogs).where(eq(auditLogs.tenantId, TENANT_ID)),
    };

    const summary = await inspectLoanContext(ctx, { loanPublicId: floatingLoan!.publicId, view: "summary", limit: 100 });
    expect(summary.schedule).toBeNull();
    expect(summary.accruals).toBeNull();
    const history = await inspectLoanContext(ctx, { loanPublicId: floatingLoan!.publicId, view: "history", limit: 100 });
    expect(history.accruals).not.toBeNull();
    expect(history.accruals!.limit).toBe(100);
    expect(history.accruals!.hasMore).toBe(true);
    expect(Array.isArray(history.accruals!.items)).toBe(true);
    expect(history.accruals!.items).toHaveLength(100);
    expect((history.accruals!.items[0] as { interestAmount: string }).interestAmount).toBe("9007199254740.99");

    const matched = await matchPaymentContext(ctx, { paymentIntakePublicId: intake.publicId, view: "schedule", limit: 100 });
    expect(matched.allocations.limit).toBe(100);
    expect(matched.allocations.hasMore).toBe(true);
    expect(matched.proposal?.allocations.limit).toBe(100);
    expect(matched.proposal?.allocations.hasMore).toBe(true);
    expect(matched.loanContexts?.items).toHaveLength(1);
    const loanContext = matched.loanContexts!.items[0]! as {
        allocations: { items: Array<Record<string, unknown>>; limit: number; nextCursor: string | null; hasMore: boolean };
    };
    expect(loanContext.allocations.limit).toBe(100);
    expect(loanContext.allocations.hasMore).toBe(true);
    expect(loanContext.allocations.items.length).toBe(100);
    expect(loanContext.allocations.items[0]!.schedulePublicId).toBe(schedules[0]!.publicId);
    expect(loanContext.allocations.items[0]!.amount).toBe("1.00");
    const secondAllocationPage = await matchPaymentContext(ctx, {
        paymentIntakePublicId: intake.publicId, view: "schedule", limit: 100,
        cursors: { allocationCursors: { [scheduledLoan!.publicId]: loanContext.allocations.nextCursor } },
    });
    const secondLoanContext = secondAllocationPage.loanContexts!.items[0]! as unknown as {
        allocations: { items: Array<Record<string, unknown>>; hasMore: boolean };
    };
    const finalAllocation = secondLoanContext.allocations.items[0]!;
    expect(secondLoanContext.allocations.hasMore).toBe(false);
    expect(secondLoanContext.allocations.items.length).toBe(1);
    expect(finalAllocation.schedulePublicId).toBe(schedules[100]!.publicId);
    expect(finalAllocation.amount).toBe("0.01");
    await expect(matchPaymentContext(ctx, {
        paymentIntakePublicId: intake.publicId, view: "schedule",
        cursors: { allocationCursors: { [floatingLoan!.publicId]: "orphan" } },
    })).rejects.toThrow(expect.objectContaining({ code: "INVALID_COMPOSITE_READ_INPUT" }));

    const after = {
        loans: await db.select().from(loans).where(eq(loans.tenantId, TENANT_ID)),
        schedules: await db.select().from(loanSchedules).where(eq(loanSchedules.tenantId, TENANT_ID)),
        accruals: await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.tenantId, TENANT_ID)),
        transactions: await db.select().from(transactions).where(eq(transactions.tenantId, TENANT_ID)),
        audits: await db.select().from(auditLogs).where(eq(auditLogs.tenantId, TENANT_ID)),
    };
    expect(after).toEqual(before);
});

integrationTest("keeps composite reads tenant-scoped for borrower, loan, and payment", async () => {
    const actor = await db.insert(users).values({ tenantId: TENANT_ID, email: ACTOR_EMAIL, role: "owner" }).returning().then((rows) => rows[0]!);
    const otherActor = await db.insert(users).values({ tenantId: OTHER_TENANT_ID, email: "other-composite@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
    const otherBorrower = await db.insert(borrowers).values({ tenantId: OTHER_TENANT_ID, ownerUserId: otherActor.id, name: "Foreign" }).returning().then((rows) => rows[0]!);
    const otherLoan = await db.insert(loans).values({
        tenantId: OTHER_TENANT_ID, ownerUserId: otherActor.id, borrowerId: otherBorrower.id,
        principalAmount: "10.00", interestRate: "0.00", repaymentType: "monthly", termMonths: 1,
        startDate: "2026-09-01", outstandingPrincipal: "10.00", status: "active",
    }).returning().then((rows) => rows[0]!);
    const otherIntake = await db.insert(paymentIntakes).values({
        tenantId: OTHER_TENANT_ID, ownerUserId: otherActor.id, source: "mcp", status: "draft",
        amount: "10.00", receivedAt: new Date("2026-09-13T03:00:00.000Z"), payerName: "Foreign",
        evidenceRequired: false, createdByUserId: otherActor.id, updatedByUserId: otherActor.id,
    }).returning().then((rows) => rows[0]!);
    const ctx = context(actor.id);
    await expect(resolveAndPortfolio(ctx, { borrowerPublicId: otherBorrower.publicId })).rejects.toThrow(expect.objectContaining({ code: "BORROWER_NOT_FOUND" }));
    await expect(inspectLoanContext(ctx, { loanPublicId: otherLoan.publicId })).rejects.toThrow(expect.objectContaining({ code: "LOAN_NOT_FOUND" }));
    await expect(matchPaymentContext(ctx, { paymentIntakePublicId: otherIntake.publicId })).rejects.toThrow(expect.objectContaining({ code: "PAYMENT_INTAKE_NOT_FOUND" }));
});
