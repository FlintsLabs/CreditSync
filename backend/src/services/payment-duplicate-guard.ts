import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { paymentIntakes, paymentReplacementLineages } from "../db/schema";
import { reviewAuthorizesPair } from "./payment-duplicate-review-service";
import { normalizeBorrowerText } from "./borrower-service";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { classifyPaymentWorkflowBlocker, type PaymentWorkflowBlocker } from "./payment-workflow-blockers";
import { identityDecisionAuthorizesPair, inspectPaymentIdentity } from "./payment-identity-decision-service";
import { lockPaymentWorkflowIdentity } from "./payment-workflow-locks";

const duplicateWindowMs = 5 * 60 * 1000;

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function ancestorChain(current: typeof paymentIntakes.$inferSelect, rows: Array<typeof paymentIntakes.$inferSelect>, lineages: Array<typeof paymentReplacementLineages.$inferSelect>) {
    const ids = new Set<number>([current.id]);
    let cursor = current.replacementOfIntakeId;
    while (cursor !== null && !ids.has(cursor)) {
        ids.add(cursor);
        cursor = rows.find((row) => row.id === cursor)?.replacementOfIntakeId ?? null;
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const lineage of lineages) {
            if (ids.has(lineage.sourcePaymentIntakeId) || ids.has(lineage.replacementPaymentIntakeId)) {
                if (!ids.has(lineage.sourcePaymentIntakeId)) { ids.add(lineage.sourcePaymentIntakeId); changed = true; }
                if (!ids.has(lineage.replacementPaymentIntakeId)) { ids.add(lineage.replacementPaymentIntakeId); changed = true; }
            }
        }
    }
    for (const row of rows) if (row.status === "duplicate" && row.duplicateOfIntakeId !== null && ids.has(row.duplicateOfIntakeId)) ids.add(row.id);
    return ids;
}

function warningReferencesOnlyKnownChain(warnings: unknown, chain: Set<number>, rows: Array<typeof paymentIntakes.$inferSelect>, acceptedReviewedIds: Set<string>) {
    if (!Array.isArray(warnings)) return true;
    const publicToId = new Map(rows.map((row) => [row.publicId, row.id]));
    return warnings.every((warning) => {
        if (!warning || typeof warning !== "object") return false;
        const ids = (warning as { intakePublicIds?: unknown }).intakePublicIds;
        if (!Array.isArray(ids) || ids.length === 0) return false;
        return ids.every((id) => typeof id === "string" && ((publicToId.has(id) && chain.has(publicToId.get(id)!)) || acceptedReviewedIds.has(id)));
    });
}

export async function assessPaymentReplacementDuplicates(ctx: CommandContext, intake: typeof paymentIntakes.$inferSelect, executor: DbExecutor = db, forceReplacement = false) {
    const rows = await executor.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, ctx.tenantId));
    const lineages = await executor.select().from(paymentReplacementLineages).where(eq(paymentReplacementLineages.tenantId, ctx.tenantId));
    // Ordinary payment preview/post must use the same duplicate decision
    // reader as replacements. `forceReplacement` only controls replacement
    // lifecycle semantics; it is not an authorization bypass.
    const chain = ancestorChain(intake, rows, lineages);
    const identities = lineages.filter((lineage) => chain.has(lineage.sourcePaymentIntakeId) || chain.has(lineage.replacementPaymentIntakeId));
    const bankHashes = new Set(identities.map((lineage) => lineage.bankReferenceHash).filter((value): value is string => !!value));
    const qrHashes = new Set(identities.map((lineage) => lineage.qrPayloadHash).filter((value): value is string => !!value));
    if (intake.bankReferenceHash) bankHashes.add(intake.bankReferenceHash);
    if (intake.qrPayloadHash) qrHashes.add(intake.qrPayloadHash);
    const own = rows.filter((row) => chain.has(row.id));
    const blockerPublicIds: string[] = [];
    for (const row of rows) {
        if (chain.has(row.id)) continue;
        const identityReviewed = (await Promise.all([...chain].map(async (chainId) => {
            const chainRow = rows.find((candidate) => candidate.id === chainId);
            return chainRow ? identityDecisionAuthorizesPair(ctx, chainRow.publicId, row.publicId, executor) : false;
        }))).some(Boolean);
        if (identityReviewed) continue;
        // A same-payment decision is not a duplicate exemption once any
        // member already has an active financial effect. This check is
        // independent of the five-minute heuristic, so a late retry cannot
        // reopen a second posting route.
        const identityConflict = await Promise.all([...chain].map(async (chainId) => {
            const chainRow = rows.find((candidate) => candidate.id === chainId);
            if (!chainRow) return false;
            const identity = await inspectPaymentIdentity(ctx, [chainRow.publicId, row.publicId], executor);
            if (!identity.connected) return false;
            if (identity.activeFinancialEffectCount > 0) blockerPublicIds.push(row.publicId);
            return true;
        }));
        if (identityConflict.some(Boolean)) continue;
        const reviewedByChain = (await Promise.all([...chain].map((canonicalId) => reviewAuthorizesPair(ctx, canonicalId, row.id, executor)))).some(Boolean);
        if (reviewedByChain) continue;
        if ((row.bankReferenceHash && bankHashes.has(row.bankReferenceHash)) || (row.qrPayloadHash && qrHashes.has(row.qrPayloadHash))) {
            blockerPublicIds.push(row.publicId);
        }
        if (row.amount === intake.amount && row.payerName && intake.payerName && normalizeBorrowerText(row.payerName) === normalizeBorrowerText(intake.payerName) && Math.abs(row.receivedAt.getTime() - intake.receivedAt.getTime()) <= duplicateWindowMs) {
            blockerPublicIds.push(row.publicId);
        }
    }
    const acceptedReviewedIds = new Set<string>();
    for (const row of rows) {
        for (const canonicalId of chain) {
            const canonical = rows.find((candidate) => candidate.id === canonicalId);
            if (canonical && (await reviewAuthorizesPair(ctx, canonical.id, row.id, executor) || await identityDecisionAuthorizesPair(ctx, canonical.publicId, row.publicId, executor))) acceptedReviewedIds.add(row.publicId);
        }
    }
    if (!warningReferencesOnlyKnownChain(intake.warnings, chain, rows, acceptedReviewedIds)) {
        blockerPublicIds.push(...own.map((row) => row.publicId));
    }
    const uniqueBlockerPublicIds = [...new Set(blockerPublicIds)];
    return { blockerPublicIds: uniqueBlockerPublicIds, blockers: uniqueBlockerPublicIds.length
        ? [classifyPaymentWorkflowBlocker("PAYMENT_DUPLICATE_REQUIRES_REVIEW", uniqueBlockerPublicIds)]
        : [] as PaymentWorkflowBlocker[] };
}

export async function assertPaymentReplacementDuplicateSafe(ctx: CommandContext, intake: typeof paymentIntakes.$inferSelect, executor: DbExecutor = db, forceReplacement = false) {
    const rows = await executor.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, ctx.tenantId));
    const lineages = await executor.select().from(paymentReplacementLineages).where(eq(paymentReplacementLineages.tenantId, ctx.tenantId));
    const isReplacement = intake.replacementOfIntakeId !== null || lineages.some((lineage) => lineage.sourcePaymentIntakeId === intake.id || lineage.replacementPaymentIntakeId === intake.id);
    const result = await assessPaymentReplacementDuplicates(ctx, intake, executor, forceReplacement);
    if (result.blockerPublicIds.length) throw new DomainError("PAYMENT_DUPLICATE_REQUIRES_REVIEW", "An unrelated payment requires explicit duplicate review", 409, { blockerPublicIds: result.blockerPublicIds, blockers: result.blockers });
}

export async function duplicateIdentityLock(ctx: CommandContext, input: { bankReferenceHash?: string | null; qrPayloadHash?: string | null; amount: string; payerName?: string | null; receivedAt: Date }, executor: DbExecutor = db) {
    const minute = Math.floor(input.receivedAt.getTime() / 60_000);
    const semanticKeys = Array.from({ length: 9 }, (_, index) => hash(`${new Decimal(input.amount).toFixed(2)}:${normalizeBorrowerText(input.payerName ?? "")}:${minute + index - 4}`));
    await lockPaymentWorkflowIdentity(ctx, executor, [
        input.bankReferenceHash ? `bank:${input.bankReferenceHash}` : "",
        input.qrPayloadHash ? `qr:${input.qrPayloadHash}` : "",
        ...semanticKeys.map((key) => `semantic:${key}`),
    ]);
    const keys = ["tenant-identity", input.bankReferenceHash, input.qrPayloadHash, ...semanticKeys].filter((value): value is string => !!value);
    for (const key of [...new Set(keys)].sort()) await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-duplicate:${ctx.tenantId}:${key}`}, 0))`);
}
