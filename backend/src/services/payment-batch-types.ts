export type BatchObligation = {
    borrowerPublicId: string;
    loanPublicId: string;
    schedulePublicId: string;
    dueDate: string;
    remainingDue: string;
    principalDue: string;
    interestDue: string;
    feeDue: string;
    penaltyDue: string;
};

export type BatchSlip = {
    itemPublicId: string;
    amount: string;
    receivedAt: string;
    requestedDueDate?: string;
    allowAdvance?: boolean;
    allowBackdated?: boolean;
};

export type ExplicitBatchAllocation = {
    itemPublicId: string;
    borrowerPublicId?: string;
    loanPublicId: string;
    schedulePublicId: string;
    amount: string;
    targetDueDate: string;
    intent: "on_time" | "advance" | "backdated";
    matchSource?: "human_explicit" | "unique_exact" | "selected_candidate";
};

export type BatchCandidate = {
    allocations: ExplicitBatchAllocation[];
};

export type BatchWarning = {
    code: string;
    itemPublicId?: string;
    message?: string;
};

export type BatchSolveInput = {
    obligations: BatchObligation[];
    slips: BatchSlip[];
};

export type BatchSolveResult = {
    status: "ready" | "needs_review";
    allocations: ExplicitBatchAllocation[];
    candidates: BatchCandidate[];
    warnings: BatchWarning[];
};
