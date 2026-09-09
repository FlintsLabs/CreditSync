import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowerAliases, borrowers, loanSchedules, loans, users } from "../db/schema";
import { withTenantCache } from "../lib/cache";
import type { CommandContext } from "./command-context";
import {
    addBorrowerAlias,
    confirmBorrowerAlias,
    createBorrower,
    deactivateBorrowerAlias,
    getBorrowerPortfolio,
    normalizeBorrowerText,
    searchBorrowers,
    updateBorrower,
} from "./borrower-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;
const cacheIntegrationTest = integrationEnabled && Boolean(process.env.CACHE_URL) ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, borrower_aliases, loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedUser(tenantId: string, email: string, role: "owner" | "manager" | "collector" | "viewer") {
    return db.insert(users).values({ tenantId, email, role }).returning().then((rows) => rows[0]!);
}

function context(tenantId: string, actorUserId: number): CommandContext {
    return {
        tenantId,
        actorUserId,
        actorSource: "mcp",
        requestId: "req-task-3",
        correlationId: "corr-task-3",
        idempotencyKey: "idem-task-3",
    };
}

describe("borrower service", () => {
    // Break caught: borrower matching skips NFKC/case/spacing/punctuation normalization.
    test("normalizes borrower search text without changing the stored original", () => {
        expect(normalizeBorrowerText("  ＬＥＫ—  Somchai!!! ")).toBe("lek somchai");
    });

    if (integrationEnabled) beforeEach(resetApplicationTables);

    // Break caught: duplicate exact confirmed aliases silently pick one borrower.
    integrationTest("returns every accessible exact-alias candidate and never auto-resolves ambiguity", async () => {
        const owner = await seedUser("tenant-a", "owner-a@example.test", "owner");
        const collector = await seedUser("tenant-a", "collector-a@example.test", "collector");
        const otherTenant = await seedUser("tenant-b", "owner-b@example.test", "owner");
        const first = await createBorrower(context("tenant-a", collector.id), { name: "Somchai One" });
        const second = await createBorrower(context("tenant-a", owner.id), { name: "Somchai Two" });
        const hidden = await createBorrower(context("tenant-b", otherTenant.id), { name: "Hidden Borrower" });

        for (const borrower of [first, second, hidden]) {
            const tenantId = borrower.publicId === hidden.publicId ? "tenant-b" : "tenant-a";
            const actorId = borrower.publicId === first.publicId ? collector.id
                : borrower.publicId === second.publicId ? owner.id : otherTenant.id;
            const alias = await addBorrowerAlias(context(tenantId, actorId), borrower.publicId, { alias: " LÉK!!! " });
            expect(alias.alias).toBe(" LÉK!!! ");
            await confirmBorrowerAlias(context(tenantId, actorId), alias.publicId);
        }

        const managerResult = await searchBorrowers(context("tenant-a", owner.id), { query: "léK" });
        expect(managerResult.resolution).toBe("ambiguous");
        expect(managerResult.matchType).toBe("confirmed_alias");
        expect(managerResult.candidates.map((candidate) => candidate.publicId).sort())
            .toEqual([first.publicId, second.publicId].sort());
        expect(managerResult.candidates.every((candidate) => typeof candidate.id === "string")).toBe(true);

        const collectorResult = await searchBorrowers(context("tenant-a", collector.id), { query: "LÉK" });
        expect(collectorResult.resolution).toBe("unique");
        expect(collectorResult.candidates.map((candidate) => candidate.publicId)).toEqual([first.publicId]);
    });

    // Break caught: borrower mutations omit context or only store the after snapshot.
    integrationTest("records complete before/after borrower audit history with command context", async () => {
        const actor = await seedUser("tenant-a", "audit@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const created = await createBorrower(ctx, { name: "Original Name", phone: "0800000000" });
        const updated = await updateBorrower(ctx, created.publicId, { name: "Updated Name" });

        expect(updated).toMatchObject({ id: created.publicId, publicId: created.publicId, name: "Updated Name" });
        expect(updated).not.toHaveProperty("ownerUserId");

        const history = await db.select().from(auditLogs).where(eq(auditLogs.entityId, created.publicId));
        expect(history).toHaveLength(2);
        expect(history.map((entry) => entry.action)).toEqual(["created", "updated"]);
        expect(history[1]).toMatchObject({
            tenantId: "tenant-a",
            actorUserId: actor.id,
            actorSource: "mcp",
            requestId: "req-task-3",
            correlationId: "corr-task-3",
        });
        expect(history[1]?.payload).toMatchObject({
            before: { publicId: created.publicId, name: "Original Name", phone: "0800000000" },
            after: { publicId: created.publicId, name: "Updated Name", phone: "0800000000" },
        });
    });

    // Break caught: a normalized duplicate alias leaks PostgreSQL's unique-constraint exception.
    integrationTest("returns a stable conflict for a duplicate normalized alias", async () => {
        const actor = await seedUser("tenant-a", "duplicate-alias@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Alias Borrower" });
        await addBorrowerAlias(ctx, borrower.publicId, { alias: " Cash—Customer " });

        await expect(addBorrowerAlias(ctx, borrower.publicId, { alias: "cash customer" }))
            .rejects.toMatchObject({ code: "ALIAS_ALREADY_EXISTS", status: 409 });
    });

    // Break caught: borrower rename leaves cached loan-list borrowerName stale until TTL expiry.
    cacheIntegrationTest("invalidates tenant caches after borrower updates", async () => {
        const actor = await seedUser("tenant-a", "cache-invalidation@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Cached Original" });
        const cacheKey = `borrower-update-${crypto.randomUUID()}`;
        const readName = () => withTenantCache({
            tenantId: "tenant-a",
            namespace: "loans",
            key: cacheKey,
            ttlSeconds: 60,
            loader: async () => db.query.borrowers.findFirst({
                where: eq(borrowers.publicId, borrower.publicId),
            }).then((row) => row?.name ?? null),
        });

        expect(await readName()).toBe("Cached Original");
        await updateBorrower(ctx, borrower.publicId, { name: "Fresh Name" });
        expect(await readName()).toBe("Fresh Name");
    });

    // Break caught: inactive aliases remain searchable or another owner can read a private portfolio.
    integrationTest("deactivates aliases and keeps borrower portfolios owner scoped", async () => {
        const first = await seedUser("tenant-a", "first@example.test", "collector");
        const second = await seedUser("tenant-a", "second@example.test", "collector");
        const borrower = await createBorrower(context("tenant-a", first.id), { name: "Visible Person" });
        const borrowerRow = await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, borrower.publicId) });
        await db.insert(loans).values({
            tenantId: "tenant-a",
            ownerUserId: second.id,
            borrowerId: borrowerRow!.id,
            principalAmount: "100.00",
            interestRate: "0.00",
            repaymentType: "floating",
            status: "active",
        });
        const alias = await addBorrowerAlias(context("tenant-a", first.id), borrower.publicId, { alias: "Cash Customer" });
        await confirmBorrowerAlias(context("tenant-a", first.id), alias.publicId);
        await deactivateBorrowerAlias(context("tenant-a", first.id), alias.publicId);

        const aliasHistory = await db.select().from(auditLogs).where(eq(auditLogs.entityId, alias.publicId));
        expect(aliasHistory.map((entry) => entry.action)).toEqual(["created", "confirmed", "inactive"]);
        expect(aliasHistory).toEqual(expect.arrayContaining([
            expect.objectContaining({
                tenantId: "tenant-a",
                actorUserId: first.id,
                actorSource: "mcp",
                requestId: "req-task-3",
                correlationId: "corr-task-3",
            }),
        ]));
        expect(aliasHistory[0]?.payload).toMatchObject({
            before: null,
            after: { publicId: alias.publicId, alias: "Cash Customer", status: "pending" },
            borrowerPublicId: borrower.publicId,
        });
        expect(aliasHistory[1]?.payload).toMatchObject({
            before: { publicId: alias.publicId, status: "pending" },
            after: { publicId: alias.publicId, status: "confirmed" },
        });
        expect(aliasHistory[2]?.payload).toMatchObject({
            before: { publicId: alias.publicId, status: "confirmed" },
            after: { publicId: alias.publicId, status: "inactive" },
        });

        const search = await searchBorrowers(context("tenant-a", first.id), { query: "cash customer" });
        expect(search.resolution).toBe("none");
        expect((await getBorrowerPortfolio(context("tenant-a", first.id), borrower.publicId)).loans).toEqual([]);
        await expect(getBorrowerPortfolio(context("tenant-a", second.id), borrower.publicId))
            .rejects.toMatchObject({ code: "BORROWER_NOT_FOUND", status: 404 });
    });
});
