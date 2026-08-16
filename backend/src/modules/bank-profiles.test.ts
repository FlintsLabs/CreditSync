import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankProfiles, borrowers, fundLedgerEntries, loanFundingAllocations, loans, transactions, users } from "../db/schema";
import { invalidateTenantCache } from "../lib/cache";
import { bankProfilesRoute } from "./bank-profiles";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;
const app = new Elysia().use(bankProfilesRoute);

async function resetTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, borrower_aliases, loan_schedules, loans, borrowers, users, bank_loans, bank_profiles RESTART IDENTITY CASCADE`);
    await Promise.all([invalidateTenantCache("tenant-a"), invalidateTenantCache("tenant-b")]);
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

async function request(path: string, token?: string) {
    const response = await app.handle(new Request(`http://localhost${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined }));
    const text = await response.text();
    let body: any = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { response, body };
}

async function seedLoan(input: { tenantId: string; borrowerId: number; outstandingPrincipal: string; status?: string }) {
    return db.insert(loans).values({
        tenantId: input.tenantId,
        borrowerId: input.borrowerId,
        principalAmount: "7000.00",
        interestRate: "0.00",
        repaymentType: "monthly",
        termMonths: 1,
        outstandingPrincipal: input.outstandingPrincipal,
        status: input.status ?? "active",
    }).returning().then((rows) => rows[0]!);
}

describe("bank profile funding usage", () => {
    if (integrationEnabled) beforeEach(resetTables);

    integrationTest("recycles only linked borrower cash into a capital-pool source", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "recovered-cash@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({ tenantId: "tenant-a", name: "Owner capital", type: "personal", accountingMode: "capital_pool", creditLimit: "60000.00" }).returning().then((rows) => rows[0]!);
        const [linkedBorrower, unlinkedBorrower] = await db.insert(borrowers).values([
            { tenantId: "tenant-a", name: "Linked borrower" },
            { tenantId: "tenant-a", name: "Unlinked borrower" },
        ]).returning();
        const linkedLoan = await seedLoan({ tenantId: "tenant-a", borrowerId: linkedBorrower!.id, outstandingPrincipal: "5000.00" });
        const unlinkedLoan = await seedLoan({ tenantId: "tenant-a", borrowerId: unlinkedBorrower!.id, outstandingPrincipal: "5000.00" });
        await db.insert(loanFundingAllocations).values({
            tenantId: "tenant-a", bankProfileId: profile.id, loanId: linkedLoan.id, allocatedAmount: "7000.00", allocationDate: "2026-08-07", allocationType: "initial",
        });
        await db.insert(transactions).values([
            { tenantId: "tenant-a", ownerUserId: owner.id, loanId: linkedLoan.id, amount: "1200.00", principalComponent: "1200.00", entryType: "repayment", idempotencyKey: "linked-cash" },
            { tenantId: "tenant-a", ownerUserId: owner.id, loanId: unlinkedLoan.id, amount: "900.00", principalComponent: "900.00", entryType: "repayment", idempotencyKey: "unlinked-cash" },
        ]);

        const result = await request(`/bank-profiles/${profile.publicId}/funding-usage`, await authToken(owner));

        expect(result.response.status).toBe(200);
        expect(result.body).toMatchObject({
            linkedBorrowerCashCollected: "1200.00",
            availableAmount: "54200.00",
            allocations: [expect.objectContaining({ loanPublicId: linkedLoan.publicId, linkedBorrowerCashCollected: "1200.00" })],
        });
        expect(result.body.allocations).toHaveLength(1);
    });

    integrationTest("attributes recovered borrower cash by each source's positive allocation share", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "partial-recovery@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const [firstProfile, secondProfile, negativeProfile] = await db.insert(bankProfiles).values([
            { tenantId: "tenant-a", name: "First capital", type: "personal", accountingMode: "capital_pool", creditLimit: "100.00" },
            { tenantId: "tenant-a", name: "Second capital", type: "personal", accountingMode: "capital_pool", creditLimit: "100.00" },
            { tenantId: "tenant-a", name: "Reallocated capital", type: "personal", accountingMode: "capital_pool", creditLimit: "100.00" },
        ]).returning();
        const borrower = await db.insert(borrowers).values({ tenantId: "tenant-a", name: "Partially funded borrower" }).returning().then((rows) => rows[0]!);
        const loan = await seedLoan({ tenantId: "tenant-a", borrowerId: borrower.id, outstandingPrincipal: "80.00" });
        await db.insert(loanFundingAllocations).values([
            { tenantId: "tenant-a", bankProfileId: firstProfile!.id, loanId: loan.id, allocatedAmount: "60.00", allocationDate: "2026-08-07", allocationType: "initial" },
            { tenantId: "tenant-a", bankProfileId: secondProfile!.id, loanId: loan.id, allocatedAmount: "40.00", allocationDate: "2026-08-07", allocationType: "initial" },
            { tenantId: "tenant-a", bankProfileId: negativeProfile!.id, loanId: loan.id, allocatedAmount: "-10.00", allocationDate: "2026-08-08", allocationType: "reallocation_out" },
        ]);
        await db.insert(transactions).values({
            tenantId: "tenant-a", ownerUserId: owner.id, loanId: loan.id, amount: "99.99", principalComponent: "99.99", entryType: "repayment", idempotencyKey: "partial-recovered-cash",
        });

        const first = await request(`/bank-profiles/${firstProfile!.publicId}/funding-usage`, await authToken(owner));
        const second = await request(`/bank-profiles/${secondProfile!.publicId}/funding-usage`, await authToken(owner));
        const negative = await request(`/bank-profiles/${negativeProfile!.publicId}/funding-usage`, await authToken(owner));

        expect(first.response.status).toBe(200);
        expect(second.response.status).toBe(200);
        expect(negative.response.status).toBe(200);
        expect(first.body).toMatchObject({ linkedBorrowerCashCollected: "59.99", allocations: [expect.objectContaining({ linkedBorrowerCashCollected: "59.99" })] });
        expect(second.body).toMatchObject({ linkedBorrowerCashCollected: "40.00", allocations: [expect.objectContaining({ linkedBorrowerCashCollected: "40.00" })] });
        expect(negative.body).toMatchObject({ linkedBorrowerCashCollected: "0.00", allocations: [] });
    });

    integrationTest("does not recycle borrower cash into an external-liability source", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "external-recovery@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({ tenantId: "tenant-a", name: "Bank source", type: "bank", accountingMode: "external_liability", creditLimit: "60000.00" }).returning().then((rows) => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({ tenantId: "tenant-a", bankProfileId: profile.id, amount: "10000.00" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: "tenant-a", name: "External borrower" }).returning().then((rows) => rows[0]!);
        const loan = await seedLoan({ tenantId: "tenant-a", borrowerId: borrower.id, outstandingPrincipal: "7000.00" });
        await db.insert(loanFundingAllocations).values({ tenantId: "tenant-a", bankProfileId: profile.id, bankLoanId: drawdown.id, loanId: loan.id, allocatedAmount: "7000.00", allocationDate: "2026-08-07", allocationType: "initial" });
        await db.insert(transactions).values({ tenantId: "tenant-a", ownerUserId: owner.id, loanId: loan.id, amount: "1200.00", principalComponent: "1200.00", entryType: "repayment", idempotencyKey: "external-cash" });

        const result = await request(`/bank-profiles/${profile.publicId}/funding-usage`, await authToken(owner));

        expect(result.response.status).toBe(200);
        expect(result.body).toMatchObject({ accountingMode: "external_liability", availableAmount: "50000.00", linkedBorrowerCashCollected: "0.00", allocations: [expect.objectContaining({ linkedBorrowerCashCollected: "0.00" })] });
    });

    // Break caught: capital-pool usage ignores direct allocations, leaving the full limit available.
    integrationTest("returns exact net capital usage and current borrower-loan rows", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({ tenantId: "tenant-a", name: "Owner capital", type: "personal", accountingMode: "capital_pool", creditLimit: "60000.00" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: "tenant-a", name: "Current borrower" }).returning().then((rows) => rows[0]!);
        const settledBorrower = await db.insert(borrowers).values({ tenantId: "tenant-a", name: "Settled borrower" }).returning().then((rows) => rows[0]!);
        const currentLoan = await seedLoan({ tenantId: "tenant-a", borrowerId: borrower.id, outstandingPrincipal: "5000.00" });
        const settledLoan = await seedLoan({ tenantId: "tenant-a", borrowerId: settledBorrower.id, outstandingPrincipal: "0.00", status: "paid" });
        await db.insert(loanFundingAllocations).values([
            { tenantId: "tenant-a", bankProfileId: profile.id, loanId: currentLoan.id, allocatedAmount: "7000.00", allocationDate: "2026-08-07", allocationType: "initial" },
            { tenantId: "tenant-a", bankProfileId: profile.id, loanId: settledLoan.id, allocatedAmount: "1000.00", allocationDate: "2026-08-06", allocationType: "initial" },
            { tenantId: "tenant-a", bankProfileId: profile.id, loanId: settledLoan.id, allocatedAmount: "-1000.00", allocationDate: "2026-08-08", allocationType: "reallocation_out" },
        ]);

        const token = await authToken(owner);
        const current = await request(`/bank-profiles/${profile.publicId}/funding-usage`, token);
        expect(current.response.status).toBe(200);
        expect(current.body).toMatchObject({
            accountingMode: "capital_pool",
            creditLimit: "60000.00",
            netAllocatedPrincipal: "7000.00",
            availableAmount: "53000.00",
            utilizationPercent: "11.67",
            allocations: [{
                loanPublicId: currentLoan.publicId,
                borrowerName: "Current borrower",
                netAllocatedAmount: "7000.00",
                outstandingPrincipal: "5000.00",
                latestAllocationDate: "2026-08-07",
                fundingRoutes: [{ type: "direct", bankLoanPublicId: null, netAllocatedAmount: "7000.00" }],
            }],
        });
        expect(current.body.allocations).toHaveLength(1);

        const history = await request(`/bank-profiles/${profile.publicId}/funding-usage?includeSettled=true`, token);
        expect(history.response.status).toBe(200);
        expect(history.body.allocations).toHaveLength(1);
    });

    integrationTest("recognizes historical direct-capital payments and reports the ledger difference", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "profit-owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({ tenantId: "tenant-a", name: "Owner capital", type: "personal", accountingMode: "capital_pool", creditLimit: "60000.00" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: "tenant-a", name: "Historical borrower" }).returning().then((rows) => rows[0]!);
        const loan = await seedLoan({ tenantId: "tenant-a", borrowerId: borrower.id, outstandingPrincipal: "2666.67" });
        await db.insert(loanFundingAllocations).values({
            tenantId: "tenant-a", bankProfileId: profile.id, loanId: loan.id, allocatedAmount: "5000.00", allocationDate: "2026-08-01", allocationType: "initial",
        });
        const payment = await db.insert(transactions).values({
            tenantId: "tenant-a", ownerUserId: owner.id, loanId: loan.id, amount: "3800.00",
            principalComponent: "2333.33", interestComponent: "1466.67", feeComponent: "0.00", penaltyComponent: "0.00",
            entryType: "repayment", idempotencyKey: "historical-direct-payment",
        }).returning().then((rows) => rows[0]!);
        await db.insert(fundLedgerEntries).values({
            tenantId: "tenant-a", bankProfileId: profile.id, loanId: loan.id, transactionId: payment.id,
            entryType: "interest_income_in", amount: "510.00",
        });

        const result = await request(`/bank-profiles/${profile.publicId}/profitability`, await authToken(owner));

        expect(result.response.status).toBe(200);
        expect(result.body).toMatchObject({
            borrowerCashCollected: "3800.00",
            borrowerRevenueCollected: "1466.67",
            deployedPrincipal: "5000.00",
            realizedSpread: "1466.67",
            reconciliation: {
                contractAttributedRevenue: "1466.67",
                ledgerRecordedRevenue: "510.00",
                difference: "956.67",
                status: "needs_reconciliation",
            },
        });
        const exactMoneyFields = [
            "borrowerPrincipalCollected", "borrowerInterestCollected", "borrowerFeesCollected",
            "borrowerPenaltiesCollected", "borrowerCashCollected", "borrowerRevenueCollected",
            "fundCostPaid", "realizedSpread", "unrealizedSpread", "surplusBalance",
            "deficitBalance", "carryForwardAvailable", "deployedPrincipal", "netCashPosition",
            "realizedRoiPercent", "opportunityCostAccrued", "economicSpread", "poolCurrentBalance",
        ];
        for (const field of exactMoneyFields) {
            expect(typeof result.body[field], field).toBe("string");
            expect(result.body[field], field).toMatch(/^-?\d+\.\d{2}$/);
        }
        for (const field of ["contractAttributedRevenue", "ledgerRecordedRevenue", "difference"]) {
            expect(typeof result.body.reconciliation[field], field).toBe("string");
            expect(result.body.reconciliation[field], field).toMatch(/^-?\d+\.\d{2}$/);
        }
    });

    // Break caught: each source reports the loan's full interest, or reversals fail to reduce source-attributed returns.
    integrationTest("attributes net collected interest by exact funding share", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const [firstProfile, secondProfile] = await db.insert(bankProfiles).values([
            { tenantId: "tenant-a", name: "First capital", type: "personal", accountingMode: "capital_pool", creditLimit: "100.00" },
            { tenantId: "tenant-a", name: "Second capital", type: "personal", accountingMode: "capital_pool", creditLimit: "100.00" },
        ]).returning();
        const borrower = await db.insert(borrowers).values({ tenantId: "tenant-a", name: "Shared borrower" }).returning().then((rows) => rows[0]!);
        const loan = await seedLoan({ tenantId: "tenant-a", borrowerId: borrower.id, outstandingPrincipal: "80.00" });
        await db.insert(loanFundingAllocations).values([
            { tenantId: "tenant-a", bankProfileId: firstProfile!.id, loanId: loan.id, allocatedAmount: "60.00", allocationDate: "2026-08-07", allocationType: "initial" },
            { tenantId: "tenant-a", bankProfileId: secondProfile!.id, loanId: loan.id, allocatedAmount: "40.00", allocationDate: "2026-08-07", allocationType: "initial" },
        ]);
        const repayment = await db.insert(transactions).values({
            tenantId: "tenant-a", ownerUserId: owner.id, loanId: loan.id, amount: "100.00", interestComponent: "100.00",
            entryType: "repayment", idempotencyKey: "interest-in",
        }).returning().then((rows) => rows[0]!);
        await db.insert(transactions).values({
            tenantId: "tenant-a", ownerUserId: owner.id, loanId: loan.id, amount: "-20.00", interestComponent: "-20.00",
            entryType: "reversal", reversedTransactionId: repayment.id, idempotencyKey: "interest-out",
        });

        const token = await authToken(owner);
        const first = await request(`/bank-profiles/${firstProfile!.publicId}/funding-usage`, token);
        const second = await request(`/bank-profiles/${secondProfile!.publicId}/funding-usage`, token);

        expect(first.response.status).toBe(200);
        expect(first.body.allocations).toEqual([expect.objectContaining({ loanPublicId: loan.publicId, collectedInterest: "48.00" })]);
        expect(second.response.status).toBe(200);
        expect(second.body.allocations).toEqual([expect.objectContaining({ loanPublicId: loan.publicId, collectedInterest: "32.00" })]);
    });

    // Break caught: source usage leaks another tenant's profile or lets collectors inspect tenant-wide funding.
    integrationTest("keeps source usage tenant-scoped and restricted to tenant administrators", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const collector = await db.insert(users).values({ tenantId: "tenant-a", email: "collector@example.test", role: "collector" }).returning().then((rows) => rows[0]!);
        const otherProfile = await db.insert(bankProfiles).values({ tenantId: "tenant-b", name: "Other capital", type: "personal", accountingMode: "capital_pool", creditLimit: "100.00" }).returning().then((rows) => rows[0]!);

        const collectorResponse = await request(`/bank-profiles/${otherProfile.publicId}/funding-usage`, await authToken(collector));
        expect(collectorResponse.response.status).toBe(403);
        const ownerResponse = await request(`/bank-profiles/${otherProfile.publicId}/funding-usage`, await authToken(owner));
        expect(ownerResponse.response.status).toBe(404);
    });

    // Break caught: settled loans disappear from history, or a compensated allocation still consumes source capacity.
    integrationTest("includes settled allocations on request while excluding net-zero allocation history", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({ tenantId: "tenant-a", name: "Owner capital", type: "personal", accountingMode: "capital_pool", creditLimit: "100.00" }).returning().then((rows) => rows[0]!);
        const [activeBorrower, settledBorrower, reversedBorrower] = await db.insert(borrowers).values([
            { tenantId: "tenant-a", name: "Active borrower" },
            { tenantId: "tenant-a", name: "Settled borrower" },
            { tenantId: "tenant-a", name: "Reversed borrower" },
        ]).returning();
        const activeLoan = await seedLoan({ tenantId: "tenant-a", borrowerId: activeBorrower!.id, outstandingPrincipal: "20.00" });
        const settledLoan = await seedLoan({ tenantId: "tenant-a", borrowerId: settledBorrower!.id, outstandingPrincipal: "0.00", status: "paid" });
        const reversedLoan = await seedLoan({ tenantId: "tenant-a", borrowerId: reversedBorrower!.id, outstandingPrincipal: "10.00" });
        await db.insert(loanFundingAllocations).values([
            { tenantId: "tenant-a", bankProfileId: profile.id, loanId: activeLoan.id, allocatedAmount: "20.00", allocationDate: "2026-08-07", allocationType: "initial" },
            { tenantId: "tenant-a", bankProfileId: profile.id, loanId: settledLoan.id, allocatedAmount: "30.00", allocationDate: "2026-08-07", allocationType: "initial" },
            { tenantId: "tenant-a", bankProfileId: profile.id, loanId: reversedLoan.id, allocatedAmount: "10.00", allocationDate: "2026-08-07", allocationType: "initial" },
            { tenantId: "tenant-a", bankProfileId: profile.id, loanId: reversedLoan.id, allocatedAmount: "-10.00", allocationDate: "2026-08-08", allocationType: "reallocation_out" },
        ]);

        const token = await authToken(owner);
        const current = await request(`/bank-profiles/${profile.publicId}/funding-usage`, token);
        expect(current.body).toMatchObject({ netAllocatedPrincipal: "50.00", availableAmount: "50.00" });
        expect(current.body.allocations.map((row: { loanPublicId: string }) => row.loanPublicId)).toEqual([activeLoan.publicId]);
        const history = await request(`/bank-profiles/${profile.publicId}/funding-usage?includeSettled=true`, token);
        expect(history.body.allocations.map((row: { loanPublicId: string }) => row.loanPublicId).sort()).toEqual([activeLoan.publicId, settledLoan.publicId].sort());
    });

    // Break caught: external source availability subtracts borrower allocations instead of only issued drawdowns.
    integrationTest("keeps external source availability based on issued drawdowns", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({ tenantId: "tenant-a", name: "Bank source", type: "bank", accountingMode: "external_liability", creditLimit: "60000.00" }).returning().then((rows) => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({ tenantId: "tenant-a", bankProfileId: profile.id, amount: "10000.00" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: "tenant-a", name: "Borrower" }).returning().then((rows) => rows[0]!);
        const loan = await seedLoan({ tenantId: "tenant-a", borrowerId: borrower.id, outstandingPrincipal: "7000.00" });
        await db.insert(loanFundingAllocations).values({ tenantId: "tenant-a", bankProfileId: profile.id, bankLoanId: drawdown.id, loanId: loan.id, allocatedAmount: "7000.00", allocationDate: "2026-08-07", allocationType: "initial" });

        const result = await request(`/bank-profiles/${profile.publicId}/funding-usage`, await authToken(owner));
        expect(result.response.status).toBe(200);
        expect(result.body).toMatchObject({
            accountingMode: "external_liability",
            netAllocatedPrincipal: "7000.00",
            availableAmount: "50000.00",
            utilizationPercent: "16.67",
            allocations: [{ fundingRoutes: [{ type: "drawdown", bankLoanPublicId: drawdown.publicId, netAllocatedAmount: "7000.00" }] }],
        });
    });

    // Break caught: lowering a limit below current use masks the funding-source deficit.
    integrationTest("returns signed available amount when a source is over its limit", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({ tenantId: "tenant-a", name: "Owner capital", type: "personal", accountingMode: "capital_pool", creditLimit: "100.00" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: "tenant-a", name: "Borrower" }).returning().then((rows) => rows[0]!);
        const loan = await seedLoan({ tenantId: "tenant-a", borrowerId: borrower.id, outstandingPrincipal: "150.00" });
        await db.insert(loanFundingAllocations).values({ tenantId: "tenant-a", bankProfileId: profile.id, loanId: loan.id, allocatedAmount: "150.00", allocationDate: "2026-08-07", allocationType: "initial" });

        const result = await request(`/bank-profiles/${profile.publicId}/funding-usage`, await authToken(owner));
        expect(result.response.status).toBe(200);
        expect(result.body).toMatchObject({
            netAllocatedPrincipal: "150.00",
            availableAmount: "-50.00",
            utilizationPercent: "150.00",
        });
    });
});
