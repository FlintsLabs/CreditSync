import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { files, paymentEvidence, paymentEvidenceSupplements, paymentReplacementEvidenceReferences } from "../db/schema";

export type EffectivePaymentEvidence = {
    consumingIntakeId: number;
    sourceIntakeId: number;
    sourceEvidenceId: number;
    publicId: string;
    fileId: number | null;
    mimeType: string | null;
    declaredSize: number | null;
    status: "ready" | "pending" | "rejected";
    evidenceHash: string | null;
    finalizedAt: Date | null;
    source: "direct" | "supplement" | "referenced";
    reason?: string | null;
};

/** Resolve direct evidence and immutable replacement references without counting one source twice. */
export async function effectivePaymentEvidence(tenantId: string, intakeIds: number[], executor: DbExecutor = db) {
    const result = new Map<number, EffectivePaymentEvidence[]>();
    if (!intakeIds.length) return result;
    const direct = await executor.select().from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, tenantId), inArray(paymentEvidence.paymentIntakeId, intakeIds)));
    const supplements = await executor.select().from(paymentEvidenceSupplements).where(and(eq(paymentEvidenceSupplements.tenantId, tenantId), inArray(paymentEvidenceSupplements.paymentIntakeId, intakeIds), eq(paymentEvidenceSupplements.status, "recorded")));
    const refs = await executor.select({ consumingIntakeId: paymentReplacementEvidenceReferences.replacementPaymentIntakeId, sourceIntakeId: paymentReplacementEvidenceReferences.sourcePaymentIntakeId, sourceEvidenceId: paymentReplacementEvidenceReferences.sourceEvidenceId, sourceSupplementId: paymentReplacementEvidenceReferences.sourceSupplementId })
        .from(paymentReplacementEvidenceReferences).where(and(eq(paymentReplacementEvidenceReferences.tenantId, tenantId), inArray(paymentReplacementEvidenceReferences.replacementPaymentIntakeId, intakeIds)));
    const referencedIds = refs.flatMap((row) => row.sourceEvidenceId === null ? [] : [row.sourceEvidenceId]);
    const referenced = referencedIds.length ? await executor.select().from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, tenantId), inArray(paymentEvidence.id, referencedIds))) : [];
    const supplementIds = refs.flatMap((row) => row.sourceSupplementId === null ? [] : [row.sourceSupplementId]);
    const referencedSupplements = supplementIds.length ? await executor.select().from(paymentEvidenceSupplements).where(and(eq(paymentEvidenceSupplements.tenantId, tenantId), inArray(paymentEvidenceSupplements.id, supplementIds), eq(paymentEvidenceSupplements.status, "recorded"))) : [];
    const directByIntake = new Map<number, typeof direct[number][]>();
    for (const row of direct) directByIntake.set(row.paymentIntakeId, [...(directByIntake.get(row.paymentIntakeId) ?? []), row]);
    for (const intakeId of intakeIds) {
        const seen = new Set<number>();
        const rows: EffectivePaymentEvidence[] = [];
        for (const row of directByIntake.get(intakeId) ?? []) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            rows.push({ consumingIntakeId: intakeId, sourceIntakeId: row.paymentIntakeId, sourceEvidenceId: row.id, publicId: row.publicId, fileId: row.fileId, mimeType: row.mimeType, declaredSize: row.declaredSize, status: row.status as EffectivePaymentEvidence["status"], evidenceHash: row.evidenceHash, finalizedAt: row.finalizedAt, source: "direct" });
        }
        for (const row of supplements.filter((item) => item.paymentIntakeId === intakeId)) {
            const syntheticId = -row.id;
            if (seen.has(syntheticId)) continue;
            seen.add(syntheticId);
            rows.push({ consumingIntakeId: intakeId, sourceIntakeId: row.paymentIntakeId, sourceEvidenceId: syntheticId, publicId: row.publicId, fileId: row.fileId, mimeType: row.mimeType, declaredSize: row.declaredSize, status: "ready", evidenceHash: row.evidenceHash, finalizedAt: row.recordedAt ?? row.readyAt, source: "supplement", reason: row.reason });
        }
        for (const ref of refs.filter((item) => item.consumingIntakeId === intakeId)) {
            if (ref.sourceEvidenceId !== null) {
                const row = referenced.find((item) => item.id === ref.sourceEvidenceId);
                if (!row || seen.has(row.id)) continue;
                seen.add(row.id);
                rows.push({ consumingIntakeId: intakeId, sourceIntakeId: row.paymentIntakeId, sourceEvidenceId: row.id, publicId: row.publicId, fileId: row.fileId, mimeType: row.mimeType, declaredSize: row.declaredSize, status: row.status as EffectivePaymentEvidence["status"], evidenceHash: row.evidenceHash, finalizedAt: row.finalizedAt, source: "referenced" });
            } else if (ref.sourceSupplementId !== null) {
                const row = referencedSupplements.find((item) => item.id === ref.sourceSupplementId);
                const syntheticId = row ? -row.id : ref.sourceSupplementId;
                if (!row || seen.has(syntheticId)) continue;
                seen.add(syntheticId);
                rows.push({ consumingIntakeId: intakeId, sourceIntakeId: row.paymentIntakeId, sourceEvidenceId: syntheticId, publicId: row.publicId, fileId: row.fileId, mimeType: row.mimeType, declaredSize: row.declaredSize, status: "ready", evidenceHash: row.evidenceHash, finalizedAt: row.recordedAt ?? row.readyAt, source: "referenced", reason: row.reason });
            }
        }
        result.set(intakeId, rows);
    }
    return result;
}

export async function effectiveReadyPaymentEvidence(tenantId: string, intakeId: number, executor: DbExecutor = db) {
    const rows = (await effectivePaymentEvidence(tenantId, [intakeId], executor)).get(intakeId) ?? [];
    return rows.filter((row) => row.status === "ready" && row.finalizedAt !== null && row.fileId !== null);
}

export async function effectivePaymentEvidenceFiles(tenantId: string, intakeId: number, executor: DbExecutor = db) {
    const rows = await effectiveReadyPaymentEvidence(tenantId, intakeId, executor);
    const ids = rows.flatMap((row) => row.fileId === null ? [] : [row.fileId]);
    if (!ids.length) return [];
    const fileRows = await executor.select({ id: files.id, publicId: files.publicId }).from(files).where(and(eq(files.tenantId, tenantId), inArray(files.id, ids)));
    const byId = new Map(fileRows.map((row) => [row.id, row.publicId]));
    return rows.flatMap((row) => row.fileId !== null && byId.has(row.fileId) ? [{ ...row, filePublicId: byId.get(row.fileId)! }] : []);
}

export async function effectivePaymentEvidenceWithFiles(tenantId: string, intakeId: number, executor: DbExecutor = db) {
    const rows = (await effectivePaymentEvidence(tenantId, [intakeId], executor)).get(intakeId) ?? [];
    const ids = rows.flatMap((row) => row.fileId === null ? [] : [row.fileId]);
    const fileRows = ids.length ? await executor.select({ id: files.id, publicId: files.publicId }).from(files).where(and(eq(files.tenantId, tenantId), inArray(files.id, ids))) : [];
    const byId = new Map(fileRows.map((row) => [row.id, row.publicId]));
    return rows.map((row) => ({ ...row, filePublicId: row.fileId === null ? null : byId.get(row.fileId) ?? null }));
}
