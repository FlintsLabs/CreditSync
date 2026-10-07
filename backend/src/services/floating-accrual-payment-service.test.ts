import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, floatingTransactionAllocations, loanInterestAccruals, loanInterestRatePeriods, loans, paymentIntakes, paymentMatchFloatingTargets, paymentMatchProposals, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createBorrower } from "./borrower-service";
import { activateLoan, createLoanDraft, getLoanApplication } from "./loan-application-service";
import { postFloatingAccrualPayment, previewFloatingAccrualPayment } from "./floating-accrual-payment-service";
import { createPaymentIntake, previewPaymentMatch, reversePayment } from "./payment-service";
import { lockPaymentWorkflowTenant } from "./payment-workflow-locks";
import { getLoanAccrualReceiptHistory } from "./loan-accrual-history-service";
import { accrueFloatingInterestThrough } from "./floating-interest-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
function context(user: { id: number; tenantId: string }, key: string = crypto.randomUUID()): CommandContext {
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "web", requestId: `req-${key}`, correlationId: `corr-${key}`, idempotencyKey: key };
}
async function seed(input: { fixedPenalty?: string; principal?: string; rate?: string; firstDayTreatment?: "deduct" | "start_next_day" } = {}) {
    const tenantId = `selected-accrual-${crypto.randomUUID()}`;
    const user = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const ctx = context(user, "loan-create");
    const borrower = await createBorrower(ctx, { name: "Selected Accrual Borrower" });
    const draft = await createLoanDraft(ctx, {
        borrowerPublicId: borrower.publicId, principal: input.principal ?? "4000.00", interestRate: "0.00", repaymentType: "floating",
        termMonths: 1, startDate: "2026-09-30",
        floatingDailyInterest: { mode: "percent", rate: input.rate ?? "2.0000", firstDayTreatment: input.firstDayTreatment ?? "start_next_day", accrualCycle: "daily" },
    });
    if (input.fixedPenalty) await db.update(loans).set({ lateFeeMode: "fixed", lateFeeAmount: input.fixedPenalty, gracePeriodDays: 0 }).where(eq(loans.publicId, draft.publicId));
    await activateLoan(ctx, draft.publicId);
    return { user, borrower, loan: draft };
}
async function previewAndPost(seeded: Awaited<ReturnType<typeof seed>>, input: { amount: string; receivedAt: string; targets: Array<{ accrualDate: string; amount: string }> }, key: string) {
    const ctx = context(seeded.user, key);
    const preview = await previewFloatingAccrualPayment(ctx, seeded.loan.publicId, input);
    expect(preview.status).toBe("ready");
        return { preview, posted: await postFloatingAccrualPayment(ctx, seeded.loan.publicId, { paymentIntakePublicId: preview.paymentIntakePublicId!, proposalPublicId: preview.publicId!, confirmed: true }) };
}

describe("selected floating daily accrual receipts", () => {
    afterEach(() => setSystemTime());
    if (process.env.TEST_DATABASE_URL) beforeEach(async () => {
        setSystemTime(new Date("2026-10-10T12:00:00+07:00"));
        await db.execute(sql`SET client_min_messages TO WARNING`);
        await db.execute(sql`TRUNCATE TABLE loans, borrowers, users RESTART IDENTITY CASCADE`);
    });

    integrationTest("example 1 keeps the following accrual unpaid", async () => {
        const seeded = await seed();
        await previewAndPost(seeded, { amount: "80.00", receivedAt: "2026-10-01T09:00:00+07:00", targets: [{ accrualDate: "2026-10-01", amount: "80.00" }] }, "receipt-oct-1");
        await previewAndPost(seeded, { amount: "80.00", receivedAt: "2026-10-03T10:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] }, "receipt-oct-3-target-2");
        const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, seeded.user.tenantId), eq(loans.publicId, seeded.loan.publicId)) });
        const rows = await db.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, seeded.user.tenantId), eq(loanInterestAccruals.loanId, loan!.id)));
        expect(rows.find((row) => row.accrualDate === "2026-10-02")?.paidAmount).toBe("80.00");
        expect(new Decimal(rows.find((row) => row.accrualDate === "2026-10-03")!.paidAmount).toFixed(2)).toBe("0.00");
    });

    integrationTest("refreshes cached materialized interest across later and historical selected receipts", async () => {
        const seeded = await seed({ principal: "4000.00", rate: "2.0000" });
        const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, seeded.user.tenantId), eq(loans.publicId, seeded.loan.publicId)) });
        await accrueFloatingInterestThrough(db, loan!, new Date("2026-10-05T23:59:59+07:00"), context(seeded.user, "materialize-oct-5"));
        const principalBefore = loan!.outstandingPrincipal;
        const feesBefore = loan!.outstandingFees;
        await previewAndPost(seeded, { amount: "80.00", receivedAt: "2026-10-05T12:00:00+07:00", targets: [{ accrualDate: "2026-10-05", amount: "80.00" }] }, "selected-oct-5-cache");
        let current = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, seeded.user.tenantId), eq(loans.publicId, seeded.loan.publicId)) });
        expect(current?.outstandingInterest).toBe("320.00");
        await previewAndPost(seeded, { amount: "80.00", receivedAt: "2026-10-03T12:00:00+07:00", targets: [{ accrualDate: "2026-10-01", amount: "80.00" }] }, "selected-oct-3-cache");
        current = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, seeded.user.tenantId), eq(loans.publicId, seeded.loan.publicId)) });
        expect(current?.outstandingInterest).toBe("240.00");
        expect(current?.outstandingPrincipal).toBe(principalBefore);
        expect(current?.outstandingFees).toBe(feesBefore);
    });

    integrationTest("examples 2 and 5 accept later-day-first and disjoint historical receipts", async () => {
        const seeded = await seed();
        const later = await previewAndPost(seeded, { amount: "80.00", receivedAt: "2026-10-05T11:00:00+07:00", targets: [{ accrualDate: "2026-10-05", amount: "80.00" }] }, "receipt-oct-5-target-5");
        const older = await previewAndPost(seeded, { amount: "80.00", receivedAt: "2026-10-07T12:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] }, "receipt-oct-7-target-2");
        const historical = await previewAndPost(seeded, { amount: "80.00", receivedAt: "2026-10-03T13:00:00+07:00", targets: [{ accrualDate: "2026-10-03", amount: "80.00" }] }, "receipt-historical-oct-3");
        const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, seeded.user.tenantId), eq(loans.publicId, seeded.loan.publicId)) });
        const rows = await db.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, seeded.user.tenantId), eq(loanInterestAccruals.loanId, loan!.id)));
        expect(rows.find((row) => row.accrualDate === "2026-10-02")?.paidAmount).toBe("80.00");
        expect(rows.find((row) => row.accrualDate === "2026-10-03")?.paidAmount).toBe("80.00");
        expect(rows.find((row) => row.accrualDate === "2026-10-05")?.paidAmount).toBe("80.00");
        const laterIntake = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, later.preview.paymentIntakePublicId) });
        const olderIntake = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, older.preview.paymentIntakePublicId) });
        const historicalIntake = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, historical.preview.paymentIntakePublicId) });
        const actualTransactions = await db.select().from(transactions).where(and(eq(transactions.paymentIntakeId, laterIntake!.id)));
        const olderTransactions = await db.select().from(transactions).where(and(eq(transactions.paymentIntakeId, olderIntake!.id)));
        const historicalTransactions = await db.select().from(transactions).where(and(eq(transactions.paymentIntakeId, historicalIntake!.id)));
        expect(actualTransactions[0]!.transactionDate!.toISOString()).toBe(new Date("2026-10-05T11:00:00+07:00").toISOString());
        expect(olderTransactions[0]!.transactionDate!.toISOString()).toBe(new Date("2026-10-07T12:00:00+07:00").toISOString());
        expect(historicalTransactions[0]!.transactionDate!.toISOString()).toBe(new Date("2026-10-03T13:00:00+07:00").toISOString());
        const allocations = await db.select().from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, seeded.user.tenantId), eq(floatingTransactionAllocations.loanId, loan!.id), eq(floatingTransactionAllocations.entryType, "payment")));
        expect(allocations.map((row) => [row.dueDate, row.amount])).toContainEqual(["2026-10-05", "80.00"]);
        expect(allocations.map((row) => [row.dueDate, row.effectiveDate])).toContainEqual(["2026-10-02", "2026-10-07"]);
    });

    integrationTest("supports nonconsecutive targets and partial receipts without moving money", async () => {
        const seeded = await seed();
        const grouped = await previewAndPost(seeded, { amount: "160.00", receivedAt: "2026-10-05T14:00:00+07:00", targets: [{ accrualDate: "2026-10-04", amount: "80.00" }, { accrualDate: "2026-10-02", amount: "80.00" }] }, "grouped-targets");
        expect(grouped.posted.transactions[0].interestComponent).toBe("160.00");
        const firstPartial = await previewAndPost(seeded, { amount: "30.00", receivedAt: "2026-10-06T10:00:00+07:00", targets: [{ accrualDate: "2026-10-06", amount: "30.00" }] }, "partial-30");
        await previewAndPost(seeded, { amount: "50.00", receivedAt: "2026-10-07T10:00:00+07:00", targets: [{ accrualDate: "2026-10-06", amount: "50.00" }] }, "partial-50");
        const paid = await db.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, seeded.user.tenantId), eq(loanInterestAccruals.accrualDate, "2026-10-06")));
        expect(paid[0]?.paidAmount).toBe("80.00");
        expect(paid[0]?.status).toBe("paid");
        expect(await db.select().from(paymentMatchFloatingTargets)).toHaveLength(4);
        const receiptHistory = await getLoanAccrualReceiptHistory(context(seeded.user), seeded.loan.publicId);
        expect(receiptHistory.find((row) => row.accrualDate === "2026-10-06")?.receipts.map((receipt) => receipt.amount).sort()).toEqual(["30.00", "50.00"]);
        expect(receiptHistory.find((row) => row.accrualDate === "2026-10-06")?.receipts.map((receipt) => receipt.receivedAt).sort()).toEqual([
            new Date("2026-10-06T10:00:00+07:00").toISOString(), new Date("2026-10-07T10:00:00+07:00").toISOString(),
        ]);
        expect(receiptHistory.find((row) => row.accrualDate === "2026-10-06")?.receipts[0]?.href).toBe(`/payments?intake=${firstPartial.preview.paymentIntakePublicId}&loanId=${seeded.loan.publicId}`);
        const detail = await getLoanApplication(context(seeded.user), seeded.loan.publicId, { projectedAccrualsAsOf: new Date("2026-10-07T12:00:00+07:00") }) as unknown as { accruals: Array<{ accrualDate: string; receiptHistory?: unknown[] }> };
        expect(detail.accruals.find((row) => row.accrualDate === "2026-10-06")?.receiptHistory).toHaveLength(2);
        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.loan.publicId) });
        expect((await db.select().from(transactions).where(eq(transactions.loanId, loan!.id))).every((row) => row.principalComponent === "0.00")).toBe(true);
    });

    integrationTest("binds every command key to a canonical payload even when the draft UUID is supplied", async () => {
        const seeded = await seed();
        const ctx = context(seeded.user, "preview-command-binding");
        const payload = { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] };
        const first = await previewFloatingAccrualPayment(ctx, seeded.loan.publicId, payload);
        const replay = await previewFloatingAccrualPayment(ctx, seeded.loan.publicId, { ...payload, paymentIntakePublicId: first.paymentIntakePublicId });
        expect(replay.publicId).toBe(first.publicId);
        await expect(previewFloatingAccrualPayment(ctx, seeded.loan.publicId, { ...payload, paymentIntakePublicId: first.paymentIntakePublicId, amount: "40.00", targets: [{ accrualDate: "2026-10-02", amount: "40.00" }] })).rejects.toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        await expect(previewFloatingAccrualPayment(context(seeded.user, "preview-command-binding"), seeded.loan.publicId, { ...payload, receivedAt: "2026-10-02T10:00:00+07:00" })).rejects.toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        const next = await previewFloatingAccrualPayment(context(seeded.user, "preview-command-edit-2"), seeded.loan.publicId, { ...payload, paymentIntakePublicId: first.paymentIntakePublicId, amount: "40.00", targets: [{ accrualDate: "2026-10-02", amount: "40.00" }] });
        expect(next.paymentIntakePublicId).toBe(first.paymentIntakePublicId);
        expect(next.publicId).not.toBe(first.publicId);
    });

    integrationTest("rechecks portfolio authorization before returning a saved preview command", async () => {
        const seeded = await seed();
        await db.update(users).set({ role: "viewer" }).where(eq(users.id, seeded.user.id));
        await db.update(loans).set({ ownerUserId: seeded.user.id }).where(eq(loans.publicId, seeded.loan.publicId));
        await db.execute(sql`UPDATE borrowers SET owner_user_id = ${seeded.user.id} WHERE tenant_id = ${seeded.user.tenantId} AND public_id = ${seeded.borrower.publicId}`);
        const ctx = context(seeded.user, "portfolio-command-replay");
        const payload = { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] };
        const first = await previewFloatingAccrualPayment(ctx, seeded.loan.publicId, payload);
        await db.update(loans).set({ ownerUserId: null }).where(eq(loans.publicId, seeded.loan.publicId));
        await expect(previewFloatingAccrualPayment(ctx, seeded.loan.publicId, payload)).rejects.toMatchObject({ code: "INVALID_PAYMENT_TARGET" });
        expect(first.paymentIntakePublicId).toBeTruthy();
    });

    integrationTest("rejects a historical target whose true current capacity is already consumed", async () => {
        const seeded = await seed();
        await previewAndPost(seeded, { amount: "30.00", receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "30.00" }] }, "capacity-oct2-30");
        await previewAndPost(seeded, { amount: "20.00", receivedAt: "2026-10-05T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "20.00" }] }, "capacity-oct5-20");
        await previewAndPost(seeded, { amount: "30.00", receivedAt: "2026-10-03T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "30.00" }] }, "capacity-historical-30");
        await expect(previewFloatingAccrualPayment(context(seeded.user, "historical-capacity-30-01"), seeded.loan.publicId, { amount: "30.01", receivedAt: "2026-10-03T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "30.01" }] })).rejects.toMatchObject({ code: "FLOATING_ACCRUAL_CAPACITY_EXCEEDED" });
    });

    integrationTest("resumes a lost preview response and returns the original receipt on same-key post retry", async () => {
        const seeded = await seed();
        const ctx = context(seeded.user, "lost-response");
        const input = { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] };
        const first = await previewFloatingAccrualPayment(ctx, seeded.loan.publicId, input);
        const resumed = await previewFloatingAccrualPayment(ctx, seeded.loan.publicId, input);
        expect(resumed.paymentIntakePublicId).toBe(first.paymentIntakePublicId);
        expect(resumed.publicId).toBe(first.publicId);
        const posted = await postFloatingAccrualPayment(ctx, seeded.loan.publicId, { paymentIntakePublicId: first.paymentIntakePublicId!, proposalPublicId: first.publicId!, confirmed: true });
        const retried = await postFloatingAccrualPayment(ctx, seeded.loan.publicId, { paymentIntakePublicId: first.paymentIntakePublicId!, proposalPublicId: first.publicId!, confirmed: true });
        expect(retried.id).toBe(posted.id);
        expect(retried.receiptPublicId).toBe(posted.receiptPublicId);
        expect(retried.auditPublicId).toBe(posted.auditPublicId);
        expect(retried.correlationId).toBe(posted.correlationId);
        const intake = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, first.paymentIntakePublicId!) });
        expect(await db.select().from(transactions).where(eq(transactions.paymentIntakeId, intake!.id))).toHaveLength(1);
        await expect(previewFloatingAccrualPayment(ctx, seeded.loan.publicId, { ...input, amount: "40.00", targets: [{ accrualDate: "2026-10-02", amount: "40.00" }] })).rejects.toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    });

    integrationTest("rejects stale selected capacity after another receipt consumes it", async () => {
        const seeded = await seed();
        const olderContext = context(seeded.user, "stale-partial");
        const older = await previewFloatingAccrualPayment(olderContext, seeded.loan.publicId, { amount: "30.00", receivedAt: "2026-10-04T10:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "30.00" }] });
        const newer = await previewFloatingAccrualPayment(context(seeded.user, "consume-capacity"), seeded.loan.publicId, { amount: "50.00", receivedAt: "2026-10-04T10:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "50.00" }] });
        await postFloatingAccrualPayment(context(seeded.user, "consume-capacity"), seeded.loan.publicId, { paymentIntakePublicId: newer.paymentIntakePublicId!, proposalPublicId: newer.publicId!, confirmed: true });
        await expect(postFloatingAccrualPayment(olderContext, seeded.loan.publicId, { paymentIntakePublicId: older.paymentIntakePublicId!, proposalPublicId: older.publicId!, confirmed: true })).rejects.toMatchObject({ code: "STALE_PAYMENT_PROPOSAL" });
    });

    integrationTest("rolls back intake, proposal, and selected targets together when target persistence fails", async () => {
        const seeded = await seed();
        await db.execute(sql`CREATE OR REPLACE FUNCTION reject_selected_target_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'selected target test failure'; END; $$`);
        await db.execute(sql`CREATE TRIGGER reject_selected_target_test BEFORE INSERT ON payment_match_floating_targets FOR EACH ROW EXECUTE FUNCTION reject_selected_target_test()`);
        try {
            let rejected = false;
            try { await previewFloatingAccrualPayment(context(seeded.user, "atomic-rollback"), seeded.loan.publicId, { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] }); } catch { rejected = true; }
            expect(rejected).toBe(true);
            expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.idempotencyKey, "atomic-rollback"))).toHaveLength(0);
            expect(await db.select().from(paymentMatchProposals)).toHaveLength(0);
            expect(await db.select().from(paymentMatchFloatingTargets)).toHaveLength(0);
        } finally {
            await db.execute(sql`DROP TRIGGER IF EXISTS reject_selected_target_test ON payment_match_floating_targets`);
            await db.execute(sql`DROP FUNCTION IF EXISTS reject_selected_target_test()`);
        }
    });

    integrationTest("does not reopen an intake that becomes posted while a draft edit waits on the tenant lock", async () => {
        const seeded = await seed();
        const ctx = context(seeded.user, "race-edit");
        const draft = await createPaymentIntake(ctx, { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", originLoanPublicId: seeded.loan.publicId });
        let release!: () => void;
        let locked!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const hasLock = new Promise<void>((resolve) => { locked = resolve; });
        const poster = db.transaction(async (tx) => {
            await lockPaymentWorkflowTenant(ctx, tx);
            locked();
            await held;
            await tx.update(paymentIntakes).set({ status: "posted", postedAt: new Date(), postedByUserId: seeded.user.id }).where(eq(paymentIntakes.publicId, draft.publicId));
        });
        await hasLock;
        const edit = previewFloatingAccrualPayment(ctx, seeded.loan.publicId, { paymentIntakePublicId: draft.publicId, amount: "40.00", receivedAt: "2026-10-03T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "40.00" }] });
        await new Promise((resolve) => setTimeout(resolve, 50));
        release();
        await poster;
        await expect(edit).rejects.toMatchObject({ code: "PAYMENT_INTAKE_IMMUTABLE" });
        const final = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, draft.publicId) });
        expect(final?.status).toBe("posted");
        expect(final?.amount).toBe("80.00");
    });

    integrationTest("recomputes a normalized bank-reference hash and rejects another posted receipt identity", async () => {
        const seeded = await seed();
        const firstCtx = context(seeded.user, "bank-reference-first");
        const first = await previewFloatingAccrualPayment(firstCtx, seeded.loan.publicId, { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", bankReference: "Ref-01", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] });
        await postFloatingAccrualPayment(firstCtx, seeded.loan.publicId, { paymentIntakePublicId: first.paymentIntakePublicId!, proposalPublicId: first.publicId!, confirmed: true });
        const secondCtx = context(seeded.user, "bank-reference-second");
        const second = await previewFloatingAccrualPayment(secondCtx, seeded.loan.publicId, { amount: "80.00", receivedAt: "2026-10-03T09:00:00+07:00", targets: [{ accrualDate: "2026-10-03", amount: "80.00" }] });
        const editCtx = context(seeded.user, "bank-reference-second-edit");
        await expect(previewFloatingAccrualPayment(editCtx, seeded.loan.publicId, { paymentIntakePublicId: second.paymentIntakePublicId!, amount: "80.00", receivedAt: "2026-10-03T09:00:00+07:00", bankReference: "ref 01", targets: [{ accrualDate: "2026-10-03", amount: "80.00" }] })).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REQUIRES_REVIEW" });
        const clearCtx = context(seeded.user, "bank-reference-second-clear");
        const cleared = await previewFloatingAccrualPayment(clearCtx, seeded.loan.publicId, { paymentIntakePublicId: second.paymentIntakePublicId!, amount: "80.00", receivedAt: "2026-10-03T09:00:00+07:00", bankReference: null, targets: [{ accrualDate: "2026-10-03", amount: "80.00" }] });
        expect(cleared.status).toBe("ready");
        const row = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, second.paymentIntakePublicId!) });
        expect(row?.bankReference).toBeNull();
        expect(row?.bankReferenceHash).toBeNull();
    });

    integrationTest("blocks a historical selected receipt when later paid penalty provenance depends on it", async () => {
        const seeded = await seed({ fixedPenalty: "10.00" });
        const genericCtx = context(seeded.user, "penalty-payment");
        const generic = await createPaymentIntake(genericCtx, { amount: "90.00", receivedAt: "2026-10-05T09:00:00+07:00", originLoanPublicId: seeded.loan.publicId });
        const genericPreview = await previewPaymentMatch(genericCtx, generic.publicId, { allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "90.00" }] });
        await (await import("./payment-service")).postPayment(genericCtx, generic.publicId, { proposalPublicId: genericPreview.publicId });
        const ctx = context(seeded.user, "historical-penalty-conflict");
        const historicalInput = { amount: "80.00", receivedAt: "2026-10-03T12:00:00+07:00", targets: [{ accrualDate: "2026-10-03", amount: "80.00" }] };
        await expect(previewFloatingAccrualPayment(ctx, seeded.loan.publicId, historicalInput)).rejects.toMatchObject({ code: "FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION" });
        expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.idempotencyKey, "historical-penalty-conflict"))).toHaveLength(0);
        await reversePayment(context(seeded.user, "reverse-later-paid-penalty"), generic.publicId, { reason: "Reverse later receipt before reviewing historical interest" });
        expect((await previewFloatingAccrualPayment(context(seeded.user, "historical-penalty-after-reversal"), seeded.loan.publicId, historicalInput)).status).toBe("ready");
    });

    integrationTest("blocks later live principal at preview, then ignores it after complete reversal lineage", async () => {
        const seeded = await seed();
        const genericCtx = context(seeded.user, "later-principal");
        const intake = await createPaymentIntake(genericCtx, { amount: "1000.00", receivedAt: "2026-10-05T09:00:00+07:00", originLoanPublicId: seeded.loan.publicId });
        const proposal = await previewPaymentMatch(genericCtx, intake.publicId, { allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "1000.00" }] });
        await (await import("./payment-service")).postPayment(genericCtx, intake.publicId, { proposalPublicId: proposal.publicId });
        const historicalInput = { amount: "80.00", receivedAt: "2026-10-03T12:00:00+07:00", targets: [{ accrualDate: "2026-10-03", amount: "80.00" }] };
        await expect(previewFloatingAccrualPayment(context(seeded.user, "historical-principal"), seeded.loan.publicId, historicalInput)).rejects.toMatchObject({ code: "FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION" });
        await reversePayment(context(seeded.user, "reverse-later-principal"), intake.publicId, { reason: "Reverse later principal before reviewing historical interest" });
        const safe = await previewFloatingAccrualPayment(context(seeded.user, "historical-principal-after-reversal"), seeded.loan.publicId, historicalInput);
        expect(safe.status).toBe("ready");
    });

    integrationTest("keeps preview projection read-only and selected targets immutable", async () => {
        const seeded = await seed();
        const before = await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.tenantId, seeded.user.tenantId));
        const preview = await previewFloatingAccrualPayment(context(seeded.user, "projection-only"), seeded.loan.publicId, { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] });
        const after = await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.tenantId, seeded.user.tenantId));
        expect(after).toHaveLength(before.length);
        const target = await db.select().from(paymentMatchFloatingTargets).where(eq(paymentMatchFloatingTargets.tenantId, seeded.user.tenantId));
        expect(target).toHaveLength(1);
        let immutable = false;
        try { await db.update(paymentMatchFloatingTargets).set({ amount: "1.00" }).where(eq(paymentMatchFloatingTargets.id, target[0]!.id)); } catch { immutable = true; }
        expect(immutable).toBe(true);
        await expect(previewPaymentMatch(context(seeded.user, "generic-repreview"), preview.paymentIntakePublicId!, { allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "80.00" }] })).rejects.toMatchObject({ code: "SELECTED_FLOATING_REVIEW_REQUIRED" });
    });

    integrationTest("uses exact decimal amounts above JavaScript safe integer range", async () => {
        const seeded = await seed({ principal: "9007199254740993.00", rate: "100.0000" });
        const amount = "9007199254740993.00";
        const result = await previewAndPost(seeded, { amount, receivedAt: "2026-10-01T09:00:00+07:00", targets: [{ accrualDate: "2026-10-01", amount }] }, "large-decimal");
        expect(result.posted.transactions[0]!.interestComponent).toBe(amount);
    });

    integrationTest("preserves all 29 public money digits through preview, post, retry, and receipt history", async () => {
        const seeded = await seed({ principal: "12345678901234567890123456789.25", rate: "2.0000" });
        const amount = "246913578024691357802469135.79";
        const ctx = context(seeded.user, "full-public-precision");
        const input = { amount, receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount }] };
        const preview = await previewFloatingAccrualPayment(ctx, seeded.loan.publicId, input);
        expect(preview.totalAllocated).toBe(amount);
        expect(preview.targets[0]?.amount).toBe(amount);
        const posted = await postFloatingAccrualPayment(ctx, seeded.loan.publicId, { paymentIntakePublicId: preview.paymentIntakePublicId, proposalPublicId: preview.publicId, confirmed: true });
        expect(posted.transactions[0]?.interestComponent).toBe(amount);
        expect((await db.query.loanInterestAccruals.findFirst({ where: and(eq(loanInterestAccruals.tenantId, seeded.user.tenantId), eq(loanInterestAccruals.accrualDate, "2026-10-02")) }))?.interestAmount).toBe(amount);
        const retry = await postFloatingAccrualPayment(ctx, seeded.loan.publicId, { paymentIntakePublicId: preview.paymentIntakePublicId, proposalPublicId: preview.publicId, confirmed: true });
        expect(retry.transactions[0]?.interestComponent).toBe(amount);
        expect((await getLoanAccrualReceiptHistory(context(seeded.user), seeded.loan.publicId)).find((row) => row.accrualDate === "2026-10-02")?.receipts[0]?.amount).toBe(amount);
    });

    integrationTest("blocks selected preview while required evidence is pending", async () => {
        const seeded = await seed();
        const ctx = context(seeded.user, "evidence-required");
        const intake = await createPaymentIntake(ctx, { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", originLoanPublicId: seeded.loan.publicId, attachmentRequirement: { expectedCount: 1 } });
        await expect(previewFloatingAccrualPayment(ctx, seeded.loan.publicId, { paymentIntakePublicId: intake.publicId, amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] })).rejects.toBeTruthy();
    });

    integrationTest("rejects selected accruals with missing historical rate coverage", async () => {
        const seeded = await seed();
        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.loan.publicId) });
        await db.update(loanInterestRatePeriods).set({ expiryDate: "2026-09-30" }).where(and(eq(loanInterestRatePeriods.tenantId, seeded.user.tenantId), eq(loanInterestRatePeriods.loanId, loan!.id)));
        await expect(previewFloatingAccrualPayment(context(seeded.user, "missing-rate"), seeded.loan.publicId, { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] })).rejects.toMatchObject({ code: "RATE_PERIOD_MISSING_COVERAGE" });
    });

    integrationTest("does not offer selected payment capacity already covered by an advance deduction", async () => {
        const seeded = await seed({ firstDayTreatment: "deduct" });
        await expect(previewFloatingAccrualPayment(context(seeded.user, "advance-covered"), seeded.loan.publicId, { amount: "80.00", receivedAt: "2026-10-01T09:00:00+07:00", targets: [{ accrualDate: "2026-09-30", amount: "80.00" }] })).rejects.toBeTruthy();
    });

    integrationTest("serializes concurrent partial receipts against one accrual date", async () => {
        const seeded = await seed();
        const receivedAt = "2026-10-02T09:00:00+07:00";
        const firstCtx = context(seeded.user, "concurrent-1");
        const secondCtx = context(seeded.user, "concurrent-2");
        const first = await previewFloatingAccrualPayment(firstCtx, seeded.loan.publicId, { amount: "40.00", receivedAt, targets: [{ accrualDate: "2026-10-02", amount: "40.00" }] });
        const second = await previewFloatingAccrualPayment(secondCtx, seeded.loan.publicId, { amount: "40.00", receivedAt, targets: [{ accrualDate: "2026-10-02", amount: "40.00" }] });
        const results = await Promise.allSettled([
            postFloatingAccrualPayment(firstCtx, seeded.loan.publicId, { paymentIntakePublicId: first.paymentIntakePublicId!, proposalPublicId: first.publicId!, confirmed: true }),
            postFloatingAccrualPayment(secondCtx, seeded.loan.publicId, { paymentIntakePublicId: second.paymentIntakePublicId!, proposalPublicId: second.publicId!, confirmed: true }),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const accrual = await db.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, seeded.user.tenantId), eq(loanInterestAccruals.accrualDate, "2026-10-02")));
        expect(new Decimal(accrual[0]!.paidAmount).toFixed(2)).toBe("40.00");
    });

    integrationTest("reversal restores only selected target balances and retains reversal lineage", async () => {
        const seeded = await seed();
        const ctx = context(seeded.user, "target-reversal");
        const preview = await previewFloatingAccrualPayment(ctx, seeded.loan.publicId, { amount: "160.00", receivedAt: "2026-10-05T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }, { accrualDate: "2026-10-04", amount: "80.00" }] });
        await postFloatingAccrualPayment(ctx, seeded.loan.publicId, { paymentIntakePublicId: preview.paymentIntakePublicId!, proposalPublicId: preview.publicId!, confirmed: true });
        await reversePayment(context(seeded.user, "target-reversal-reason"), preview.paymentIntakePublicId!, { reason: "Selected target regression" });
        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.loan.publicId) });
        const rows = await db.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, seeded.user.tenantId), eq(loanInterestAccruals.loanId, loan!.id)));
        expect(new Decimal(rows.find((row) => row.accrualDate === "2026-10-02")!.paidAmount).toFixed(2)).toBe("0.00");
        expect(new Decimal(rows.find((row) => row.accrualDate === "2026-10-04")!.paidAmount).toFixed(2)).toBe("0.00");
        const history = await getLoanAccrualReceiptHistory(context(seeded.user), seeded.loan.publicId);
        expect(history.find((row) => row.accrualDate === "2026-10-02")?.receipts).toEqual([expect.objectContaining({ amount: "80.00", status: "reversed", sourceKind: "receipt", receivedAt: new Date("2026-10-05T09:00:00+07:00").toISOString() })]);
        const lineage = await db.select().from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, seeded.user.tenantId), eq(floatingTransactionAllocations.loanId, loan!.id), eq(floatingTransactionAllocations.entryType, "reversal")));
        expect(lineage).toHaveLength(2);
    });

    integrationTest("labels advance deductions and legacy paid balances without inventing receipt times", async () => {
        const advanceLoan = await seed({ firstDayTreatment: "deduct" });
        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, advanceLoan.loan.publicId) });
        await accrueFloatingInterestThrough(db, loan!, new Date("2026-10-01T12:00:00+07:00"), context(advanceLoan.user));
        const advanceHistory = await getLoanAccrualReceiptHistory(context(advanceLoan.user), advanceLoan.loan.publicId);
        expect(advanceHistory.find((row) => row.accrualDate === "2026-09-30")?.receipts).toEqual([expect.objectContaining({ amount: "80.00", receivedAt: null, sourceKind: "advance_deduction" })]);

        const legacyLoan = await seed();
        const legacy = await db.query.loans.findFirst({ where: eq(loans.publicId, legacyLoan.loan.publicId) });
        await accrueFloatingInterestThrough(db, legacy!, new Date("2026-10-02T12:00:00+07:00"), context(legacyLoan.user));
        const accrual = await db.query.loanInterestAccruals.findFirst({ where: and(eq(loanInterestAccruals.tenantId, legacyLoan.user.tenantId), eq(loanInterestAccruals.loanId, legacy!.id), eq(loanInterestAccruals.accrualDate, "2026-10-02")) });
        await db.transaction(async (tx) => {
            const transaction = await tx.insert(transactions).values({ tenantId: legacyLoan.user.tenantId, ownerUserId: legacyLoan.user.id, loanId: legacy!.id, amount: "12.00", principalComponent: "0.00", interestComponent: "12.00", feeComponent: "0.00", penaltyComponent: "0.00", type: "repayment", entryType: "repayment", transactionDate: new Date("2026-10-02T12:00:00+07:00"), postedAt: new Date("2026-10-02T12:00:00+07:00"), idempotencyKey: "legacy-no-intake" }).returning().then((rows) => rows[0]!);
            const audit = await tx.insert(auditLogs).values({ tenantId: legacyLoan.user.tenantId, entityType: "transaction", entityId: transaction.publicId, action: "floating_payment_allocations_recorded", actorUserId: legacyLoan.user.id, actorSource: "web", requestId: "legacy-no-intake", correlationId: "legacy-no-intake" }).returning().then((rows) => rows[0]!);
            await tx.insert(floatingTransactionAllocations).values({ tenantId: legacyLoan.user.tenantId, loanId: legacy!.id, transactionId: transaction.id, component: "interest", interestAccrualId: accrual!.id, dueDate: accrual!.accrualDate, effectiveDate: "2026-10-02", amount: "12.00", allocationOrder: 1, entryType: "payment", idempotencyKey: "legacy-no-intake-allocation", auditPublicId: audit.publicId, actorSource: "web", requestId: "legacy-no-intake", correlationId: "legacy-no-intake", createdByUserId: legacyLoan.user.id });
            await tx.update(loanInterestAccruals).set({ paidAmount: "12.00", status: "partially_paid" }).where(eq(loanInterestAccruals.id, accrual!.id));
        });
        const legacyHistory = await getLoanAccrualReceiptHistory(context(legacyLoan.user), legacyLoan.loan.publicId);
        expect(legacyHistory.find((row) => row.accrualDate === "2026-10-02")?.receipts).toEqual([expect.objectContaining({ amount: "12.00", receivedAt: new Date("2026-10-02T12:00:00+07:00").toISOString(), recordedAt: new Date("2026-10-02T12:00:00+07:00").toISOString(), sourceKind: "legacy_unattributed", status: "posted" })]);
    });

    integrationTest("rejects excess, duplicate, future and invalid capacity targets before creating a receipt", async () => {
        const seeded = await seed();
        const ctx = context(seeded.user, "rejects");
        await expect(previewFloatingAccrualPayment(ctx, seeded.loan.publicId, { amount: "81.00", receivedAt: "2026-10-02T08:00:00+07:00", targets: [{ accrualDate: "2026-10-01", amount: "81.00" }] })).rejects.toMatchObject({ code: "FLOATING_ACCRUAL_CAPACITY_EXCEEDED" });
        await expect(previewFloatingAccrualPayment(ctx, seeded.loan.publicId, { amount: "80.00", receivedAt: "2026-10-03T08:00:00+07:00", targets: [{ accrualDate: "2026-10-01", amount: "40.00" }, { accrualDate: "2026-10-01", amount: "40.00" }] })).rejects.toMatchObject({ code: "DUPLICATE_ACCRUAL_TARGET" });
        await expect(previewFloatingAccrualPayment(ctx, seeded.loan.publicId, { amount: "80.00", receivedAt: "2026-10-01T08:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] })).rejects.toMatchObject({ code: "ACCRUAL_AFTER_RECEIPT" });
    });
});
