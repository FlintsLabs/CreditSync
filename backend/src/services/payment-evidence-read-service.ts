import { db, type DbExecutor } from "../db";
import { effectivePaymentEvidenceFiles } from "./payment-effective-evidence-service";

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
    for (const intakeId of intakeIds) {
        const rows = await effectivePaymentEvidenceFiles(tenantId, intakeId, executor);
        result.set(intakeId, rows.map((row) => safePaymentEvidenceSummary({ publicId: row.publicId, filePublicId: row.filePublicId, mimeType: row.mimeType ?? "application/octet-stream", source: row.source === "supplement" ? "supplement" : "primary", reason: row.reason })));
    }
    return result;
}
