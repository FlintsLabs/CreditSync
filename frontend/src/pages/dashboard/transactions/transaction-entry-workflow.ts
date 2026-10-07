import { createPaymentWorkflow, normalizeMoney, type HttpClient, type PaymentAllocationInput, type PaymentWorkflowInput } from "../../../lib/workflow-api";

export interface ReceiptCommandContext { idempotencyKey: string; requestId: string; correlationId: string }
export interface ReceiptEntrySnapshot { receipt: PaymentWorkflowInput; allocations: PaymentAllocationInput[]; files: File[]; context: ReceiptCommandContext }
export interface ReceiptEntryProgress { intakePublicId?: string; files: Record<string, { evidencePublicId: string; status: "pending" | "ready" }> }

export interface ReceiptWorkflowError extends Error { code: string; intakePublicId?: string; reviewTargetPublicId?: string }
type Dependencies = { put: typeof fetch; sha256: (file: File) => Promise<string> };
type EvidenceIntent = { publicId: string; status?: string; uploadUrl?: string; requiredHeaders?: Record<string, string>; duplicate?: boolean };

function workflowError(code: string, message: string, intakePublicId?: string, reviewTargetPublicId?: string): ReceiptWorkflowError {
    return Object.assign(new Error(message), { code, ...(intakePublicId ? { intakePublicId } : {}), ...(reviewTargetPublicId ? { reviewTargetPublicId } : {}) });
}

function tracingConfig(snapshot: ReceiptEntrySnapshot) {
    return { headers: { "X-Request-Id": snapshot.context.requestId, "X-Correlation-Id": snapshot.context.correlationId } };
}

async function browserSha256(file: File): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function updateProgress(progress: ReceiptEntryProgress, patch: Partial<ReceiptEntryProgress>, onProgress: (next: ReceiptEntryProgress) => void) {
    Object.assign(progress, patch);
    onProgress({ intakePublicId: progress.intakePublicId, files: { ...progress.files } });
}

function receiptMatches(detail: Record<string, unknown>, snapshot: ReceiptEntrySnapshot) {
    const expected = snapshot.receipt;
    const requirement = detail.evidenceRequirement as { expectedCount?: number } | null | undefined;
    return detail.amount === normalizeMoney(expected.amount)
        && detail.receivedAt === expected.receivedAt
        && (detail.payerName ?? undefined) === (expected.payerName?.trim() || undefined)
        && (detail.bankReference ?? undefined) === (expected.bankReference?.trim() || undefined)
        && (detail.notes ?? undefined) === (expected.notes?.trim() || undefined)
        && (requirement?.expectedCount ?? 0) === snapshot.files.length;
}

export async function submitReceiptForReview(
    client: HttpClient,
    snapshot: ReceiptEntrySnapshot,
    progress: ReceiptEntryProgress,
    onProgress: (next: ReceiptEntryProgress) => void,
    dependencies: Dependencies = { put: (input, init) => globalThis.fetch(input, init), sha256: browserSha256 },
): Promise<{ intakePublicId: string }> {
    if (snapshot.files.length > 20) throw workflowError("TOO_MANY_EVIDENCE_FILES", "At most 20 supporting files are allowed", progress.intakePublicId);
    if (snapshot.files.some((file) => !["image/jpeg", "image/png", "application/pdf"].includes(file.type))) {
        throw workflowError("UNSUPPORTED_EVIDENCE_TYPE", "Supporting files must be JPEG, PNG, or PDF", progress.intakePublicId);
    }
    let hashes: string[];
    try { hashes = await Promise.all(snapshot.files.map((file) => dependencies.sha256(file))); }
    catch { throw workflowError("EVIDENCE_HASH_FAILED", "Supporting files could not be checked locally; review the selected files and try again", progress.intakePublicId); }
    if (new Set(hashes).size !== hashes.length) throw workflowError("DUPLICATE_EVIDENCE", "The same supporting file was selected more than once", progress.intakePublicId);

    let intakePublicId = progress.intakePublicId;
    if (!intakePublicId) {
        const result = await createPaymentWorkflow(client, {
            ...snapshot.receipt,
            amount: normalizeMoney(snapshot.receipt.amount),
            ...(snapshot.files.length ? { attachmentRequirement: { expectedCount: snapshot.files.length } } : {}),
        }, snapshot.context);
        intakePublicId = result.publicId;
        if (result.duplicate) {
            if (result.duplicateReason !== "idempotency_key") throw workflowError("DUPLICATE_PAYMENT", "This receipt matches an existing intake and requires review", undefined, intakePublicId);
            const detail = await client.get<Record<string, unknown>>(`/payment-intakes/${intakePublicId}`).then((response) => response.data);
            let originMatches = true;
            if (snapshot.receipt.originLoanPublicId) {
                const origins = await client.get<Array<Record<string, unknown>>>(`/loans/${snapshot.receipt.originLoanPublicId}/payment-intakes`).then((response) => response.data);
                originMatches = origins.some((intake) => intake.publicId === intakePublicId && intake.originLoanPublicId === snapshot.receipt.originLoanPublicId);
            }
            if (!receiptMatches(detail, snapshot) || !originMatches) throw workflowError("IDEMPOTENCY_REPLAY_MISMATCH", "The saved receipt differs from this submission and requires review", undefined, intakePublicId);
        }
        updateProgress(progress, { intakePublicId }, onProgress);
    }

    for (const [index, file] of snapshot.files.entries()) {
        const sha256 = hashes[index]!;
        const previous = progress.files[sha256];
        if (previous?.status === "ready") continue;
        const intent = await client.post<EvidenceIntent>(`/payment-intakes/${intakePublicId}/evidence/upload-intents`, {
            mimeType: file.type, size: file.size, sha256, evidenceType: "slip",
        }, tracingConfig(snapshot)).then((response) => response.data);
        if (intent.duplicate) throw workflowError("DUPLICATE_EVIDENCE", "This supporting file is already attached to another receipt and requires review", undefined, intakePublicId);
        if (intent.status === "ready") {
            updateProgress(progress, { files: { ...progress.files, [sha256]: { evidencePublicId: intent.publicId, status: "ready" } } }, onProgress);
            continue;
        }
        updateProgress(progress, { files: { ...progress.files, [sha256]: { evidencePublicId: intent.publicId, status: "pending" } } }, onProgress);
        if (!intent.uploadUrl) throw workflowError("EVIDENCE_UPLOAD_NOT_READY", "Evidence upload is not ready; retry this receipt", intakePublicId);
        const uploaded = await dependencies.put(intent.uploadUrl, { method: "PUT", headers: intent.requiredHeaders, body: file });
        if (!uploaded.ok) throw workflowError("EVIDENCE_UPLOAD_FAILED", "Evidence upload failed; retry this receipt", intakePublicId);
        await client.post(`/payment-intakes/${intakePublicId}/evidence/${intent.publicId}/finalize`, undefined, tracingConfig(snapshot));
        updateProgress(progress, { files: { ...progress.files, [sha256]: { evidencePublicId: intent.publicId, status: "ready" } } }, onProgress);
    }

    if (Object.values(progress.files).filter((file) => file.status === "ready").length !== snapshot.files.length) {
        throw workflowError("EVIDENCE_REQUIREMENT_INCOMPLETE", "Not all selected supporting files are ready", intakePublicId);
    }
    await client.post(`/payment-intakes/${intakePublicId}/match-preview`, { allocations: snapshot.allocations }, tracingConfig(snapshot));
    return { intakePublicId };
}
