import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { floatingTransactionAllocations, loanInterestAccruals, loans, paymentIntakes, paymentReconciliationEntries, paymentReconciliationGroups, paymentReconciliationProposals, transactions, users } from "../db/schema";
import { createBorrower } from "./borrower-service";
import { createLoanDraft, activateLoan } from "./loan-application-service";
import { createPaymentIntake, reviewPaymentIntake } from "./payment-service";
import type { CommandContext } from "./command-context";
import { calculateReconciliationComponents, executePaymentReconciliation, previewPaymentReconciliation, type ReconciliationAllocation } from "./payment-reconciliation-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

describe("payment reconciliation allocation kernel", () => {
    test("preserves explicit component allocations and conserves the source amount", () => {
        const allocations: ReconciliationAllocation[] = [
            { borrowerPublicId: "b", loanPublicId: "l", amount: "100.00", component: "interest" },
            { borrowerPublicId: "b", loanPublicId: "l", amount: "25.00", component: "fee" },
            { borrowerPublicId: "b", loanPublicId: "l", amount: "75.00", component: "principal" },
        ];
        const result = calculateReconciliationComponents(allocations, "200.00");
        expect(result.total.toFixed(2)).toBe("200.00");
        expect(result.components).toEqual({ principal: "75.00", interest: "100.00", fee: "25.00", penalty: "0.00" });
    });

    test("interest-only correction has zero principal and does not create a negative component", () => {
        const result = calculateReconciliationComponents([
            { borrowerPublicId: "b", loanPublicId: "l", amount: "100.00", component: "interest" },
        ], "100.00");
        expect(result.components.principal).toBe("0.00");
        expect(new Decimal(result.components.interest).plus(result.components.principal).toFixed(2)).toBe("100.00");
    });

    test("rejects a non-conserving allocation", () => {
        expect(() => calculateReconciliationComponents([
            { borrowerPublicId: "b", loanPublicId: "l", amount: "99.99", component: "interest" },
        ], "100.00")).toThrow("must equal source payment amount");
    });

    test("rejects negative balances", () => {
        expect(() => calculateReconciliationComponents([
            { borrowerPublicId: "b", loanPublicId: "l", amount: "-1.00", component: "interest" },
        ], "0.00")).toThrow();
    });

    test("rejects zero, negative, and unknown runtime component rows even when totals could conserve", () => {
        expect(() => calculateReconciliationComponents([
            { borrowerPublicId: "b", loanPublicId: "l", amount: "0.00", component: "interest" },
        ], "0.00")).toThrow("greater than zero");
        expect(() => calculateReconciliationComponents([
            { borrowerPublicId: "b", loanPublicId: "l", amount: "-1.00", component: "interest" },
            { borrowerPublicId: "b", loanPublicId: "l", amount: "2.00", component: "principal" },
        ], "1.00")).toThrow();
        expect(() => calculateReconciliationComponents([
            { borrowerPublicId: "b", loanPublicId: "l", amount: "1.00", component: "unknown" as ReconciliationAllocation["component"] },
        ], "1.00")).toThrow("invalid component");
    });
});

describe("payment reconciliation persistence", () => {
    integrationTest("uses unique floating allocation idempotency keys when one intake is split across loans", async () => {
        const tenantId = `reconcile-split-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "mcp", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
        const borrower = await createBorrower(ctx, { name: "Split Reconciliation Borrower" });
        const first = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, principal: "1000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1, startDate: "2026-08-06", floatingDailyInterest: { mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day" } });
        const second = await createLoanDraft({ ...ctx, idempotencyKey: crypto.randomUUID() }, { borrowerPublicId: borrower.publicId, principal: "1000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1, startDate: "2026-08-06", floatingDailyInterest: { mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day" } });
        await activateLoan(ctx, first.publicId);
        await activateLoan({ ...ctx, idempotencyKey: crypto.randomUUID() }, second.publicId);
        const intake = await createPaymentIntake({ ...ctx, idempotencyKey: crypto.randomUUID() }, { amount: "20.00", receivedAt: "2026-08-15T09:28:00.000Z", payerName: borrower.name });
        await reviewPaymentIntake(ctx, intake.publicId, { status: "needs_review" });
        const preview = await previewPaymentReconciliation(ctx, { paymentIntakePublicId: intake.publicId, allocations: [
            { borrowerPublicId: borrower.publicId, loanPublicId: first.publicId, amount: "10.00", component: "interest" },
            { borrowerPublicId: borrower.publicId, loanPublicId: second.publicId, amount: "10.00", component: "interest" },
        ], reason: "Split historical interest across two loans" });
        const result = await executePaymentReconciliation(ctx, preview.publicId, { previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: preview.reason, idempotencyKey: crypto.randomUUID() });
        expect(result.correctedTransactionPublicIds).toHaveLength(2);
        const allocationRows = await db.select().from(floatingTransactionAllocations).where(eq(floatingTransactionAllocations.tenantId, tenantId));
        expect(allocationRows).toHaveLength(2);
        expect(new Set(allocationRows.map((row) => row.idempotencyKey)).size).toBe(2);
    });

    integrationTest("posts a needs_review interest-only intake without changing principal", async () => {
        const tenantId = `reconcile-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "mcp", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
        const borrower = await createBorrower(ctx, { name: "Reconciliation Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, principal: "1000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1, startDate: "2026-08-06", floatingDailyInterest: { mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day" } });
        await activateLoan(ctx, draft.publicId);
        const intake = await createPaymentIntake(ctx, { amount: "10.00", receivedAt: "2026-08-15T09:28:00.000Z", payerName: borrower.name });
        await reviewPaymentIntake(ctx, intake.publicId, { status: "needs_review" });
        await expect(previewPaymentReconciliation(ctx, { paymentIntakePublicId: intake.publicId, allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: draft.publicId, amount: "10.00", component: "principal" }], reason: "Must never reduce principal" })).rejects.toMatchObject({ code: "RECONCILIATION_COMPONENT_NOT_SUPPORTED" });

        const postedIntake = await createPaymentIntake({ ...ctx, idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }, { amount: "11.00", receivedAt: "2026-08-16T09:28:00.000Z", payerName: `${borrower.name} posted` });
        await db.update(paymentIntakes).set({ status: "posted" }).where(and(eq(paymentIntakes.tenantId, tenantId), eq(paymentIntakes.publicId, postedIntake.publicId)));
        await expect(previewPaymentReconciliation(ctx, { paymentIntakePublicId: postedIntake.publicId, allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: draft.publicId, amount: "11.00", component: "interest" }], reason: "Posted corrections are not safe in this release" })).rejects.toMatchObject({ code: "RECONCILIATION_INTAKE_INVALID" });

        const stalePreview = await previewPaymentReconciliation(ctx, { paymentIntakePublicId: intake.publicId, allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: draft.publicId, amount: "10.00", component: "interest" }], reason: "Historical intake was confirmed as interest-only" });
        await db.update(loans).set({ outstandingInterest: "1.00" }).where(and(eq(loans.tenantId, tenantId), eq(loans.publicId, draft.publicId)));
        await expect(executePaymentReconciliation(ctx, stalePreview.publicId, { previewHash: stalePreview.previewHash, expectedBalanceVersion: stalePreview.expectedBalanceVersion, confirmed: true, reason: stalePreview.reason, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "STALE_RECONCILIATION_PREVIEW" });
        await db.update(loans).set({ outstandingInterest: "0.00" }).where(and(eq(loans.tenantId, tenantId), eq(loans.publicId, draft.publicId)));
        const preview = await previewPaymentReconciliation(ctx, { paymentIntakePublicId: intake.publicId, allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: draft.publicId, amount: "10.00", component: "interest" }], reason: "Historical intake was confirmed as interest-only" });
        expect(preview.correction).toMatchObject({ principal: "0.00", interest: "10.00" });
        const executed = await executePaymentReconciliation(ctx, preview.publicId, { previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: preview.reason, idempotencyKey: crypto.randomUUID() });
        expect(executed.auditPublicIds).toHaveLength(1);
        const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, tenantId), eq(loans.publicId, draft.publicId)) });
        const intakeRow = await db.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, tenantId), eq(paymentIntakes.publicId, intake.publicId)) });
        const posted = await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.paymentIntakeId, intakeRow!.id)));
        expect(loan?.outstandingPrincipal).toBe("1000.00");
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ principalComponent: "0.00", interestComponent: "10.00", entryType: "repayment" });
        const provenance = await db.select().from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, tenantId), eq(floatingTransactionAllocations.transactionId, posted[0]!.id)));
        expect(provenance).toHaveLength(1);
        expect(provenance[0]).toMatchObject({ component: "interest", amount: "10.00", entryType: "payment", effectiveDate: "2026-08-15" });
        const accrual = await db.query.loanInterestAccruals.findFirst({ where: and(eq(loanInterestAccruals.tenantId, tenantId), eq(loanInterestAccruals.id, provenance[0]!.interestAccrualId!)) });
        expect(new Decimal(accrual!.paidAmount).gte(10)).toBe(true);
        const group = await db.query.paymentReconciliationGroups.findFirst({ where: eq(paymentReconciliationGroups.publicId, executed.reconciliationPublicId) });
        const proposalRow = await db.query.paymentReconciliationProposals.findFirst({ where: eq(paymentReconciliationProposals.publicId, preview.publicId) });
        expect(proposalRow?.status).toBe("executed");
        const entry = await db.query.paymentReconciliationEntries.findFirst({ where: eq(paymentReconciliationEntries.groupId, group!.id) });
        await expect((async () => db.update(paymentReconciliationGroups).set({ reason: "tamper" }).where(eq(paymentReconciliationGroups.id, group!.id)).returning())()).rejects.toThrow();
        await expect((async () => db.update(paymentReconciliationEntries).set({ reason: "tamper" }).where(eq(paymentReconciliationEntries.id, entry!.id)).returning())()).rejects.toThrow();
        await expect((async () => db.update(paymentReconciliationProposals).set({ reason: "tamper" }).where(eq(paymentReconciliationProposals.id, proposalRow!.id)).returning())()).rejects.toThrow();

        await expect(previewPaymentReconciliation(ctx, { paymentIntakePublicId: intake.publicId, allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: draft.publicId, amount: "10.00", component: "interest" }], reason: "Should reject a second reconciliation" })).rejects.toMatchObject({ code: "RECONCILIATION_INTAKE_INVALID" });
    });
});
