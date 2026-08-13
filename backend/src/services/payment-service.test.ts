import { beforeEach, describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    bankProfiles,
    borrowers,
    files,
    fundLedgerEntries,
    loanFundingAllocations,
    loanAdjustments,
    loanInterestAccruals,
    loanInterestRatePeriods,
    loanSchedules,
    loans,
    paymentEvidence,
    paymentIntakes,
    paymentMatchAllocations,
    paymentMatchProposals,
    transactions,
    users,
} from "../db/schema";
import type { CommandContext } from "./command-context";
import type { SignedPutRequest, StoredObjectHead } from "../lib/storage";
import {
    createPaymentIntake,
    finalizePaymentEvidence,
    getPaymentIntake,
    listPaymentIntakes,
    normalizeBankReference,
    postPayment,
    preparePaymentEvidence,
    previewPaymentMatch,
    reversePayment,
    reviewPaymentIntake,
    type EvidenceStorageGateway,
} from "./payment-service";
import { correctFloatingInterestAccruals } from "./floating-interest-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, fund_ledger_entries, payment_match_allocations,
        payment_match_proposals, payment_evidence, transactions,
        payment_intakes, loan_funding_allocations, loan_schedules,
        loans, borrower_aliases, borrowers, bank_profiles, users
        RESTART IDENTITY CASCADE`);
}

async function seedUser(tenantId = "tenant-a", role: "owner" | "manager" | "collector" | "viewer" = "owner") {
    return db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role })
        .returning().then((rows) => rows[0]!);
}

function context(actor: { id: number; tenantId: string }, idempotencyKey: string = crypto.randomUUID()): CommandContext {
    return {
        tenantId: actor.tenantId,
        actorUserId: actor.id,
        actorSource: "web",
        requestId: `req-${crypto.randomUUID()}`,
        correlationId: `corr-${crypto.randomUUID()}`,
        idempotencyKey,
    };
}

async function seedLoan(input: {
    actor: { id: number; tenantId: string };
    borrowerName: string;
    alias?: string;
    schedules: Array<{ total: string; principal?: string; interest?: string; fee?: string; dueDate?: string }>;
    funded?: boolean;
    lateFeeMode?: "none" | "fixed";
    lateFeeAmount?: string;
    nextDueDate?: string;
}) {
    const borrower = await db.insert(borrowers).values({
        tenantId: input.actor.tenantId,
        ownerUserId: input.actor.id,
        name: input.borrowerName,
    }).returning().then((rows) => rows[0]!);
    if (input.alias) {
        await db.execute(sql`INSERT INTO borrower_aliases
            (tenant_id, borrower_id, alias, normalized_alias, status, confirmed_at, created_by_user_id, updated_by_user_id)
            VALUES (${input.actor.tenantId}, ${borrower.id}, ${input.alias}, ${input.alias.toLocaleLowerCase()}, 'confirmed', now(), ${input.actor.id}, ${input.actor.id})`);
    }
    const principal = input.schedules.reduce((sum, row) => sum + Number(row.principal ?? row.total), 0).toFixed(2);
    const loan = await db.insert(loans).values({
        tenantId: input.actor.tenantId,
        ownerUserId: input.actor.id,
        borrowerId: borrower.id,
        principalAmount: principal,
        interestRate: "0.00",
        repaymentType: "monthly",
        outstandingPrincipal: principal,
        outstandingInterest: "0.00",
        outstandingFees: "0.00",
        lateFeeMode: input.lateFeeMode ?? "none",
        lateFeeAmount: input.lateFeeAmount ?? "0.00",
        nextDueDate: input.nextDueDate,
        status: "active",
    }).returning().then((rows) => rows[0]!);
    const schedules = await db.insert(loanSchedules).values(input.schedules.map((row, index) => ({
        tenantId: input.actor.tenantId,
        loanId: loan.id,
        installmentNo: index + 1,
        dueDate: row.dueDate ?? `2026-${String(index + 8).padStart(2, "0")}-10`,
        scheduledPrincipal: row.principal ?? row.total,
        scheduledInterest: row.interest ?? "0.00",
        scheduledFee: row.fee ?? "0.00",
        scheduledTotal: row.total,
        paidTotal: "0.00",
        paidPenalty: "0.00",
        remainingDue: row.total,
        status: "pending",
    }))).returning();
    if (input.funded) {
        const profile = await db.insert(bankProfiles).values({
            tenantId: input.actor.tenantId,
            name: "Payment test fund",
            type: "personal_savings",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanFundingAllocations).values({
            tenantId: input.actor.tenantId,
            loanId: loan.id,
            bankProfileId: profile.id,
            allocatedAmount: principal,
            allocationDate: "2026-08-01",
            createdByUserId: input.actor.id,
        });
    }
    return { borrower, loan, schedules };
}

async function seedFloatingLoan(actor: { id: number; tenantId: string }, accrualCycle: "daily" | "weekly" = "daily") {
    const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "Floating borrower" }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
        principalAmount: "4000.00", interestRate: "0.00", repaymentType: "floating",
        dailyInterestMode: "per_thousand", dailyInterestRate: "15.0000",
        firstDayTreatment: accrualCycle === "weekly" ? "start_next_day" : "deduct",
        floatingAccrualCycle: accrualCycle,
        interestStartDate: "2026-08-06", outstandingPrincipal: "4000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active",
    }).returning().then((rows) => rows[0]!);
    const period = await db.insert(loanInterestRatePeriods).values({
        tenantId: actor.tenantId, loanId: loan.id, effectiveDate: "2026-08-06", rateType: "per_thousand", rate: "15.0000", createdByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    return { borrower, loan, period };
}

describe("payment application service", () => {
    // Break caught: visually equivalent references hash differently and bypass hard-duplicate detection.
    test("normalizes bank references deterministically without retaining punctuation differences", () => {
        expect(normalizeBankReference("  SCB—001 / 2569  ")).toBe("scb0012569");
    });

    if (integrationEnabled) beforeEach(resetApplicationTables);

    // Break caught: a zero-valued legacy accrual silently makes a floating payment reduce principal despite a positive daily rate.
    integrationTest("blocks floating allocation when an active accrual has an impossible zero principal", async () => {
        const actor = await seedUser("tenant-floating-corrupt");
        const seeded = await seedFloatingLoan(actor);
        await db.insert(loanInterestAccruals).values({
            tenantId: actor.tenantId, loanId: seeded.loan.id, interestRatePeriodId: seeded.period.id,
            accrualDate: "2026-08-07", openingPrincipal: "0.00", rateMode: "per_thousand", rate: "15.0000", interestAmount: "0.00", createdByUserId: actor.id,
        });
        const intake = await createPaymentIntake(context(actor), { amount: "60.00", receivedAt: "2026-08-07T06:46:00.000Z" });

        await expect(previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "60.00" }],
        })).rejects.toMatchObject({ code: "FLOATING_INTEREST_ACCRUAL_CORRUPT", status: 409 });
    });

    // Break caught: repairing legacy daily interest overwrites history, duplicates an active date, or loses first-day deduction state.
    integrationTest("replaces corrupt floating accruals append-only with an audited idempotent correction", async () => {
        const actor = await seedUser("tenant-floating-correction");
        const seeded = await seedFloatingLoan(actor);
        await db.insert(loanInterestAccruals).values(["2026-08-06", "2026-08-07"].map((accrualDate) => ({
            tenantId: actor.tenantId, loanId: seeded.loan.id, interestRatePeriodId: seeded.period.id,
            accrualDate, openingPrincipal: "0.00", rateMode: "per_thousand", rate: "15.0000", interestAmount: "0.00", createdByUserId: actor.id,
        })));
        const command = context(actor, "repair-floating-legacy-1");
        const corrected = await correctFloatingInterestAccruals(command, seeded.loan.publicId, ["2026-08-06", "2026-08-07"], "Repair activation accrual basis");
        expect(await correctFloatingInterestAccruals(command, seeded.loan.publicId, ["2026-08-06", "2026-08-07"], "Repair activation accrual basis")).toEqual(corrected);

        const rows = await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, seeded.loan.id)).orderBy(loanInterestAccruals.accrualDate, loanInterestAccruals.id);
        expect(rows).toHaveLength(4);
        expect(rows.filter((row) => row.status === "reversed")).toHaveLength(2);
        expect(rows.filter((row) => row.status !== "reversed")).toEqual([
            expect.objectContaining({ accrualDate: "2026-08-06", openingPrincipal: "4000.00", interestAmount: "60.00", paidAmount: "60.00", status: "paid" }),
            expect.objectContaining({ accrualDate: "2026-08-07", openingPrincipal: "4000.00", interestAmount: "60.00", paidAmount: "0.00", status: "accrued" }),
        ]);
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) })).toMatchObject({ outstandingInterest: "60.00" });
        expect(await db.select().from(loanAdjustments)).toEqual([expect.objectContaining({ adjustmentType: "floating_interest_accrual_correction", amount: "120.00", reason: "Repair activation accrual basis" })]);
        expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "floating_interest_accruals_corrected"))).toHaveLength(1);
    });

    // Break caught: correction rejects valid interim weekly snapshots or
    // replaces them with a full weekly charge rather than the daily increment.
    integrationTest("corrects an interim weekly period snapshot with immutable period metadata", async () => {
        const actor = await seedUser("tenant-weekly-correction");
        const seeded = await seedFloatingLoan(actor, "weekly");
        await db.insert(loanInterestAccruals).values({
            tenantId: actor.tenantId, loanId: seeded.loan.id, interestRatePeriodId: seeded.period.id,
            accrualDate: "2026-08-09", openingPrincipal: "0.00", rateMode: "per_thousand", rate: "15.0000",
            interestAmount: "0.00", createdByUserId: actor.id,
        });

        await correctFloatingInterestAccruals(
            context(actor, "repair-weekly-interim"), seeded.loan.publicId, ["2026-08-09"], "Repair weekly interim snapshot",
        );
        expect(await db.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.loanId, seeded.loan.id), eq(loanInterestAccruals.accrualDate, "2026-08-09"),
        )).orderBy(loanInterestAccruals.id)).toEqual([
            expect.objectContaining({ status: "reversed", interestAmount: "0.00" }),
            expect.objectContaining({
                status: "accruing", openingPrincipal: "4000.00", interestAmount: "8.57", paidAmount: "0.00",
                periodStartDate: "2026-08-06", periodEndDate: "2026-08-13", periodDayIndex: 3, periodDays: 7,
                cumulativeInterestAmount: "25.71",
            }),
        ]);
    });

    // Break caught: a normal repayment silently consumes the current weekly
    // period projection, or a same-day principal payment rewrites prior days.
    integrationTest("excludes accruing weekly interest and changes principal only on following snapshots", async () => {
        const actor = await seedUser("tenant-weekly-payment");
        const seeded = await seedFloatingLoan(actor, "weekly");
        const intake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-09T05:00:00.000Z",
        });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{
                borrowerPublicId: seeded.borrower.publicId,
                loanPublicId: seeded.loan.publicId,
                amount: "100.00",
            }],
        });

        const posted = await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
        expect(posted.transactions).toEqual([expect.objectContaining({
            interestComponent: "0.00", principalComponent: "100.00",
        })]);
        const throughPaymentDate = await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, seeded.loan.id)).orderBy(loanInterestAccruals.accrualDate);
        expect(throughPaymentDate).toMatchObject([
            { accrualDate: "2026-08-07", openingPrincipal: "4000.00", interestAmount: "8.57", status: "accruing" },
            { accrualDate: "2026-08-08", openingPrincipal: "4000.00", interestAmount: "8.57", status: "accruing" },
            { accrualDate: "2026-08-09", openingPrincipal: "4000.00", interestAmount: "8.57", status: "accruing" },
        ]);

        const refreshedLoan = (await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))!;
        await import("./floating-interest-service").then(({ accrueFloatingInterestThrough }) =>
            accrueFloatingInterestThrough(db, refreshedLoan, new Date("2026-08-10T12:00:00+07:00"), actor.id));
        expect(await db.query.loanInterestAccruals.findFirst({ where: and(
            eq(loanInterestAccruals.loanId, seeded.loan.id), eq(loanInterestAccruals.accrualDate, "2026-08-10"),
        ) })).toMatchObject({
            openingPrincipal: "3900.00", interestAmount: "8.36", cumulativeInterestAmount: "34.07", status: "accruing",
        });

        const boundaryIntake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-13T05:00:00.000Z",
        });
        const boundaryPreview = await previewPaymentMatch(context(actor), boundaryIntake.publicId, {
            allocations: [{
                borrowerPublicId: seeded.borrower.publicId,
                loanPublicId: seeded.loan.publicId,
                amount: "100.00",
            }],
        });
        const boundaryPosted = await postPayment(context(actor), boundaryIntake.publicId, {
            proposalPublicId: boundaryPreview.publicId,
        });
        expect(boundaryPosted.transactions).toEqual([expect.objectContaining({
            interestComponent: "59.14", principalComponent: "40.86",
        })]);
        expect(await db.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.loanId, seeded.loan.id),
            eq(loanInterestAccruals.status, "paid"),
        ))).toHaveLength(7);
    });

    // Break caught: reversing an unscheduled floating repayment leaves its principal and paid daily interest reduced.
    integrationTest("restores floating principal and daily interest when the latest payment is reversed", async () => {
        const actor = await seedUser("tenant-floating-reversal");
        const seeded = await seedFloatingLoan(actor);
        await db.insert(loanInterestAccruals).values([{
            tenantId: actor.tenantId, loanId: seeded.loan.id, interestRatePeriodId: seeded.period.id,
            accrualDate: "2026-08-06", openingPrincipal: "4000.00", rateMode: "per_thousand", rate: "15.0000", interestAmount: "60.00", paidAmount: "60.00", status: "paid", createdByUserId: actor.id,
        }, {
            tenantId: actor.tenantId, loanId: seeded.loan.id, interestRatePeriodId: seeded.period.id,
            accrualDate: "2026-08-07", openingPrincipal: "4000.00", rateMode: "per_thousand", rate: "15.0000", interestAmount: "60.00", createdByUserId: actor.id,
        }]);
        const intake = await createPaymentIntake(context(actor), { amount: "100.00", receivedAt: "2026-08-07T06:46:00.000Z" });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "100.00" }],
        });
        const posted = await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
        expect(posted.transactions).toEqual([expect.objectContaining({ interestComponent: "60.00", principalComponent: "40.00" })]);

        await reversePayment(context(actor), intake.publicId, { reason: "Correct misapplied floating allocation" });

        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) })).toMatchObject({ outstandingPrincipal: "4000.00", outstandingInterest: "60.00" });
        expect(await db.query.loanInterestAccruals.findFirst({ where: and(eq(loanInterestAccruals.loanId, seeded.loan.id), eq(loanInterestAccruals.accrualDate, "2026-08-07")) })).toMatchObject({ paidAmount: "0.00", status: "accrued" });
    });

    // Break caught: data-only intake is rejected, money is coerced through Number, or a retry creates a second row.
    integrationTest("creates a data-only intake and returns the existing UUID for every hard duplicate", async () => {
        const actor = await seedUser();
        const created = await createPaymentIntake(context(actor, "operation-1"), {
            amount: "9007199254740993.00",
            receivedAt: "2026-08-10T10:00:00.000Z",
            payerName: "Somchai",
            bankReference: "SCB-001",
            qrPayload: "raw-qr-is-hashed-only",
        });
        const byOperation = await createPaymentIntake(context(actor, "operation-1"), {
            amount: "1.00",
            receivedAt: "2026-08-10T11:00:00.000Z",
        });
        const byBank = await createPaymentIntake(context(actor, "operation-2"), {
            amount: "9007199254740993.00",
            receivedAt: "2026-08-10T10:00:00.000Z",
            bankReference: " SCB / 001 ",
        });
        const byQr = await createPaymentIntake(context(actor, "operation-3"), {
            amount: "9007199254740993.00",
            receivedAt: "2026-08-10T10:00:00.000Z",
            qrPayload: "raw-qr-is-hashed-only",
        });

        expect(created).toMatchObject({ id: created.publicId, amount: "9007199254740993.00", duplicate: false });
        expect(byOperation).toMatchObject({ publicId: created.publicId, duplicate: true, duplicateReason: "idempotency_key" });
        expect(byBank).toMatchObject({ publicId: created.publicId, duplicate: true, duplicateReason: "bank_reference" });
        expect(byQr).toMatchObject({ publicId: created.publicId, duplicate: true, duplicateReason: "qr_payload" });
        expect(await db.select().from(paymentIntakes)).toHaveLength(1);
        const stored = await db.query.paymentIntakes.findFirst();
        expect(stored?.amount).toBe("9007199254740993.00");
        expect(JSON.stringify(await db.select().from(auditLogs))).not.toContain("raw-qr-is-hashed-only");
    });

    // Break caught: a quick-capture intake loses its source loan or can attach to a loan outside the actor's portfolio.
    integrationTest("persists an accessible origin loan on payment intake capture", async () => {
        const actor = await seedUser("tenant-origin");
        const { borrower, loan } = await seedLoan({ actor, borrowerName: "Origin borrower", schedules: [{ total: "100.00" }] });
        const created = await createPaymentIntake(context(actor, "origin-loan-capture"), {
            amount: "100.00",
            receivedAt: "2026-08-11T10:00:00.000Z",
            payerName: borrower.name,
            originLoanPublicId: loan.publicId,
        });

        expect(created).toMatchObject({ originLoanPublicId: loan.publicId, amount: "100.00" });
        expect(await db.query.paymentIntakes.findFirst()).toMatchObject({ originLoanId: loan.id });
        expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "created")))
            .toEqual([expect.objectContaining({ payload: expect.objectContaining({ originLoanPublicId: loan.publicId }) })]);
    });

    // Break caught: a collector can attach a payment intake to another collector's loan.
    integrationTest("rejects an origin loan outside the actor's portfolio", async () => {
        const owner = await seedUser("tenant-origin-access", "collector");
        const otherCollector = await seedUser("tenant-origin-access", "collector");
        const { loan } = await seedLoan({ actor: owner, borrowerName: "Private borrower", schedules: [{ total: "100.00" }] });

        await expect(createPaymentIntake(context(otherCollector, "origin-loan-forbidden"), {
            amount: "100.00",
            receivedAt: "2026-08-11T10:00:00.000Z",
            originLoanPublicId: loan.publicId,
        })).rejects.toMatchObject({ code: "LOAN_NOT_FOUND", status: 404 });
    });

    // Break caught: amount/time/name similarity is promoted to a destructive duplicate decision.
    integrationTest("keeps semantic duplicates and reports a warning only", async () => {
        const actor = await seedUser();
        await createPaymentIntake(context(actor, "semantic-1"), {
            amount: "500.00", receivedAt: "2026-08-10T10:00:00.000Z", payerName: "Nok Dee",
        });
        const similar = await createPaymentIntake(context(actor, "semantic-2"), {
            amount: "500.00", receivedAt: "2026-08-10T10:03:00.000Z", payerName: " nok dee ",
        });
        expect(similar.duplicate).toBe(false);
        expect(similar.status).toBe("needs_review");
        expect(similar.warnings).toEqual([expect.objectContaining({ code: "POSSIBLE_SEMANTIC_DUPLICATE" })]);
        expect(await getPaymentIntake(context(actor), similar.publicId)).toMatchObject({
            status: "needs_review",
            warnings: [expect.objectContaining({ code: "POSSIBLE_SEMANTIC_DUPLICATE" })],
        });
        expect(await listPaymentIntakes(context(actor))).toEqual(expect.arrayContaining([
            expect.objectContaining({ publicId: similar.publicId, warnings: [expect.objectContaining({ code: "POSSIBLE_SEMANTIC_DUPLICATE" })] }),
        ]));
        expect(await db.select().from(paymentIntakes)).toHaveLength(2);
    });

    // Break caught: ambiguous confirmed nicknames or multiple exact obligations are auto-postable.
    integrationTest("auto-matches only one confirmed borrower and one exact obligation", async () => {
        const actor = await seedUser();
        const exact = await seedLoan({ actor, borrowerName: "Unique Customer", alias: "lek", schedules: [{ total: "100.00" }] });
        const intake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T10:00:00.000Z", payerName: "LEK",
        });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, {});
        expect(preview).toMatchObject({ version: 1, status: "ready", totalAllocated: "100.00" });
        expect(preview.allocations).toEqual([
            expect.objectContaining({ borrowerPublicId: exact.borrower.publicId, loanPublicId: exact.loan.publicId, amount: "100.00" }),
        ]);

        await seedLoan({ actor, borrowerName: "Other Customer", alias: "shared", schedules: [{ total: "100.00" }] });
        await seedLoan({ actor, borrowerName: "Third Customer", alias: "shared", schedules: [{ total: "100.00" }] });
        const ambiguous = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T12:00:00.000Z", payerName: "shared",
        });
        const ambiguousPreview = await previewPaymentMatch(context(actor), ambiguous.publicId, {});
        expect(ambiguousPreview.status).toBe("needs_review");
        expect(ambiguousPreview.warnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "AMBIGUOUS_BORROWER" }),
        ]));
    });

    // Break caught: split sums drift, UUID boundaries accept numeric IDs, or an advance cannot span schedules/borrowers.
    integrationTest("requires exact explicit sums and expands multi-borrower advance allocations by schedule", async () => {
        const actor = await seedUser();
        const first = await seedLoan({ actor, borrowerName: "First", schedules: [{ total: "40.00" }, { total: "60.00" }] });
        const second = await seedLoan({ actor, borrowerName: "Second", schedules: [{ total: "50.00" }] });
        const intake = await createPaymentIntake(context(actor), {
            amount: "120.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        const mismatch = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "119.99" }],
        });
        expect(mismatch).toMatchObject({ status: "needs_review", totalAllocated: "119.99" });
        expect(mismatch.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ALLOCATION_SUM_MISMATCH" })]));

        const repeated = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [
                { borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "70.00" },
                { borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "50.00" },
            ],
        });
        expect(repeated.status).toBe("needs_review");
        expect(repeated.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ALLOCATION_EXCEEDS_OBLIGATION" })]));

        const ready = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [
                { borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "70.00" },
                { borrowerPublicId: second.borrower.publicId, loanPublicId: second.loan.publicId, amount: "50.00" },
            ],
        });
        expect(ready).toMatchObject({ version: 3, status: "ready", totalAllocated: "120.00" });
        expect((await db.select().from(paymentMatchProposals).where(eq(paymentMatchProposals.paymentIntakeId,
            (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) }))!.id
        )).orderBy(paymentMatchProposals.version)).map((proposal) => proposal.status)).toEqual(["stale", "stale", "ready"]);
        expect(ready.allocations.map((row) => row.amount)).toEqual(["40.00", "30.00", "50.00"]);
        expect(new Set(ready.allocations.map((row) => row.borrowerPublicId)).size).toBe(2);
        expect((await getPaymentIntake(context(actor), intake.publicId)).latestProposal).toMatchObject({
            publicId: ready.publicId,
            totalAllocated: "120.00",
            allocations: [
                expect.objectContaining({ schedulePublicId: first.schedules[0]!.publicId, amount: "40.00" }),
                expect.objectContaining({ schedulePublicId: first.schedules[1]!.publicId, amount: "30.00" }),
                expect.objectContaining({ schedulePublicId: second.schedules[0]!.publicId, amount: "50.00" }),
            ],
        });

        await expect(previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: "1", loanPublicId: first.loan.publicId, amount: "120.00" }],
        })).rejects.toMatchObject({ code: "INVALID_PUBLIC_ID", status: 400 });
    });

    // Break caught: an owner-scoped collector allocates their intake to another collector's loan.
    integrationTest("enforces portfolio visibility on explicit payment targets", async () => {
        const collector = await seedUser("tenant-a", "collector");
        const otherCollector = await seedUser("tenant-a", "collector");
        const hidden = await seedLoan({ actor: otherCollector, borrowerName: "Hidden portfolio", schedules: [{ total: "25.00" }] });
        const intake = await createPaymentIntake(context(collector), {
            amount: "25.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });

        await expect(previewPaymentMatch(context(collector), intake.publicId, {
            allocations: [{ borrowerPublicId: hidden.borrower.publicId, loanPublicId: hidden.loan.publicId, amount: "25.00" }],
        })).rejects.toMatchObject({ code: "INVALID_PAYMENT_TARGET", status: 400 });
    });

    // Break caught: preview/review reads draft before waiting on a lock, then overwrites a concurrently posted status.
    integrationTest("rechecks intake state after acquiring the mutation lock", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Lock target", schedules: [{ total: "20.00" }] });
        for (const operation of ["preview", "review"] as const) {
            const intake = await createPaymentIntake(context(actor), {
                amount: "20.00", receivedAt: `2026-08-10T1${operation === "preview" ? "0" : "1"}:00:00.000Z`,
            });
            const stored = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
            let locked!: () => void;
            let release!: () => void;
            const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
            const mayCommit = new Promise<void>((resolve) => { release = resolve; });
            const blocker = db.transaction(async (tx) => {
                await tx.execute(sql`SELECT id FROM payment_intakes WHERE id = ${stored!.id} FOR UPDATE`);
                locked();
                await mayCommit;
                await tx.update(paymentIntakes).set({ status: "posted", postedAt: new Date() }).where(eq(paymentIntakes.id, stored!.id));
            });
            await lockHeld;
            const mutation = operation === "preview"
                ? previewPaymentMatch(context(actor), intake.publicId, {
                    allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "20.00" }],
                })
                : reviewPaymentIntake(context(actor), intake.publicId, { status: "draft" });
            await Bun.sleep(20);
            release();
            await blocker;
            await expect(mutation).rejects.toMatchObject({ code: "PAYMENT_INTAKE_IMMUTABLE", status: 409 });
            expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, stored!.id) }))
                .toMatchObject({ status: "posted" });
        }
    });

    // Break caught: posting trusts an old preview or permits two callers to create duplicate transactions.
    integrationTest("rejects stale previews and serializes concurrent double post", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Poster", schedules: [{ total: "100.00" }] });
        const staleIntake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        const stalePreview = await previewPaymentMatch(context(actor), staleIntake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "100.00" }],
        });
        await db.update(loanSchedules).set({ remainingDue: "90.00", updatedAt: new Date() })
            .where(eq(loanSchedules.id, seeded.schedules[0]!.id));
        await expect(postPayment(context(actor), staleIntake.publicId, { proposalPublicId: stalePreview.publicId }))
            .rejects.toMatchObject({ code: "STALE_PAYMENT_PROPOSAL", status: 409 });
        expect(await db.query.paymentMatchProposals.findFirst({ where: eq(paymentMatchProposals.publicId, stalePreview.publicId) }))
            .toMatchObject({ status: "stale" });

        const downgradedIntake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T10:30:00.000Z",
        });
        const downgradedPreview = await previewPaymentMatch(context(actor), downgradedIntake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "100.00" }],
        });
        await reviewPaymentIntake(context(actor), downgradedIntake.publicId, { status: "draft" });
        await expect(postPayment(context(actor), downgradedIntake.publicId, { proposalPublicId: downgradedPreview.publicId }))
            .rejects.toMatchObject({ code: "PAYMENT_NOT_READY", status: 409 });

        await db.update(loanSchedules).set({ remainingDue: "100.00", updatedAt: new Date() })
            .where(eq(loanSchedules.id, seeded.schedules[0]!.id));
        const liveIntake = await createPaymentIntake(context(actor), {
            amount: "100.00", receivedAt: "2026-08-10T11:00:00.000Z",
        });
        const livePreview = await previewPaymentMatch(context(actor), liveIntake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "100.00" }],
        });
        const [first, second] = await Promise.all([
            postPayment(context(actor), liveIntake.publicId, { proposalPublicId: livePreview.publicId }),
            postPayment(context(actor), liveIntake.publicId, { proposalPublicId: livePreview.publicId }),
        ]);
        expect(first).toEqual(second);
        expect(first.status).toBe("posted");
        expect(await db.select().from(transactions).where(eq(transactions.paymentIntakeId, (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, liveIntake.publicId) }))!.id))).toHaveLength(1);
    });

    // Break caught: posting fails to update schedules/loan/fund atomically or reversal mutates/deletes the original entries.
    integrationTest("posts partial payment effects and reverses them with compensating entries exactly once", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Funded", schedules: [{ total: "100.00" }], funded: true });
        const intake = await createPaymentIntake(context(actor), {
            amount: "40.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "40.00" }],
        });
        const posted = await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
        expect(posted.transactions).toEqual([expect.objectContaining({ amount: "40.00", principalComponent: "40.00", entryType: "repayment" })]);
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) }))
            .toMatchObject({ paidTotal: "40.00", remainingDue: "60.00" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ outstandingPrincipal: "60.00", status: "active" });
        expect(await db.select().from(fundLedgerEntries)).toEqual([
            expect.objectContaining({ entryType: "principal_return_in", amount: "40.00" }),
        ]);

        const reversed = await reversePayment(context(actor, "reverse-1"), intake.publicId, { reason: "Bank correction" });
        const retried = await reversePayment(context(actor, "reverse-2"), intake.publicId, { reason: "Bank correction" });
        expect(retried).toEqual(reversed);
        expect(reversed.status).toBe("reversed");
        expect(await db.select().from(transactions)).toEqual(expect.arrayContaining([
            expect.objectContaining({ amount: "40.00", entryType: "repayment", reversedTransactionId: null }),
            expect.objectContaining({ amount: "-40.00", entryType: "reversal" }),
        ]));
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) }))
            .toMatchObject({ paidTotal: "0.00", remainingDue: "100.00" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ outstandingPrincipal: "100.00", status: "active" });
        expect(await db.select().from(fundLedgerEntries)).toEqual(expect.arrayContaining([
            expect.objectContaining({ entryType: "principal_return_in", amount: "40.00" }),
            expect.objectContaining({ entryType: "principal_return_reversal_out", amount: "40.00" }),
        ]));
        expect((await db.select().from(fundLedgerEntries)).reduce((balance, entry) =>
            entry.entryType.endsWith("_out") ? balance.minus(entry.amount) : balance.plus(entry.amount), new Decimal(0)).toFixed(2)).toBe("0.00");
    });

    // Break caught: normalizing by funded subtotal credits 100% of a partially funded payment and ignores reallocation-out rows.
    integrationTest("credits only the economic funded share across net reallocated sources and reverses each fund to zero", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Partially funded", schedules: [{ total: "100.00" }] });
        const [firstProfile, secondProfile] = await db.insert(bankProfiles).values([
            { tenantId: actor.tenantId, name: "Fund A", type: "personal_savings" },
            { tenantId: actor.tenantId, name: "Fund B", type: "personal_savings" },
        ]).returning();
        await db.insert(loanFundingAllocations).values([
            { tenantId: actor.tenantId, loanId: seeded.loan.id, bankProfileId: firstProfile!.id, allocatedAmount: "40.00", allocationDate: "2026-08-01", allocationType: "initial" },
            { tenantId: actor.tenantId, loanId: seeded.loan.id, bankProfileId: firstProfile!.id, allocatedAmount: "-10.00", allocationDate: "2026-08-02", allocationType: "reallocation_out" },
            { tenantId: actor.tenantId, loanId: seeded.loan.id, bankProfileId: secondProfile!.id, allocatedAmount: "20.00", allocationDate: "2026-08-02", allocationType: "reallocation_in" },
        ]);
        const intake = await createPaymentIntake(context(actor), { amount: "1.01", receivedAt: "2026-08-10T10:00:00.000Z" });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, { allocations: [{
            borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "1.01",
        }] });
        await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });

        const credits = await db.select().from(fundLedgerEntries);
        expect(credits.map((entry) => ({ profile: entry.bankProfileId, amount: entry.amount }))).toEqual([
            { profile: firstProfile!.id, amount: "0.30" },
            { profile: secondProfile!.id, amount: "0.21" },
        ]);
        expect(credits.reduce((sum, entry) => sum.plus(entry.amount), new Decimal(0)).toFixed(2)).toBe("0.51");

        await reversePayment(context(actor), intake.publicId, { reason: "Bank correction" });
        const allEntries = await db.select().from(fundLedgerEntries);
        for (const profile of [firstProfile!, secondProfile!]) {
            expect(allEntries.filter((entry) => entry.bankProfileId === profile.id).reduce((sum, entry) =>
                entry.entryType.endsWith("_out") ? sum.minus(entry.amount) : sum.plus(entry.amount), new Decimal(0)).toFixed(2)).toBe("0.00");
        }
    });

    // Break caught: a downstream fund-ledger insert can commit schedule/transaction effects before surfacing its failure.
    integrationTest("rolls back every posting effect when fund-ledger persistence fails", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Atomic payer", schedules: [{ total: "100.00" }], funded: true });
        const intake = await createPaymentIntake(context(actor), { amount: "40.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, { allocations: [{
            borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "40.00",
        }] });
        await db.execute(sql`CREATE OR REPLACE FUNCTION fail_payment_ledger_insert() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'injected ledger failure'; END $$`);
        await db.execute(sql`CREATE TRIGGER fail_payment_ledger_insert BEFORE INSERT ON fund_ledger_entries
            FOR EACH ROW EXECUTE FUNCTION fail_payment_ledger_insert()`);
        try {
            await expect(postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId }))
                .rejects.toMatchObject({ cause: expect.objectContaining({ message: "injected ledger failure" }) });
            expect(await db.select().from(transactions)).toHaveLength(0);
            expect(await db.select().from(fundLedgerEntries)).toHaveLength(0);
            expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) }))
                .toMatchObject({ paidTotal: "0.00", remainingDue: "100.00" });
            expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) }))
                .toMatchObject({ status: "ready", postedAt: null });
        } finally {
            await db.execute(sql`DROP TRIGGER IF EXISTS fail_payment_ledger_insert ON fund_ledger_entries`);
            await db.execute(sql`DROP FUNCTION IF EXISTS fail_payment_ledger_insert()`);
        }
    });

    // Break caught: grouped reversal marks allocations from superseded proposals reversed even though they were never posted.
    integrationTest("reverses only the posted grouped proposal and remains idempotent", async () => {
        const actor = await seedUser();
        const first = await seedLoan({ actor, borrowerName: "Grouped A", schedules: [{ total: "40.00" }] });
        const second = await seedLoan({ actor, borrowerName: "Grouped B", schedules: [{ total: "60.00" }] });
        const intake = await createPaymentIntake(context(actor), { amount: "60.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        const superseded = await previewPaymentMatch(context(actor), intake.publicId, { allocations: [
            { borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "20.00" },
            { borrowerPublicId: second.borrower.publicId, loanPublicId: second.loan.publicId, amount: "40.00" },
        ] });
        const postedProposal = await previewPaymentMatch(context(actor), intake.publicId, { allocations: [
            { borrowerPublicId: first.borrower.publicId, loanPublicId: first.loan.publicId, amount: "30.00" },
            { borrowerPublicId: second.borrower.publicId, loanPublicId: second.loan.publicId, amount: "30.00" },
        ] });
        await postPayment(context(actor), intake.publicId, { proposalPublicId: postedProposal.publicId });
        const reversed = await reversePayment(context(actor), intake.publicId, { reason: "Bank correction" });
        expect(await reversePayment(context(actor), intake.publicId, { reason: "Bank correction" })).toEqual(reversed);
        expect(reversed.transactions).toHaveLength(4);
        const proposals = await db.select().from(paymentMatchProposals).where(eq(paymentMatchProposals.paymentIntakeId,
            (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) }))!.id
        ));
        const allocationStatuses = async (proposalPublicId: string) => {
            const proposal = proposals.find((row) => row.publicId === proposalPublicId)!;
            return (await db.select().from(paymentMatchAllocations).where(eq(paymentMatchAllocations.proposalId, proposal.id)))
                .map((row) => row.status);
        };
        expect(await allocationStatuses(superseded.publicId)).toEqual(["proposed", "proposed"]);
        expect(await allocationStatuses(postedProposal.publicId)).toEqual(["reversed", "reversed"]);
    });

    // Break caught: reversing an older payment after a newer one rewrites component attribution for the wrong balance state.
    integrationTest("rejects out-of-order reversal when a later repayment remains posted", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Ordered payer", schedules: [{ total: "100.00" }] });
        const postAmount = async (amount: string, receivedAt: string) => {
            const intake = await createPaymentIntake(context(actor), { amount, receivedAt });
            const preview = await previewPaymentMatch(context(actor), intake.publicId, {
                allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount }],
            });
            await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
            return intake;
        };
        const first = await postAmount("40.00", "2026-08-10T10:00:00.000Z");
        await postAmount("10.00", "2026-08-10T10:10:00.000Z");

        await expect(reversePayment(context(actor), first.publicId, { reason: "Bank correction" }))
            .rejects.toMatchObject({ code: "REVERSAL_NOT_LATEST", status: 409 });
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) }))
            .toMatchObject({ paidTotal: "50.00", remainingDue: "50.00" });
    });

    // Break caught: fixed late fees are omitted from preview/post or paid through floating point.
    integrationTest("allocates current penalty before mixed schedule components", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({
            actor,
            borrowerName: "Late payer",
            schedules: [{ total: "100.00", principal: "70.00", interest: "20.00", fee: "10.00", dueDate: "2026-08-01" }],
            lateFeeMode: "fixed",
            lateFeeAmount: "15.00",
        });
        const intake = await createPaymentIntake(context(actor), {
            amount: "45.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "45.00" }],
        });
        expect(preview.status).toBe("ready");
        const posted = await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
        expect(posted.transactions).toEqual([
            expect.objectContaining({ penaltyComponent: "15.00", feeComponent: "10.00", interestComponent: "20.00", principalComponent: "0.00" }),
        ]);
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) }))
            .toMatchObject({ paidPenalty: "15.00", paidTotal: "30.00", remainingDue: "70.00", status: "overdue", overdueDays: 9 });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ outstandingFees: "0.00", outstandingInterest: "0.00", outstandingPrincipal: "70.00" });
    });

    // Break caught: payment/reversal hard-code pending and leave a stale loan nextDueDate after payoff.
    integrationTest("preserves multi-schedule receipt-date lifecycle and clears/restores next due dates", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({
            actor,
            borrowerName: "Lifecycle payer",
            schedules: [
                { total: "30.00", principal: "10.00", interest: "10.00", fee: "10.00", dueDate: "2026-08-01" },
                { total: "70.00", principal: "70.00", dueDate: "2026-09-10" },
            ],
            lateFeeMode: "fixed",
            lateFeeAmount: "5.00",
            nextDueDate: "2026-08-01",
        });
        const intake = await createPaymentIntake(context(actor), { amount: "45.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, { allocations: [{
            borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "45.00",
        }] });
        const posted = await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
        expect(posted.transactions).toEqual([
            expect.objectContaining({ penaltyComponent: "5.00", feeComponent: "10.00", interestComponent: "10.00", principalComponent: "10.00" }),
            expect.objectContaining({ penaltyComponent: "0.00", feeComponent: "0.00", interestComponent: "0.00", principalComponent: "10.00" }),
        ]);
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, seeded.loan.id)).orderBy(loanSchedules.installmentNo)).toEqual([
            expect.objectContaining({ remainingDue: "0.00", status: "paid", overdueDays: 0 }),
            expect.objectContaining({ remainingDue: "60.00", status: "partial", overdueDays: 0 }),
        ]);
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ nextDueDate: "2026-09-10", status: "active" });

        await reversePayment(context(actor), intake.publicId, { reason: "Bank correction" });
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, seeded.loan.id)).orderBy(loanSchedules.installmentNo)).toEqual([
            expect.objectContaining({ remainingDue: "30.00", status: "overdue", overdueDays: 9 }),
            expect.objectContaining({ remainingDue: "70.00", status: "pending", overdueDays: 0 }),
        ]);
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ nextDueDate: "2026-08-01", status: "active" });

        const payoff = await createPaymentIntake(context(actor), { amount: "105.00", receivedAt: "2026-08-10T11:00:00.000Z" });
        const payoffPreview = await previewPaymentMatch(context(actor), payoff.publicId, { allocations: [{
            borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "105.00",
        }] });
        await postPayment(context(actor), payoff.publicId, { proposalPublicId: payoffPreview.publicId });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ nextDueDate: null, status: "paid" });
        await reversePayment(context(actor), payoff.publicId, { reason: "Bank correction" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) }))
            .toMatchObject({ nextDueDate: "2026-08-01", status: "active" });
    });

    // Break caught: finalize trusts client URLs/metadata or accepts another tenant's object/hash.
    integrationTest("prepares a tenant-owned signed PUT and finalizes only matching object metadata and checksum", async () => {
        const actor = await seedUser();
        const intake = await createPaymentIntake(context(actor), {
            amount: "50.00", receivedAt: "2026-08-10T10:00:00.000Z",
        });
        let captured: SignedPutRequest | undefined;
        const gateway: EvidenceStorageGateway = {
            preparePut: async (request) => {
                captured = request;
                return { uploadUrl: "https://storage.example.test/signed", expiresAt: new Date(Date.now() + 60_000) };
            },
            head: async () => ({
                exists: true,
                contentType: "image/png",
                contentLength: 12,
                checksumSha256: "a".repeat(64),
                metadata: {
                    tenant: "tenant-a",
                    intake: intake.publicId,
                },
            }),
        };
        const intent = await preparePaymentEvidence(context(actor), intake.publicId, {
            mimeType: "image/png", size: 12, sha256: "a".repeat(64),
        }, gateway);
        expect(intent.uploadUrl).toStartWith("https://storage.example.test/");
        expect(intent.objectKey).toStartWith(`payment-evidence/tenant-a/${intake.publicId}/`);
        expect(captured).toMatchObject({ contentType: "image/png", contentLength: 12, checksumSha256: "a".repeat(64) });
        const retriedIntent = await preparePaymentEvidence(context(actor), intake.publicId, {
            mimeType: "image/png", size: 12, sha256: "a".repeat(64),
        }, gateway);
        expect(retriedIntent).toMatchObject({ publicId: intent.publicId, objectKey: intent.objectKey });

        const finalized = await finalizePaymentEvidence(context(actor), intake.publicId, intent.publicId, gateway);
        expect(finalized).toMatchObject({ status: "ready", sha256: "a".repeat(64) });
        const file = await db.query.files.findFirst({ where: eq(files.publicId, finalized.filePublicId as string) });
        expect(file).toMatchObject({ tenantId: "tenant-a", mimeType: "image/png", size: 12 });
        expect(await getPaymentIntake(context(actor), intake.publicId)).toMatchObject({
            evidence: [expect.objectContaining({
                publicId: intent.publicId,
                filePublicId: finalized.filePublicId,
                mimeType: "image/png",
                status: "ready",
            })],
        });

        const concurrentIntake = await createPaymentIntake(context(actor), {
            amount: "60.00", receivedAt: "2026-08-10T10:30:00.000Z",
        });
        let releaseHeads!: () => void;
        const bothHeadsReached = new Promise<void>((resolve) => { releaseHeads = resolve; });
        let headCalls = 0;
        const concurrentGateway: EvidenceStorageGateway = {
            preparePut: gateway.preparePut,
            head: async () => {
                headCalls += 1;
                if (headCalls === 2) releaseHeads();
                await bothHeadsReached;
                return {
                    exists: true, contentType: "image/png", contentLength: 12,
                    checksumSha256: "b".repeat(64),
                    metadata: { tenant: "tenant-a", intake: concurrentIntake.publicId },
                };
            },
        };
        const concurrentIntent = await preparePaymentEvidence(context(actor), concurrentIntake.publicId, {
            mimeType: "image/png", size: 12, sha256: "b".repeat(64),
        }, concurrentGateway);
        const concurrentFinalized = await Promise.all([
            finalizePaymentEvidence(context(actor), concurrentIntake.publicId, concurrentIntent.publicId, concurrentGateway),
            finalizePaymentEvidence(context(actor), concurrentIntake.publicId, concurrentIntent.publicId, concurrentGateway),
        ]);
        expect(concurrentFinalized[0]).toEqual(concurrentFinalized[1]);
        expect(concurrentFinalized[0]?.status).toBe("ready");

        const expiringIntake = await createPaymentIntake(context(actor), {
            amount: "61.00", receivedAt: "2026-08-10T10:40:00.000Z",
        });
        const expiringIntent = await preparePaymentEvidence(context(actor), expiringIntake.publicId, {
            mimeType: "image/png", size: 12, sha256: "f".repeat(64),
        }, gateway);
        await db.update(paymentEvidence).set({ uploadExpiresAt: new Date(Date.now() - 1) })
            .where(eq(paymentEvidence.publicId, expiringIntent.publicId));
        const replacementIntake = await createPaymentIntake(context(actor), {
            amount: "62.00", receivedAt: "2026-08-10T10:50:00.000Z",
        });
        const replacementIntent = await preparePaymentEvidence(context(actor), replacementIntake.publicId, {
            mimeType: "image/png", size: 12, sha256: "f".repeat(64),
        }, gateway);
        expect(replacementIntent.publicId).not.toBe(expiringIntent.publicId);
        expect(replacementIntent.objectKey).toContain(replacementIntake.publicId);
        expect(await db.select().from(paymentEvidence).where(eq(paymentEvidence.evidenceHash, "f".repeat(64)))).toHaveLength(1);

        await expect(preparePaymentEvidence(context(actor), intake.publicId, {
            mimeType: "text/html", size: 12, sha256: "c".repeat(64),
        }, gateway)).rejects.toMatchObject({ code: "INVALID_EVIDENCE", status: 400 });

        await expect(preparePaymentEvidence(context(actor), intake.publicId, {
            mimeType: "image/png", size: 12, sha256: "d".repeat(64),
        }, { ...gateway, preparePut: async () => { throw new Error("signing unavailable"); } })).rejects.toThrow("signing unavailable");
        expect(await db.query.paymentEvidence.findFirst({ where: eq(paymentEvidence.evidenceHash, "d".repeat(64)) })).toBeUndefined();

        const duplicateIntake = await createPaymentIntake(context(actor), {
            amount: "50.00", receivedAt: "2026-08-10T11:00:00.000Z",
        });
        const duplicateEvidence = await preparePaymentEvidence(context(actor), duplicateIntake.publicId, {
            mimeType: "image/png", size: 12, sha256: "a".repeat(64),
        }, gateway);
        expect(duplicateEvidence).toMatchObject({
            duplicate: true,
            duplicateReason: "evidence_sha256",
            intakePublicId: intake.publicId,
        });
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, duplicateIntake.publicId) }))
            .toMatchObject({ status: "duplicate", duplicateOfIntakeId: expect.any(Number) });
        expect(JSON.stringify(await db.select().from(auditLogs))).not.toContain("signed");
    });

    // Break caught: a duplicate-evidence prepare that races posting must never rewrite posted -> duplicate.
    integrationTest("rechecks evidence immutability under the intake row lock", async () => {
        const actor = await seedUser();
        const original = await createPaymentIntake(context(actor), { amount: "20.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        const target = await createPaymentIntake(context(actor), { amount: "21.00", receivedAt: "2026-08-10T11:00:00.000Z" });
        const checksum = "e".repeat(64);
        const gateway: EvidenceStorageGateway = {
            preparePut: async () => ({ uploadUrl: "https://storage.example.test/signed", expiresAt: new Date(Date.now() + 60_000) }),
            head: async () => ({
                exists: true, contentType: "image/png", contentLength: 12, checksumSha256: checksum,
                metadata: { tenant: "tenant-a", intake: original.publicId },
            }),
        };
        const intent = await preparePaymentEvidence(context(actor), original.publicId, {
            mimeType: "image/png", size: 12, sha256: checksum,
        }, gateway);
        await finalizePaymentEvidence(context(actor), original.publicId, intent.publicId, gateway);

        let releaseLock!: () => void;
        let reportLocked!: () => void;
        const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const transition = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM payment_intakes WHERE public_id = ${target.publicId} FOR UPDATE`);
            reportLocked();
            await release;
            await tx.update(paymentIntakes).set({ status: "posted", postedAt: new Date() })
                .where(eq(paymentIntakes.publicId, target.publicId));
        });
        await locked;
        const attempt = preparePaymentEvidence(context(actor), target.publicId, {
            mimeType: "image/png", size: 12, sha256: checksum,
        }, gateway);
        const settled = attempt.then(() => null, (error) => error);
        await new Promise((resolve) => setTimeout(resolve, 20));
        releaseLock();
        await transition;
        expect(await settled).toMatchObject({ code: "PAYMENT_INTAKE_IMMUTABLE", status: 409 });
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, target.publicId) }))
            .toMatchObject({ status: "posted", duplicateOfIntakeId: null });
    });

    // Break caught: finalization reconstructs expiry from environment TTL instead of the signer's returned timestamp.
    integrationTest("rejects every evidence HEAD mismatch and the exact signer-returned expiry", async () => {
        const actor = await seedUser();
        const mismatchCases: Array<{ name: string; head: StoredObjectHead }> = [
            { name: "missing", head: { exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} } },
            { name: "tenant", head: { exists: true, contentType: "image/png", contentLength: 12, checksumSha256: "1".repeat(64), metadata: { tenant: "wrong", intake: "set-later" } } },
            { name: "intake", head: { exists: true, contentType: "image/png", contentLength: 12, checksumSha256: "2".repeat(64), metadata: { tenant: "tenant-a", intake: "wrong" } } },
            { name: "mime", head: { exists: true, contentType: "image/jpeg", contentLength: 12, checksumSha256: "3".repeat(64), metadata: { tenant: "tenant-a", intake: "set-later" } } },
            { name: "size", head: { exists: true, contentType: "image/png", contentLength: 13, checksumSha256: "4".repeat(64), metadata: { tenant: "tenant-a", intake: "set-later" } } },
            { name: "checksum", head: { exists: true, contentType: "image/png", contentLength: 12, checksumSha256: "0".repeat(64), metadata: { tenant: "tenant-a", intake: "set-later" } } },
        ];
        for (const [index, mismatch] of mismatchCases.entries()) {
            const intake = await createPaymentIntake(context(actor), { amount: `${70 + index}.00`, receivedAt: `2026-08-10T1${index}:00:00.000Z` });
            const checksum = String(index + 1).repeat(64);
            const head = { ...mismatch.head, metadata: {
                ...mismatch.head.metadata,
                ...(mismatch.head.metadata.intake === "set-later" ? { intake: intake.publicId } : {}),
            } };
            const gateway: EvidenceStorageGateway = {
                preparePut: async () => ({ uploadUrl: "https://storage.example.test/signed", expiresAt: new Date(Date.now() + 1_000) }),
                head: async () => head,
            };
            const intent = await preparePaymentEvidence(context(actor), intake.publicId, { mimeType: "image/png", size: 12, sha256: checksum }, gateway);
            await expect(finalizePaymentEvidence(context(actor), intake.publicId, intent.publicId, gateway))
                .rejects.toMatchObject({ code: "EVIDENCE_METADATA_MISMATCH", status: 409 });
        }

        const expiredIntake = await createPaymentIntake(context(actor), { amount: "80.00", receivedAt: "2026-08-10T18:00:00.000Z" });
        const expiredGateway: EvidenceStorageGateway = {
            preparePut: async () => ({ uploadUrl: "https://storage.example.test/signed", expiresAt: new Date(Date.now() + 20) }),
            head: async () => ({
                exists: true, contentType: "image/png", contentLength: 12, checksumSha256: "9".repeat(64),
                metadata: { tenant: "tenant-a", intake: expiredIntake.publicId },
            }),
        };
        const expiredIntent = await preparePaymentEvidence(context(actor), expiredIntake.publicId, {
            mimeType: "image/png", size: 12, sha256: "9".repeat(64),
        }, expiredGateway);
        await new Promise((resolve) => setTimeout(resolve, 30));
        await expect(finalizePaymentEvidence(context(actor), expiredIntake.publicId, expiredIntent.publicId, expiredGateway))
            .rejects.toMatchObject({ code: "EVIDENCE_UPLOAD_EXPIRED", status: 409 });
    });

    // Break caught: a delayed signer can return a live upload capability after the intake becomes posted.
    integrationTest("does not return a newly signed evidence capability after posting wins the race", async () => {
        const actor = await seedUser();
        const seeded = await seedLoan({ actor, borrowerName: "Signing race", schedules: [{ total: "10.00" }] });
        const intake = await createPaymentIntake(context(actor), { amount: "10.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        const preview = await previewPaymentMatch(context(actor), intake.publicId, { allocations: [{
            borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "10.00",
        }] });
        let signerEntered!: () => void;
        let releaseSigner!: () => void;
        const entered = new Promise<void>((resolve) => { signerEntered = resolve; });
        const release = new Promise<void>((resolve) => { releaseSigner = resolve; });
        const gateway: EvidenceStorageGateway = {
            preparePut: async () => {
                signerEntered();
                await release;
                return { uploadUrl: "https://storage.example.test/signed", expiresAt: new Date(Date.now() + 60_000) };
            },
            head: async () => ({ exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} }),
        };
        const preparing = preparePaymentEvidence(context(actor), intake.publicId, {
            mimeType: "image/png", size: 12, sha256: "8".repeat(64),
        }, gateway);
        const settled = preparing.then((value) => value, (error) => error);
        await entered;
        await postPayment(context(actor), intake.publicId, { proposalPublicId: preview.publicId });
        releaseSigner();
        expect(await settled).toMatchObject({ code: "PAYMENT_INTAKE_IMMUTABLE", status: 409 });
    });

    // Break caught: list/get leak numeric keys or records owned by another tenant.
    integrationTest("lists and gets intake DTOs with UUIDs and Decimal-safe strings", async () => {
        const actor = await seedUser();
        const other = await seedUser("tenant-b");
        const own = await createPaymentIntake(context(actor), { amount: "10.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        await createPaymentIntake(context(other), { amount: "99.00", receivedAt: "2026-08-10T10:00:00.000Z" });
        expect(await getPaymentIntake(context(actor), own.publicId)).toMatchObject({ publicId: own.publicId, amount: "10.00" });
        expect(await listPaymentIntakes(context(actor), {})).toEqual([expect.objectContaining({ publicId: own.publicId, amount: "10.00" })]);
        expect(JSON.stringify(await listPaymentIntakes(context(actor), {}))).not.toContain('"id":1');
    });
});
