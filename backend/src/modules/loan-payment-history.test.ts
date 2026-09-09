import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { borrowers, loans, paymentIntakes, paymentMatchAllocations, paymentMatchProposals, users } from "../db/schema";
import { loansRoute } from "./loans";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, payment_match_allocations, payment_match_proposals, payment_evidence,
        transactions, payment_intakes, loan_schedules, loans, borrower_aliases, borrowers,
        bank_loans, bank_profiles, users RESTART IDENTITY CASCADE`);
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId })}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `${unsigned}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url")}`;
}

describe("loan payment history REST adapter", () => {
    if (integrationEnabled) beforeEach(resetApplicationTables);

    integrationTest("lists every origin-linked payment intake for the requested loan only", async () => {
        const actor = await db.insert(users).values({ tenantId: "tenant-loan-history", email: "history@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "History borrower" }).returning().then((rows) => rows[0]!);
        const [loan, otherLoan] = await db.insert(loans).values([
            { tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "100.00", status: "active" },
            { tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "200.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "200.00", status: "active" },
        ]).returning();
        const [draft, reversed] = await db.insert(paymentIntakes).values([
            { tenantId: actor.tenantId, ownerUserId: actor.id, originLoanId: loan!.id, status: "draft", amount: "10.00", receivedAt: new Date("2026-08-11T09:00:00.000Z") },
            { tenantId: actor.tenantId, ownerUserId: actor.id, originLoanId: loan!.id, status: "reversed", amount: "20.00", receivedAt: new Date("2026-08-11T10:00:00.000Z") },
            { tenantId: actor.tenantId, ownerUserId: actor.id, originLoanId: otherLoan!.id, status: "posted", amount: "30.00", receivedAt: new Date("2026-08-11T11:00:00.000Z") },
        ]).returning();
        const reposted = await db.insert(paymentIntakes).values({ tenantId: actor.tenantId, ownerUserId: actor.id, originLoanId: loan!.id, status: "posted", amount: "20.00", receivedAt: new Date("2026-08-11T10:00:00.000Z"), repostOfIntakeId: reversed!.id, postedAt: new Date(), postedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const token = await authToken(actor);
        const app = new Elysia().use(loansRoute);
        const response = await app.handle(new Request(`http://localhost/loans/${loan!.publicId}/payment-intakes`, { headers: { authorization: `Bearer ${token}` } }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([
            expect.objectContaining({ publicId: reversed!.publicId, status: "reversed", amount: "20.00", originLoanPublicId: loan!.publicId, repostedByIntakePublicId: reposted.publicId }),
            expect.objectContaining({ publicId: reposted.publicId, status: "posted", repostOfIntakePublicId: reversed!.publicId }),
            expect.objectContaining({ publicId: draft!.publicId, status: "draft", amount: "10.00", originLoanPublicId: loan!.publicId }),
        ]);
    });

    // Break caught: older intake records without origin_loan_id disappear from the loan history.
    integrationTest("finds legacy payment intakes through their latest allocation", async () => {
        const actor = await db.insert(users).values({ tenantId: "tenant-loan-legacy-history", email: "legacy@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "Legacy borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "100.00", status: "active" }).returning().then((rows) => rows[0]!);
        const intake = await db.insert(paymentIntakes).values({ tenantId: actor.tenantId, ownerUserId: actor.id, status: "needs_review", amount: "15.00", receivedAt: new Date("2026-08-11T09:00:00.000Z") }).returning().then((rows) => rows[0]!);
        const proposal = await db.insert(paymentMatchProposals).values({ tenantId: actor.tenantId, paymentIntakeId: intake.id, version: 1, proposalHash: "legacy-allocation", status: "needs_review" }).returning().then((rows) => rows[0]!);
        await db.insert(paymentMatchAllocations).values({ tenantId: actor.tenantId, proposalId: proposal.id, allocationOrder: 0, borrowerId: borrower.id, loanId: loan.id, amount: "15.00", status: "proposed" });

        const app = new Elysia().use(loansRoute);
        const token = await authToken(actor);
        const response = await app.handle(new Request(`http://localhost/loans/${loan.publicId}/payment-intakes`, { headers: { authorization: `Bearer ${token}` } }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([
            expect.objectContaining({ publicId: intake.publicId, originLoanPublicId: null, latestAllocation: expect.objectContaining({ amount: "15.00", proposalPublicId: proposal.publicId }) }),
        ]);
    });
});
