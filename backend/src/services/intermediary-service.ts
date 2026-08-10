import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, intermediaries, intermediaryCollections, loans, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData } from "../lib/access";
import { parseMoney, serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

export function normalizeIntermediaryText(value: string) {
    return value.normalize("NFKC").toLocaleLowerCase("und")
        .replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function referenceHash(value?: string | null) {
    const normalized = value?.normalize("NFKC").toLocaleLowerCase("und").replace(/[\p{P}\p{S}\s]+/gu, "") ?? "";
    return normalized ? createHash("sha256").update(normalized).digest("hex") : null;
}

function auditContext(ctx: CommandContext) {
    return { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId };
}

async function actorFor(ctx: CommandContext) {
    if (ctx.actorUserId === null) return null;
    const actor = await db.query.users.findFirst({ where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

function presentIntermediary(row: typeof intermediaries.$inferSelect) {
    return { publicId: row.publicId, name: row.name, aliases: row.aliases, notes: row.notes, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function presentCollection(row: typeof intermediaryCollections.$inferSelect) {
    return { publicId: row.publicId, intermediaryId: row.intermediaryId, borrowerId: row.borrowerId, loanId: row.loanId, amount: serializeMoney(row.amount), borrowerPaidAt: row.borrowerPaidAt.toISOString(), status: row.status, bankReference: row.bankReference, note: row.note, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function createIntermediary(ctx: CommandContext, input: { name: string; aliases?: string[]; notes?: string | null }) {
    const name = input.name?.trim();
    const normalizedName = normalizeIntermediaryText(name ?? "");
    if (!name || !normalizedName) throw new DomainError("INVALID_INTERMEDIARY", "Intermediary name is required", 400);
    await actorFor(ctx);
    const existing = await db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.normalizedName, normalizedName)) });
    if (existing) return presentIntermediary(existing);
    return db.transaction(async (tx) => {
        const row = await tx.insert(intermediaries).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, name, normalizedName, aliases: input.aliases ?? [], notes: input.notes ?? null, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        const after = presentIntermediary(row);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary", entityId: row.publicId, action: "created", payload: { before: null, after } });
        return after;
    });
}

export async function listIntermediaries(ctx: CommandContext, status: "active" | "inactive" | "all" = "active") {
    const actor = await actorFor(ctx);
    const conditions = [eq(intermediaries.tenantId, ctx.tenantId)];
    if (status !== "all") conditions.push(eq(intermediaries.status, status));
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) conditions.push(eq(intermediaries.ownerUserId, actor.id));
    return (await db.select().from(intermediaries).where(and(...conditions))).map(presentIntermediary);
}

export async function searchIntermediaries(ctx: CommandContext, query: string) {
    const normalized = normalizeIntermediaryText(query);
    const rows = await listIntermediaries(ctx, "active");
    return rows.filter((row) => normalizeIntermediaryText(row.name).includes(normalized) || row.aliases.some((alias) => normalizeIntermediaryText(alias).includes(normalized)));
}

export async function updateIntermediary(ctx: CommandContext, publicId: string, changes: { name?: string; aliases?: string[]; notes?: string | null; status?: "active" | "inactive" }) {
    await actorFor(ctx);
    const existing = await db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, publicId)) });
    if (!existing) throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
    const name = changes.name?.trim();
    if (changes.name !== undefined && !name) throw new DomainError("INVALID_INTERMEDIARY", "Intermediary name is required", 400);
    return db.transaction(async (tx) => {
        const row = await tx.update(intermediaries).set({ ...changes, ...(name ? { name, normalizedName: normalizeIntermediaryText(name) } : {}), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(intermediaries.id, existing.id)).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary", entityId: row.publicId, action: "updated", payload: { before: presentIntermediary(existing), after: presentIntermediary(row) } });
        return presentIntermediary(row);
    });
}

export interface CreateIntermediaryCollectionInput {
    intermediaryPublicId: string;
    borrowerPublicId: string;
    loanPublicId: string;
    amount: string;
    borrowerPaidAt: string;
    bankReference?: string | null;
    note?: string | null;
}

export async function createIntermediaryCollection(ctx: CommandContext, input: CreateIntermediaryCollectionInput) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    const amount = parseMoney(input.amount);
    if (!amount.gt(0)) throw new DomainError("INVALID_COLLECTION_AMOUNT", "Collection amount must be greater than zero", 400);
    const borrowerPaidAt = new Date(input.borrowerPaidAt);
    if (Number.isNaN(borrowerPaidAt.getTime())) throw new DomainError("INVALID_BORROWER_PAID_AT", "Borrower paid time must be ISO 8601", 400);
    const actor = await actorFor(ctx);
    const replay = await db.query.intermediaryCollections.findFirst({ where: and(eq(intermediaryCollections.tenantId, ctx.tenantId), eq(intermediaryCollections.idempotencyKey, idempotencyKey)) });
    if (replay) return presentCollection(replay);
    const [intermediary, borrower, loan] = await Promise.all([
        db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, input.intermediaryPublicId)) }),
        db.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.borrowerPublicId)) }),
        db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, input.loanPublicId)) }),
    ]);
    if (!intermediary) throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
    if (!borrower || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && borrower.ownerUserId !== actor.id)) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
    if (!loan || loan.borrowerId !== borrower.id || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) throw new DomainError("LOAN_NOT_FOUND", "Loan not found for borrower", 404);
    return db.transaction(async (tx) => {
        const row = await tx.insert(intermediaryCollections).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, intermediaryId: intermediary.id, borrowerId: borrower.id, loanId: loan.id, amount: serializeMoney(amount), borrowerPaidAt, status: "pending_remittance", idempotencyKey, bankReference: input.bankReference?.trim() || null, bankReferenceHash: referenceHash(input.bankReference), note: input.note?.trim() || null, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        const after = presentCollection(row);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "intermediary_collection", entityId: row.publicId, action: "created", payload: { before: null, after } });
        return after;
    });
}

export async function getIntermediaryCollection(ctx: CommandContext, publicId: string) {
    await actorFor(ctx);
    const row = await db.query.intermediaryCollections.findFirst({ where: and(eq(intermediaryCollections.tenantId, ctx.tenantId), eq(intermediaryCollections.publicId, publicId)) });
    if (!row) throw new DomainError("INTERMEDIARY_COLLECTION_NOT_FOUND", "Intermediary collection not found", 404);
    return presentCollection(row);
}

export async function listIntermediaryCollections(ctx: CommandContext, filters: { intermediaryPublicId?: string; status?: string } = {}) {
    await actorFor(ctx);
    const conditions = [eq(intermediaryCollections.tenantId, ctx.tenantId)];
    if (filters.status) conditions.push(eq(intermediaryCollections.status, filters.status));
    if (filters.intermediaryPublicId) {
        const intermediary = await db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, filters.intermediaryPublicId)) });
        if (!intermediary) return [];
        conditions.push(eq(intermediaryCollections.intermediaryId, intermediary.id));
    }
    return (await db.select().from(intermediaryCollections).where(and(...conditions))).map(presentCollection);
}
