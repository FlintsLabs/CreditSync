import { unsignedMoneyInputPattern } from "./financial-decimal";

export interface HttpResponse<T> {
    data: T;
}

export interface HttpClient {
    get<T = unknown>(url: string, config?: unknown): Promise<HttpResponse<T>>;
    post<T = unknown>(url: string, body?: unknown, config?: { headers?: Record<string, string> }): Promise<HttpResponse<T>>;
}

export interface PaymentAllocationInput {
    borrowerPublicId: string;
    loanPublicId: string;
    schedulePublicId?: string;
    amount: string;
}

export interface PaymentWorkflowInput {
    amount: string;
    receivedAt: string;
    payerName?: string;
    bankReference?: string;
    notes?: string;
    originLoanPublicId?: string;
}

export interface PaymentWorkflowResult {
    publicId: string;
    status: string;
    duplicate?: boolean;
    duplicateReason?: string | null;
    warnings?: Array<Record<string, unknown>>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeMoney(value: string): string {
    const normalized = value.trim();
    if (!unsignedMoneyInputPattern.test(normalized)) {
        throw new Error("Money must be non-negative with at most two decimal places");
    }
    const [whole, fraction = ""] = normalized.split(".");
    const canonicalWhole = whole.replace(/^0+(?=\d)/, "");
    return `${canonicalWhole}.${fraction.padEnd(2, "0")}`;
}

function requireUuid(value: string, field: string) {
    if (!uuidPattern.test(value)) throw new Error(`${field} must be a UUID`);
}

export async function createPaymentWorkflow(client: HttpClient, input: PaymentWorkflowInput) {
    return client.post<PaymentWorkflowResult>("/payment-intakes", {
        amount: normalizeMoney(input.amount),
        receivedAt: input.receivedAt,
        payerName: input.payerName?.trim() || null,
        bankReference: input.bankReference?.trim() || null,
        notes: input.notes?.trim() || null,
        originLoanPublicId: input.originLoanPublicId ?? null,
    }).then((response) => response.data);
}

export async function executeRenewal(
    client: HttpClient,
    renewalPublicId: string,
    previewHash: string,
    reason: string,
    idempotencyKey: string,
) {
    requireUuid(renewalPublicId, "renewalPublicId");
    if (!reason.trim()) throw new Error("Renewal reason is required");
    if (!idempotencyKey.trim()) throw new Error("Idempotency key is required");
    return client.post(`/loan-renewals/${renewalPublicId}/execute`, {
        previewHash,
        confirmed: true,
        reason: reason.trim(),
    }, { headers: { "Idempotency-Key": idempotencyKey } }).then((response) => response.data);
}
