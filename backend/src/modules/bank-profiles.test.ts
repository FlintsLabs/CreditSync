import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankProfiles, borrowers, loanFundingAllocations, loans, users } from "../db/schema";
import { bankProfilesRoute } from "./bank-profiles";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;
const app = new Elysia().use(bankProfilesRoute);

async function resetTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, borrower_aliases, loan_schedules, loans, borrowers, users, bank_loans, bank_profiles RESTART IDENTITY CASCADE`);
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
