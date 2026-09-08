import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { files, paymentEvidence, paymentEvidenceSupplements } from "../db/schema";

export type SafePaymentEvidenceSummary = {
    publicId: string;
    filePublicId: string;
    mimeType: string;
    source: "primary" | "supplement";
    reason?: "upload_channel_unavailable" | "operator_omission" | "evidence_recovered" | "other";
};

export function safePaymentEvidenceSummary(input: {
    publicId: string; filePublicId: string; mimeType: string; source: "primary" | "supplement"; reason?: string | null;
}): SafePaymentEvidenceSummary {
    return {
        publicId: input.publicId,
        filePublicId: input.filePublicId,
        mimeType: input.mimeType,
        source: input.source,
        ...(input.source === "supplement" && input.reason ? { reason: input.reason as SafePaymentEvidenceSummary["reason"] } : {}),
    };
}

export async function paymentEvidenceSummariesByIntake(tenantId: string, intakeIds: number[], executor: DbExecutor = db) {
    const result = new Map<number, SafePaymentEvidenceSummary[]>();
    if (!intakeIds.length) return result;
    const [primary, supplements] = await Promise.all([
        executor.select({ intakeId: paymentEvidence.paymentIntakeId, publicId: paymentEvidence.publicId, fileId: paymentEvidence.fileId, mimeType: paymentEvidence.mimeType })
            .from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, tenantId), inArray(paymentEvidence.paymentIntakeId, intakeIds), eq(paymentEvidence.status, "ready"), isNotNull(paymentEvidence.finalizedAt), isNotNull(paymentEvidence.fileId), isNotNull(paymentEvidence.mimeType))),
        executor.select({ intakeId: paymentEvidenceSupplements.paymentIntakeId, publicId: paymentEvidenceSupplements.publicId, fileId: paymentEvidenceSupplements.fileId, mimeType: paymentEvidenceSupplements.mimeType, reason: paymentEvidenceSupplements.reason })
            .from(paymentEvidenceSupplements).where(and(eq(paymentEvidenceSupplements.tenantId, tenantId), inArray(paymentEvidenceSupplements.paymentIntakeId, intakeIds), eq(paymentEvidenceSupplements.status, "recorded"), isNotNull(paymentEvidenceSupplements.mimeType), isNotNull(paymentEvidenceSupplements.reason))),
    ]);
    const fileIds = [...new Set([...primary.flatMap((row) => row.fileId ? [row.fileId] : []), ...supplements.map((row) => row.fileId)])];
    const fileRows = fileIds.length ? await executor.select({ id: files.id, publicId: files.publicId }).from(files).where(and(eq(files.tenantId, tenantId), inArray(files.id, fileIds))) : [];
    const fileById = new Map(fileRows.map((row) => [row.id, row.publicId]));
    for (const row of primary) {
        const filePublicId = row.fileId ? fileById.get(row.fileId) : undefined;
        if (!filePublicId || !row.mimeType) continue;
        result.set(row.intakeId, [...(result.get(row.intakeId) ?? []), safePaymentEvidenceSummary({ publicId: row.publicId, filePublicId, mimeType: row.mimeType, source: "primary" })]);
    }
    for (const row of supplements) {
        const filePublicId = fileById.get(row.fileId);
        if (!filePublicId || !row.mimeType || !row.reason) continue;
        result.set(row.intakeId, [...(result.get(row.intakeId) ?? []), safePaymentEvidenceSummary({ publicId: row.publicId, filePublicId, mimeType: row.mimeType, source: "supplement", reason: row.reason })]);
    }
    return result;
}
