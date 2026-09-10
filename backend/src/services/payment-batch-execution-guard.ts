import { DomainError } from "./domain-error";

type Preview = { status: string; previewHash: string; confirmationHash: string; expiresAt: Date };
type Input = { previewHash: string; confirmationHash: string; now?: Date };

export function assertPaymentBatchPreviewFresh(preview: Preview, input: Input) {
    if (preview.status !== "ready") throw new DomainError("BATCH_CONFIRMATION_STALE", "The batch preview must be ready before execution", 409);
    if (preview.expiresAt.getTime() <= (input.now ?? new Date()).getTime()) throw new DomainError("BATCH_CONFIRMATION_EXPIRED", "The batch preview has expired", 409);
    if (preview.previewHash !== input.previewHash || preview.confirmationHash !== input.confirmationHash) throw new DomainError("BATCH_CONFIRMATION_STALE", "The batch preview no longer matches the confirmed semantics", 409);
}
