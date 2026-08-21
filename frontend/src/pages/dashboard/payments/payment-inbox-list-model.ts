export interface PaymentIntakeSummary {
    publicId: string;
    status: string;
    amount: string;
    receivedAt: string;
    payerName?: string | null;
    repostOfIntakePublicId?: string | null;
    repostedByIntakePublicId?: string | null;
}

export interface PaymentIntakePage {
    items: PaymentIntakeSummary[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
}

export interface PaymentInboxQuery {
    search: string;
    status: string;
    from: string;
    to: string;
    page: number;
    pageSize: number;
}

export const initialPaymentInboxQuery: PaymentInboxQuery = {
    search: "",
    status: "",
    from: "",
    to: "",
    page: 1,
    pageSize: 25,
};

export function toPaymentInboxParams(query: PaymentInboxQuery) {
    return {
        ...(query.search.trim() ? { search: query.search.trim() } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        page: String(query.page),
        pageSize: String(query.pageSize),
    };
}
