import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, borrowerIdCardUploadIntents, files, users } from "../db/schema";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`TRUNCATE TABLE
        borrower_id_card_upload_intents,
        files,
        borrowers,
        users
        RESTART IDENTITY CASCADE`);
}

async function actor(tenantId: string) {
    return db.insert(users)
        .values({ tenantId, email: `${crypto.randomUUID()}@borrower-id-card.test`, role: "owner" })
        .returning()
        .then((rows) => rows[0]!);
}

async function createBorrower(actorRow: { id: number; tenantId: string }, name = "Identity borrower") {
    return db.insert(borrowers)
        .values({ tenantId: actorRow.tenantId, ownerUserId: actorRow.id, name })
        .returning()
        .then((rows) => rows[0]!);
}

async function createFile(actorRow: { id: number; tenantId: string }, key: string) {
    return db.insert(files)
        .values({
            tenantId: actorRow.tenantId,
            ownerUserId: actorRow.id,
            bucket: "borrower-id-card",
            key,
            originalName: "id.png",
        })
        .returning()
        .then((rows) => rows[0]!);
}

async function insertIntent(input: {
    tenantId: string;
    borrowerId: number;
    fileId: number;
    status?: "pending" | "ready" | "applied";
    evidenceHash?: string;
    mimeType?: "image/jpeg" | "image/png";
    declaredSize?: number;
    uploadExpiresAt?: Date | null;
    finalizedAt?: Date | null;
    appliedAt?: Date | null;
    applyRequestHash?: string | null;
    idempotencyKey?: string | null;
    createdByUserId?: number | null;
    updatedByUserId?: number | null;
}) {
    return db.insert(borrowerIdCardUploadIntents).values({
        tenantId: input.tenantId,
        borrowerId: input.borrowerId,
        fileId: input.fileId,
        status: input.status,
        evidenceHash: input.evidenceHash ?? "a".repeat(64),
        mimeType: input.mimeType ?? "image/jpeg",
        declaredSize: input.declaredSize ?? 1024,
        uploadExpiresAt: input.uploadExpiresAt ?? new Date(Date.now() + 5 * 60_000),
        finalizedAt: input.finalizedAt ?? null,
        appliedAt: input.appliedAt ?? null,
        applyRequestHash: input.applyRequestHash,
        idempotencyKey: input.idempotencyKey,
        createdByUserId: input.createdByUserId,
        updatedByUserId: input.updatedByUserId,
    }).returning().then((rows) => rows[0]!);
}

if (integrationEnabled) {
    beforeEach(resetTables);
}

describe("borrower id-card upload intent persistence", () => {
    integrationTest("allows only expiry and actor metadata during pending refresh", async () => {
        const owner = await actor("tenant-pending-refresh");
        const borrower = await createBorrower(owner);
        const file = await createFile(owner, "pending-refresh-proof");
        const row = await insertIntent({ tenantId: owner.tenantId, borrowerId: borrower.id, fileId: file.id });
        const refreshedExpiry = new Date(Date.now() + 15 * 60_000);

        await db.update(borrowerIdCardUploadIntents)
            .set({ uploadExpiresAt: refreshedExpiry, updatedByUserId: owner.id, updatedAt: new Date() })
            .where(sql`id = ${row.id}`);

        const protectedUpdate = await db.update(borrowerIdCardUploadIntents)
            .set({ evidenceHash: "b".repeat(64) })
            .where(sql`id = ${row.id}`)
            .then(() => null, (error) => error);
        expect(protectedUpdate).toMatchObject({ cause: { code: "P0001" } });
    });

    integrationTest("allows finalize to write exactly the ready transition fields", async () => {
        const owner = await actor("tenant-finalize");
        const borrower = await createBorrower(owner);
        const file = await createFile(owner, "finalize-proof");
        const row = await insertIntent({ tenantId: owner.tenantId, borrowerId: borrower.id, fileId: file.id });

        const finalizedAt = new Date();
        await db.update(borrowerIdCardUploadIntents)
            .set({ status: "ready", finalizedAt, updatedByUserId: owner.id, updatedAt: new Date() })
            .where(sql`id = ${row.id}`);
        expect((await db.select().from(borrowerIdCardUploadIntents).where(sql`id = ${row.id}`))[0]).toMatchObject({ status: "ready", finalizedAt, updatedByUserId: owner.id });

        const protectedRow = await insertIntent({ tenantId: owner.tenantId, borrowerId: borrower.id, fileId: file.id, evidenceHash: "e".repeat(64) });
        const protectedFinalizeUpdate = await db.update(borrowerIdCardUploadIntents)
            .set({ status: "ready", finalizedAt: new Date(), fileId: file.id + 1 })
            .where(sql`id = ${protectedRow.id}`)
            .then(() => null, (error) => error);
        expect(protectedFinalizeUpdate).toMatchObject({ cause: { code: "P0001" } });
    });

    integrationTest("allows apply to set its idempotency key with apply metadata after pending and ready", async () => {
        const owner = await actor("tenant-apply");
        const borrower = await createBorrower(owner);
        const file = await createFile(owner, "apply-proof");
        const row = await insertIntent({
            tenantId: owner.tenantId,
            borrowerId: borrower.id,
            fileId: file.id,
            evidenceHash: "c".repeat(64),
            createdByUserId: owner.id,
        });

        const finalizedAt = new Date();
        await db.update(borrowerIdCardUploadIntents)
            .set({ status: "ready", finalizedAt, updatedByUserId: owner.id, updatedAt: new Date() })
            .where(sql`id = ${row.id}`);

        const beforeRejectedApply = await db.select().from(borrowerIdCardUploadIntents).where(sql`id = ${row.id}`);
        const protectedApplyUpdate = await db.update(borrowerIdCardUploadIntents)
            .set({ status: "applied", appliedAt: new Date(), applyRequestHash: "e".repeat(64), idempotencyKey: "rejected-key", fileId: file.id + 1 })
            .where(sql`id = ${row.id}`)
            .then(() => null, (error) => error);
        expect(protectedApplyUpdate).toMatchObject({ cause: { code: "P0001" } });
        expect((await db.select().from(borrowerIdCardUploadIntents).where(sql`id = ${row.id}`))[0]).toEqual(beforeRejectedApply[0]);

        const appliedAt = new Date();
        await db.update(borrowerIdCardUploadIntents)
            .set({
                status: "applied", appliedAt,
                applyRequestHash: "d".repeat(64),
                idempotencyKey: "apply-tenant-apply-1",
                updatedByUserId: owner.id,
                updatedAt: new Date(),
            })
            .where(sql`id = ${row.id}`);

        const persisted = await db.select().from(borrowerIdCardUploadIntents).where(sql`id = ${row.id}`);
        expect(persisted[0]).toMatchObject({
            status: "applied", finalizedAt, appliedAt, applyRequestHash: "d".repeat(64),
            idempotencyKey: "apply-tenant-apply-1", createdByUserId: owner.id, updatedByUserId: owner.id,
        });
    });

    integrationTest("database rejects cross-tenant borrower, file, and actor references", async () => {
        const owner = await actor("tenant-a");
        const outsider = await actor("tenant-b");
        const ownerBorrower = await createBorrower(owner, "Owner borrower");
        const outsiderBorrower = await createBorrower(outsider, "Outsider borrower");
        const ownerFile = await createFile(owner, "tenant-a-id-proof");
        const outsiderFile = await createFile(outsider, "tenant-b-id-proof");

        await expect(insertIntent({
            tenantId: owner.tenantId,
            borrowerId: outsiderBorrower.id,
            fileId: ownerFile.id,
        })).rejects.toMatchObject({ cause: { code: "23503" } });
        await expect(insertIntent({
            tenantId: owner.tenantId,
            borrowerId: ownerBorrower.id,
            fileId: outsiderFile.id,
        })).rejects.toMatchObject({ cause: { code: "23503" } });
        await expect(insertIntent({
            tenantId: owner.tenantId,
            borrowerId: ownerBorrower.id,
            fileId: ownerFile.id,
            evidenceHash: "a".repeat(64),
            createdByUserId: outsider.id,
        }).then(async (row) => db.update(borrowerIdCardUploadIntents).set({ createdByUserId: outsider.id }).where(sql`id = ${row.id}`))).rejects.toMatchObject({ cause: { code: "23503" } });
        await expect(insertIntent({
            tenantId: owner.tenantId,
            borrowerId: ownerBorrower.id,
            fileId: ownerFile.id,
            evidenceHash: "f".repeat(64),
            updatedByUserId: outsider.id,
        }).then(async (row) => db.update(borrowerIdCardUploadIntents).set({ updatedByUserId: outsider.id }).where(sql`id = ${row.id}`))).rejects.toMatchObject({ cause: { code: "23503" } });
    });

    integrationTest("rejects terminal direct inserts and scopes idempotency keys by tenant", async () => {
        const owner = await actor("tenant-idempotency-a");
        const other = await actor("tenant-idempotency-b");
        const borrower = await createBorrower(owner);
        const otherBorrower = await createBorrower(other);
        const file = await createFile(owner, "idempotency-a");
        const otherFile = await createFile(other, "idempotency-b");

        await expect(insertIntent({ tenantId: owner.tenantId, borrowerId: borrower.id, fileId: file.id, status: "ready", finalizedAt: new Date(), evidenceHash: "1".repeat(64) }))
            .rejects.toMatchObject({ cause: { code: "P0001" } });
        await expect(insertIntent({
            tenantId: owner.tenantId,
            borrowerId: borrower.id,
            fileId: file.id,
            status: "applied",
            finalizedAt: new Date(),
            appliedAt: new Date(),
            applyRequestHash: "a".repeat(64),
            idempotencyKey: "direct-applied-key",
            evidenceHash: "1".repeat(64),
        }))
            .rejects.toMatchObject({ cause: { code: "P0001" } });
        const first = await insertIntent({ tenantId: owner.tenantId, borrowerId: borrower.id, fileId: file.id, evidenceHash: "2".repeat(64) });
        await db.update(borrowerIdCardUploadIntents).set({ status: "ready", finalizedAt: new Date() }).where(sql`id = ${first.id}`);
        await db.update(borrowerIdCardUploadIntents).set({ status: "applied", appliedAt: new Date(), applyRequestHash: "3".repeat(64), idempotencyKey: "shared-key" }).where(sql`id = ${first.id}`);
        await expect(insertIntent({ tenantId: owner.tenantId, borrowerId: borrower.id, fileId: file.id, evidenceHash: "4".repeat(64) }))
            .resolves.toBeDefined();
        const second = await insertIntent({ tenantId: owner.tenantId, borrowerId: borrower.id, fileId: file.id, evidenceHash: "5".repeat(64) });
        await db.update(borrowerIdCardUploadIntents).set({ status: "ready", finalizedAt: new Date() }).where(sql`id = ${second.id}`);
        const duplicateIdempotencyError = await db.update(borrowerIdCardUploadIntents)
            .set({ status: "applied", appliedAt: new Date(), applyRequestHash: "6".repeat(64), idempotencyKey: "shared-key" })
            .where(sql`id = ${second.id}`)
            .then(() => null, (error) => error);
        expect(duplicateIdempotencyError).toMatchObject({ cause: { code: "23505" } });

        const blankIdempotencyRow = await insertIntent({
            tenantId: owner.tenantId,
            borrowerId: borrower.id,
            fileId: file.id,
            evidenceHash: "9".repeat(64),
        });
        await db.update(borrowerIdCardUploadIntents)
            .set({ status: "ready", finalizedAt: new Date() })
            .where(sql`id = ${blankIdempotencyRow.id}`);
        const blankIdempotencyError = await db.update(borrowerIdCardUploadIntents)
            .set({ status: "applied", appliedAt: new Date(), applyRequestHash: "b".repeat(64), idempotencyKey: "" })
            .where(sql`id = ${blankIdempotencyRow.id}`)
            .then(() => null, (error) => error);
        expect(blankIdempotencyError).toMatchObject({ cause: { code: "23514" } });
        const otherRow = await insertIntent({ tenantId: other.tenantId, borrowerId: otherBorrower.id, fileId: otherFile.id, evidenceHash: "7".repeat(64) });
        await db.update(borrowerIdCardUploadIntents).set({ status: "ready", finalizedAt: new Date() }).where(sql`id = ${otherRow.id}`);
        await db.update(borrowerIdCardUploadIntents)
            .set({ status: "applied", appliedAt: new Date(), applyRequestHash: "8".repeat(64), idempotencyKey: "shared-key" })
            .where(sql`id = ${otherRow.id}`);
    });

    integrationTest("database prevents mutation or deletion after apply", async () => {
        const owner = await actor("tenant-idempotent");
        const borrower = await createBorrower(owner, "Applied borrower");
        const file = await createFile(owner, "applied-proof");
        const appliedAt = new Date(Date.now() + 5 * 60_000);
        const row = await insertIntent({
            tenantId: owner.tenantId,
            borrowerId: borrower.id,
            fileId: file.id,
            evidenceHash: "8".repeat(64),
        });

        await db.update(borrowerIdCardUploadIntents).set({ status: "ready", finalizedAt: new Date(Date.now() + 60_000) }).where(sql`id = ${row.id}`);
        await db.update(borrowerIdCardUploadIntents).set({ status: "applied", appliedAt, applyRequestHash: "9".repeat(64), idempotencyKey: "immutable-key" }).where(sql`id = ${row.id}`);

        const updateError = await db.update(borrowerIdCardUploadIntents)
            .set({ evidenceHash: "b".repeat(64) })
            .where(sql`id = ${row.id}`)
            .then(() => null, (error) => error);
        const deleteError = await db.delete(borrowerIdCardUploadIntents)
            .where(sql`id = ${row.id}`)
            .then(() => null, (error) => error);

        expect(updateError).toMatchObject({ cause: { code: "P0001" } });
        expect(deleteError).toMatchObject({ cause: { code: "P0001" } });
    });

    integrationTest("prevents mutation or deletion after finalize", async () => {
        const owner = await actor("tenant-ready-immutable");
        const borrower = await createBorrower(owner, "Ready borrower");
        const file = await createFile(owner, "ready-proof");
        const row = await insertIntent({
            tenantId: owner.tenantId,
            borrowerId: borrower.id,
            fileId: file.id,
            evidenceHash: "b".repeat(64),
        });

        await db.update(borrowerIdCardUploadIntents).set({ status: "ready", finalizedAt: new Date() }).where(sql`id = ${row.id}`);

        const updateError = await db.update(borrowerIdCardUploadIntents)
            .set({ fileId: file.id + 1 })
            .where(sql`id = ${row.id}`)
            .then(() => null, (error) => error);
        const deleteError = await db.delete(borrowerIdCardUploadIntents)
            .where(sql`id = ${row.id}`)
            .then(() => null, (error) => error);

        expect(updateError).toMatchObject({ cause: { code: "P0001" } });
        expect(deleteError).toMatchObject({ cause: { code: "P0001" } });
    });
});
