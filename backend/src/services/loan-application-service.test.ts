import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { auditLogs, bankLoans, bankProfiles, borrowers, loanFundingAllocations, loanSchedules, loans, users } from "../db/schema";
import { loansRoute } from "../modules/loans";
import type { CommandContext } from "./command-context";
import { createBorrower } from "./borrower-service";
import {
    activateLoan,
    createLoanDraft,
    previewLoan,
    updateLoanDraft,
} from "./loan-application-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, borrower_aliases, loan_schedules, loans, borrowers, users, bank_loans, bank_profiles RESTART IDENTITY CASCADE`);
}

async function seedUser(tenantId: string, email: string, role: "owner" | "manager" | "collector" | "viewer") {
    return db.insert(users).values({ tenantId, email, role }).returning().then((rows) => rows[0]!);
}

function context(tenantId: string, actorUserId: number, idempotencyKey = "loan-task-3"): CommandContext {
    return {
        tenantId,
        actorUserId,
        actorSource: "web",
        requestId: "req-loan-task-3",
        correlationId: "corr-loan-task-3",
        idempotencyKey,
    };
}

const terms = {
    principal: "1200.00",
    interestRate: "12.00",
    repaymentType: "monthly" as const,
    termMonths: 3,
    totalInstallments: 3,
    startDate: "2026-08-10",
};

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

describe("loan application service", () => {
    // Break caught: preview returns floating-point money or persists a loan.
    test("previews exact public schedule money without persistence", () => {
        const preview = previewLoan(terms);
        expect(preview.schedule).toHaveLength(3);
        expect(preview.terms).toMatchObject({ principal: "1200.00", interestRate: "12.00" });
        expect(preview.schedule[0]).toMatchObject({ amount: "412.00", principalComponent: "400.00" });
    });

    if (integrationEnabled) beforeEach(resetApplicationTables);

    // Break caught: POST-style creation activates immediately or retrying activation duplicates schedules.
    integrationTest("creates an editable draft and activates it exactly once", async () => {
        const actor = await seedUser("tenant-a", "loan-owner@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Draft Borrower" });

        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        expect(draft).toMatchObject({ id: draft.publicId, status: "draft", principal: "1200.00" });
        expect(draft).not.toHaveProperty("borrowerId");
        expect(await db.select().from(loanSchedules)).toHaveLength(0);

        const edited = await updateLoanDraft(ctx, draft.publicId, {
            principal: "1500.00",
            interestRate: "10.00",
            termMonths: 3,
            totalInstallments: 3,
            repaymentType: "monthly",
            startDate: "2026-08-11",
        });
        expect(edited).toMatchObject({ status: "draft", principal: "1500.00", startDate: "2026-08-11" });

        const activated = await activateLoan(ctx, draft.publicId);
        expect(activated).toMatchObject({ status: "active", principal: "1500.00" });
        const firstSchedules = await db.select().from(loanSchedules);
        expect(firstSchedules).toHaveLength(3);

        const retried = await activateLoan(context("tenant-a", actor.id, "activation-retry"), draft.publicId);
        expect(retried).toEqual(activated);
        expect(await db.select().from(loanSchedules)).toHaveLength(3);

        const history = await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, draft.publicId),
            eq(auditLogs.action, "activated"),
        ));
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ actorSource: "web", requestId: "req-loan-task-3" });
    });

    // Break caught: an active loan's financial terms can be edited through the draft command.
    integrationTest("rejects term edits after activation", async () => {
        const actor = await seedUser("tenant-a", "immutable@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Immutable Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        await activateLoan(ctx, draft.publicId);

        await expect(updateLoanDraft(ctx, draft.publicId, { principal: "999.00" }))
            .rejects.toMatchObject({ code: "LOAN_TERMS_LOCKED", status: 409 });
        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        expect(stored?.principalAmount).toBe("1200.00");
    });

    // Break caught: an update that read a draft before activation overwrites terms after activation commits.
    integrationTest("rejects an in-flight draft update when activation wins the row lock", async () => {
        const actor = await seedUser("tenant-a", "concurrent@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Concurrent Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        const storedDraft = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });

        let markLocked!: () => void;
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        let releaseLock!: () => void;
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const activationWinner = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${storedDraft!.id} FOR UPDATE`);
            markLocked();
            await release;
            await tx.update(loans).set({ status: "active" }).where(eq(loans.id, storedDraft!.id));
        });

        await locked;
        const staleUpdate = updateLoanDraft(ctx, draft.publicId, { principal: "999.00" });
        const outcome = staleUpdate.then(
            (value) => ({ value, error: null }),
            (error: unknown) => ({ value: null, error }),
        );
        await Bun.sleep(20);
        releaseLock();
        await activationWinner;
        expect((await outcome).error).toMatchObject({ code: "LOAN_TERMS_LOCKED", status: 409 });

        const finalLoan = await db.query.loans.findFirst({ where: eq(loans.id, storedDraft!.id) });
        expect(finalLoan).toMatchObject({ status: "active", principalAmount: "1200.00" });
    });

    // Break caught: owner scoping is lost or legacy active rows require draft-only fields.
    integrationTest("preserves owner visibility and treats existing active loans as compatible", async () => {
        const first = await seedUser("tenant-a", "first-loan@example.test", "collector");
        const second = await seedUser("tenant-a", "second-loan@example.test", "collector");
        const firstCtx = context("tenant-a", first.id);
        const borrower = await createBorrower(firstCtx, { name: "Private Borrower" });

        await expect(createLoanDraft(context("tenant-a", second.id), { borrowerPublicId: borrower.publicId, ...terms }))
            .rejects.toMatchObject({ code: "BORROWER_NOT_FOUND", status: 404 });

        const borrowerRow = await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, borrower.publicId) });
        const legacy = await db.insert(loans).values({
            tenantId: "tenant-a",
            ownerUserId: first.id,
            borrowerId: borrowerRow!.id,
            principalAmount: "500.00",
            interestRate: "5.00",
            repaymentType: "floating",
            status: "active",
        }).returning().then((rows) => rows[0]!);

        const compatible = await activateLoan(firstCtx, legacy.publicId);
        expect(compatible).toMatchObject({ publicId: legacy.publicId, status: "active", termMonths: null });
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, legacy.id))).toHaveLength(0);
    });

    // Break caught: the funding reallocation REST path still validates a public loan UUID as numeric.
    integrationTest("accepts a public loan ID on the funding reallocation REST route", async () => {
        const owner = await seedUser("tenant-a", "reallocation@example.test", "owner");
        const ctx = context("tenant-a", owner.id);
        const borrower = await createBorrower(ctx, { name: "Reallocation Borrower" });
        const loan = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        const storedLoan = await db.query.loans.findFirst({ where: eq(loans.publicId, loan.publicId) });
        const profile = await db.insert(bankProfiles).values({
            tenantId: "tenant-a", name: "Funding", type: "bank",
        }).returning().then((rows) => rows[0]!);
        const [source, target] = await db.insert(bankLoans).values([
            { tenantId: "tenant-a", bankProfileId: profile.id, amount: "2000.00" },
            { tenantId: "tenant-a", bankProfileId: profile.id, amount: "2000.00" },
        ]).returning();
        await db.insert(loanFundingAllocations).values({
            tenantId: "tenant-a",
            bankProfileId: profile.id,
            bankLoanId: source!.id,
            loanId: storedLoan!.id,
            allocatedAmount: "500.00",
            allocationDate: "2026-08-10",
            allocationType: "initial",
            createdByUserId: owner.id,
        });

        const app = new Elysia().use(loansRoute);
        const response = await app.handle(new Request(`http://localhost/loans/${loan.publicId}/funding-reallocations`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${await authToken(owner)}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                fromBankLoanId: source!.id,
                toBankLoanId: target!.id,
                amount: 100,
                allocationDate: "2026-08-11",
            }),
        }));

        const responseText = await response.text();
        expect(response.status, responseText).toBe(200);
        expect(JSON.parse(responseText) as unknown[]).toHaveLength(2);
    });
});
