export interface AssistantFinancialOverview {
    totalLent: string;
    activePrincipal: string;
    totalCollected: string;
}

export interface AssistantBorrowerSummary {
    name: string;
    activeLoansCount: number;
}

export interface AssistantChatRepository {
    getFinancialOverview(tenantId: string): Promise<AssistantFinancialOverview>;
    countActiveLoans(tenantId: string): Promise<number>;
    getBorrowerSummary(tenantId: string, borrowerId: number): Promise<AssistantBorrowerSummary | null>;
}

function formatMoney(value: string) {
    return Number(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

export async function answerAssistantMessage(
    repository: AssistantChatRepository,
    tenantId: string,
    message: string,
) {
    const normalizedMessage = message.trim().toLowerCase();

    if (normalizedMessage.includes("financial") || normalizedMessage.includes("overview")) {
        const overview = await repository.getFinancialOverview(tenantId);
        return {
            response: `Financial overview: Total lent is ฿${formatMoney(overview.totalLent)}, active principal is ฿${formatMoney(overview.activePrincipal)}, and total collected is ฿${formatMoney(overview.totalCollected)}.`,
        };
    }

    if (normalizedMessage.includes("active loan") || normalizedMessage.includes("loans")) {
        const count = await repository.countActiveLoans(tenantId);
        return { response: `You have ${count} active loans.` };
    }

    if (normalizedMessage.includes("borrower") || normalizedMessage.includes("summary")) {
        const borrowerId = normalizedMessage.match(/\b\d+\b/)?.[0];
        if (!borrowerId) {
            return { response: "Please specify a borrower ID. For example: 'summary for borrower 1'." };
        }

        const summary = await repository.getBorrowerSummary(tenantId, Number(borrowerId));
        if (!summary) {
            return { response: `I couldn't find borrower ID ${borrowerId}.` };
        }
        return {
            response: `Borrower ${summary.name} (ID: ${borrowerId}) has ${summary.activeLoansCount} active loans.`,
        };
    }

    return {
        response: "I'm not sure how to help with that. Try asking for a 'financial overview', 'active loans', or a borrower summary.",
    };
}
