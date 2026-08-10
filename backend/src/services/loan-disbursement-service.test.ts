import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, loanDisbursementEvents, loanSchedules, loans, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import {
    createDisbursementDraft,
    listLoanDisbursements,
    postDisbursement,
    reverseDisbursement,
    updateDisbursementDraft,
} from "./loan-disbursement-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function reset() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_disbursement_evidence, loan_disbursement_events,
        loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function actor(tenantId = "tenant-a") {
    return db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" })
        .returning().then((rows) => rows[0]!);
}

function context(user: { id: number; tenantId: string }, idempotencyKey: string = crypto.randomUUID()): CommandContext {
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "web", requestId: `req-${crypto.randomUUID()}`, correlationId: `corr-${crypto.randomUUID()}`, idempotencyKey };
}

async function loanFor(user: { id: number; tenantId: string }, principal = "5000.00") {
    const borrower = await db.insert(borrowers).values({ tenantId: user.tenantId, ownerUserId: user.id, name: "Disbursement borrower" })
        .returning().then((rows) => rows[0]!);
    return db.insert(loans).values({
        tenantId: user.tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: principal,
        interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: principal,
        outstandingInterest: "0.00", outstandingFees: "0.00", status: "active",
    }).returning().then((rows) => rows[0]!);
}

beforeEach(reset);
afterEach(reset);

// Break caught: netting gross rather than attributed amounts, or including reversed postings, reports a false loan payout.
integrationTest("lists tenant-scoped attributed disbursement totals and variance", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const ctx = context(owner);
    const first = await createDisbursementDraft(ctx, loan.publicId, {
        grossAmount: "5100.00", loanAttributedAmount: "5000.00", channel: "bank_transfer", note: "Grouped payout", disbursedAt: "2026-08-10T10:00:00.000Z",
    });
    await postDisbursement(context(owner, "post-one"), first.publicId);
    const second = await createDisbursementDraft(ctx, loan.publicId, {
        grossAmount: "200.00", loanAttributedAmount: "200.00", channel: "cash", disbursedAt: "2026-08-10T11:00:00.000Z",
    });
    await postDisbursement(context(owner, "post-two"), second.publicId);

    const result = await listLoanDisbursements(ctx, loan.publicId);

    expect(result.summary).toMatchObject({ approvedPrincipal: "5000.00", netDisbursed: "5200.00", variance: "200.00", status: "over_disbursed" });
    expect(result.events).toHaveLength(2);
});

// Break caught: a posted row remains editable, allowing payout history to be silently rewritten.
integrationTest("posts an editable draft once and locks it afterward", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5000.00", loanAttributedAmount: "5000.00", channel: "cash", disbursedAt: "2026-08-10T10:00:00.000Z",
    });

    const posted = await postDisbursement(context(owner, "post-lock"), draft.publicId);

    expect(posted).toMatchObject({ publicId: draft.publicId, status: "posted" });
    await expect(updateDisbursementDraft(context(owner), posted.publicId, { note: "x" })).rejects.toMatchObject({ code: "DISBURSEMENT_LOCKED", status: 409 });
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, draft.publicId), eq(auditLogs.action, "posted")))).toHaveLength(1);
});

// Break caught: reversals alter or delete the original event, or retries create multiple compensating events.
integrationTest("creates one idempotent compensating reversal without changing the loan", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const original = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5000.00", loanAttributedAmount: "5000.00", channel: "cash", disbursedAt: "2026-08-10T10:00:00.000Z",
    });
    const posted = await postDisbursement(context(owner, "post-reverse"), original.publicId);

    const reversal = await reverseDisbursement(context(owner, "reverse-key"), posted.publicId, "wrong payout");
    const retried = await reverseDisbursement(context(owner, "reverse-key"), posted.publicId, "wrong payout");

    expect(reversal).toMatchObject({ status: "reversed", reversedEventPublicId: posted.publicId });
    expect(retried).toEqual(reversal);
    expect(await db.query.loans.findFirst({ where: eq(loans.id, loan.id) })).toMatchObject({ principalAmount: "5000.00", outstandingPrincipal: "5000.00" });
    expect(await db.select().from(loanDisbursementEvents).where(sql`${loanDisbursementEvents.reversedEventId} = ${posted.id}`)).toHaveLength(1);
});

// Break caught: a draft from another tenant can be read or modified by guessing its UUID.
integrationTest("does not expose another tenant's loan or draft", async () => {
    const owner = await actor();
    const outsider = await actor("tenant-b");
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "1.00", loanAttributedAmount: "1.00", channel: "cash", disbursedAt: "2026-08-10T10:00:00.000Z",
    });

    await expect(listLoanDisbursements(context(outsider), loan.publicId)).rejects.toMatchObject({ code: "LOAN_NOT_FOUND", status: 404 });
    await expect(updateDisbursementDraft(context(outsider), draft.publicId, { note: "steal" })).rejects.toMatchObject({ code: "DISBURSEMENT_NOT_FOUND", status: 404 });
});
