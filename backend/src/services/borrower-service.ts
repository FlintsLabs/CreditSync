import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { borrowerAliases, borrowers, loans, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData } from "../lib/access";
import { invalidateTenantCache } from "../lib/cache";
import { serializeMoney } from "../lib/money";
import { DomainError } from "./domain-error";
import type { CommandContext } from "./command-context";

export function normalizeBorrowerText(value: string): string {
    return value
        .normalize("NFKC")
        .toLocaleLowerCase("und")
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

type BorrowerRow = typeof borrowers.$inferSelect;
type AliasRow = typeof borrowerAliases.$inferSelect;

export interface BorrowerInput {
    name: string;
    idCardNumber?: string | null;
    phone?: string | null;
    address?: string | null;
    creditScore?: number | null;
    notes?: string | null;
    idCardImageUrl?: string | null;
    tags?: string[] | null;
    googleMapsUrl?: string | null;
}

export type BorrowerUpdateInput = Partial<BorrowerInput>;

export function presentBorrower(row: BorrowerRow) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        name: row.name,
        idCardNumber: row.idCardNumber,
        phone: row.phone,
        address: row.address,
        photoUrl: row.photoUrl,
        idCardImageUrl: row.idCardImageUrl,
        creditScore: row.creditScore,
        tags: row.tags,
        googleMapsUrl: row.googleMapsUrl,
        notes: row.notes,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function presentAlias(row: AliasRow) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        alias: row.alias,
        normalizedAlias: row.normalizedAlias,
        source: row.source,
        status: row.status,
        confirmedAt: row.confirmedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

async function actorFor(ctx: CommandContext) {
    if (ctx.actorUserId === null) return null;
    const actor = await db.query.users.findFirst({
        where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)),
    });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

async function accessibleBorrowerRows(ctx: CommandContext): Promise<BorrowerRow[]> {
    const actor = await actorFor(ctx);
    const conditions = [eq(borrowers.tenantId, ctx.tenantId)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        conditions.push(eq(borrowers.ownerUserId, actor.id));
    }
    return db.select().from(borrowers).where(and(...conditions));
}

async function accessibleBorrower(ctx: CommandContext, publicId: string): Promise<BorrowerRow> {
    const rows = await accessibleBorrowerRows(ctx);
    const row = rows.find((candidate) => candidate.publicId === publicId);
    if (!row) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
    return row;
}

function auditContext(ctx: CommandContext) {
    return {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
    };
}

export async function createBorrower(ctx: CommandContext, input: BorrowerInput) {
    if (!input.name?.trim()) throw new DomainError("INVALID_BORROWER", "Borrower name is required", 400);
    await actorFor(ctx);
    const created = await db.transaction(async (tx) => {
        const row = await tx.insert(borrowers).values({
            tenantId: ctx.tenantId,
            ownerUserId: ctx.actorUserId,
            ...input,
            name: input.name.trim(),
        }).returning().then((rows) => rows[0]!);
        const after = presentBorrower(row);
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "borrower",
            entityId: row.publicId,
            action: "created",
            payload: { before: null, after },
        });
        return after;
    });
    return created;
}

export async function updateBorrower(ctx: CommandContext, publicId: string, input: BorrowerUpdateInput) {
    const existing = await accessibleBorrower(ctx, publicId);
    if (input.name !== undefined && !input.name.trim()) {
        throw new DomainError("INVALID_BORROWER", "Borrower name is required", 400);
    }
    const updated = await db.transaction(async (tx) => {
        const row = await tx.update(borrowers).set({
            ...input,
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
            updatedAt: new Date(),
        }).where(and(eq(borrowers.id, existing.id), eq(borrowers.tenantId, ctx.tenantId)))
            .returning().then((rows) => rows[0]!);
        const before = presentBorrower(existing);
        const after = presentBorrower(row);
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "borrower",
            entityId: row.publicId,
            action: "updated",
            payload: { before, after },
        });
        return after;
    });
    await invalidateTenantCache(ctx.tenantId);
    return updated;
}

export async function searchBorrowers(ctx: CommandContext, input: { query: string }) {
    const query = normalizeBorrowerText(input.query);
    const visible = await accessibleBorrowerRows(ctx);
    if (visible.length === 0) return { resolution: "none" as const, matchType: null, candidates: [] };
    if (!query) return { resolution: "candidates" as const, matchType: "fuzzy" as const, candidates: visible.map(presentBorrower) };

    const ids = visible.map((row) => row.id);
    const aliases = await db.select().from(borrowerAliases).where(and(
        eq(borrowerAliases.tenantId, ctx.tenantId),
        eq(borrowerAliases.status, "confirmed"),
        inArray(borrowerAliases.borrowerId, ids),
    ));
    const canonicalIds = new Set(visible.filter((row) => normalizeBorrowerText(row.name) === query).map((row) => row.id));
    const aliasIds = new Set(aliases.filter((row) => row.normalizedAlias === query).map((row) => row.borrowerId));
    const exactIds = new Set([...canonicalIds, ...aliasIds]);
    if (exactIds.size > 0) {
        const exact = visible.filter((row) => exactIds.has(row.id)).map(presentBorrower);
        return {
            resolution: exact.length === 1 ? "unique" as const : "ambiguous" as const,
            matchType: canonicalIds.size > 0 ? "canonical" as const : "confirmed_alias" as const,
            candidates: exact,
        };
    }

    const aliasTextByBorrower = new Map<number, string[]>();
    for (const alias of aliases) {
        aliasTextByBorrower.set(alias.borrowerId, [...(aliasTextByBorrower.get(alias.borrowerId) ?? []), alias.normalizedAlias]);
    }
    const scored = visible.map((row) => {
        const texts = [normalizeBorrowerText(row.name), ...(aliasTextByBorrower.get(row.id) ?? [])];
        const score = Math.max(...texts.map((text) => text.includes(query) ? 2 : query.includes(text) ? 1 : 0));
        return { row, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
    return {
        resolution: scored.length ? "candidates" as const : "none" as const,
        matchType: scored.length ? "fuzzy" as const : null,
        candidates: scored.map((item) => presentBorrower(item.row)),
    };
}

export async function addBorrowerAlias(
    ctx: CommandContext,
    borrowerPublicId: string,
    input: { alias: string; source?: "manual" | "payment" | "import" },
) {
    const borrower = await accessibleBorrower(ctx, borrowerPublicId);
    const normalizedAlias = normalizeBorrowerText(input.alias);
    if (!normalizedAlias) throw new DomainError("INVALID_ALIAS", "Alias is required", 400);
    const result = await db.transaction(async (tx) => {
        const row = await tx.insert(borrowerAliases).values({
            tenantId: ctx.tenantId,
            borrowerId: borrower.id,
            alias: input.alias,
            normalizedAlias,
            source: input.source ?? "manual",
            status: "pending",
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
        }).onConflictDoNothing({
            target: [borrowerAliases.tenantId, borrowerAliases.borrowerId, borrowerAliases.normalizedAlias],
        }).returning().then((rows) => rows[0]);
        if (!row) {
            throw new DomainError("ALIAS_ALREADY_EXISTS", "Borrower alias already exists", 409, {
                borrowerPublicId,
                normalizedAlias,
            });
        }
        const after = presentAlias(row);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "borrower_alias", entityId: row.publicId,
            action: "created", payload: { before: null, after, borrowerPublicId },
        });
        return after;
    });
    await invalidateTenantCache(ctx.tenantId);
    return result;
}

async function mutateAlias(ctx: CommandContext, aliasPublicId: string, status: "confirmed" | "inactive") {
    const alias = await db.query.borrowerAliases.findFirst({
        where: and(eq(borrowerAliases.publicId, aliasPublicId), eq(borrowerAliases.tenantId, ctx.tenantId)),
    });
    if (!alias) throw new DomainError("ALIAS_NOT_FOUND", "Borrower alias not found", 404);
    const borrower = await accessibleBorrower(ctx, (await db.query.borrowers.findFirst({
        where: and(eq(borrowers.id, alias.borrowerId), eq(borrowers.tenantId, ctx.tenantId)),
    }))?.publicId ?? "");
    const result = await db.transaction(async (tx) => {
        const row = await tx.update(borrowerAliases).set({
            status,
            confirmedAt: status === "confirmed" ? new Date() : alias.confirmedAt,
            updatedByUserId: ctx.actorUserId,
            updatedAt: new Date(),
        }).where(and(eq(borrowerAliases.id, alias.id), eq(borrowerAliases.tenantId, ctx.tenantId)))
            .returning().then((rows) => rows[0]!);
        const before = presentAlias(alias);
        const after = presentAlias(row);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "borrower_alias", entityId: row.publicId,
            action: status, payload: { before, after, borrowerPublicId: borrower.publicId },
        });
        return after;
    });
    await invalidateTenantCache(ctx.tenantId);
    return result;
}

export const confirmBorrowerAlias = (ctx: CommandContext, aliasPublicId: string) =>
    mutateAlias(ctx, aliasPublicId, "confirmed");

export const deactivateBorrowerAlias = (ctx: CommandContext, aliasPublicId: string) =>
    mutateAlias(ctx, aliasPublicId, "inactive");

export async function getBorrowerPortfolio(ctx: CommandContext, borrowerPublicId: string) {
    const borrower = await accessibleBorrower(ctx, borrowerPublicId);
    const actor = await actorFor(ctx);
    const loanConditions = [eq(loans.tenantId, ctx.tenantId), eq(loans.borrowerId, borrower.id)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        loanConditions.push(eq(loans.ownerUserId, actor.id));
    }
    const [aliases, borrowerLoans] = await Promise.all([
        db.select().from(borrowerAliases).where(and(
            eq(borrowerAliases.tenantId, ctx.tenantId), eq(borrowerAliases.borrowerId, borrower.id),
        )),
        db.select().from(loans).where(and(...loanConditions)),
    ]);
    return {
        borrower: presentBorrower(borrower),
        aliases: aliases.map(presentAlias),
        loans: borrowerLoans.map((loan) => ({
            id: loan.publicId,
            publicId: loan.publicId,
            principal: serializeMoney(loan.principalAmount),
            interestRate: serializeMoney(loan.interestRate),
            repaymentType: loan.repaymentType,
            status: loan.status,
            startDate: loan.startDate,
            createdAt: loan.createdAt,
        })),
    };
}
