import { describe, expect, test } from "bun:test";
import {
    answerAssistantMessage,
    type AssistantChatRepository,
} from "./assistant-chat-service";

function repository(overrides: Partial<AssistantChatRepository> = {}): AssistantChatRepository {
    return {
        getFinancialOverview: async () => ({
            totalLent: "12500.00",
            activePrincipal: "8000.00",
            totalCollected: "4500.00",
        }),
        countActiveLoans: async () => 3,
        getBorrowerSummary: async () => ({ name: "สมชาย", activeLoansCount: 2 }),
        ...overrides,
    };
}

describe("assistant chat service", () => {
    test("scopes financial overview queries to the authenticated tenant", async () => {
        const tenantIds: string[] = [];
        const result = await answerAssistantMessage(repository({
            getFinancialOverview: async (tenantId) => {
                tenantIds.push(tenantId);
                return { totalLent: "12500.00", activePrincipal: "8000.00", totalCollected: "4500.00" };
            },
        }), "tenant-a", "financial overview");

        expect(tenantIds).toEqual(["tenant-a"]);
        expect(result.response).toContain("12,500.00");
        expect(result.response).toContain("8,000.00");
        expect(result.response).toContain("4,500.00");
    });

    test("does not execute a repository query for unsupported messages", async () => {
        let queryCount = 0;
        const repo = repository({
            getFinancialOverview: async () => {
                queryCount += 1;
                return { totalLent: "0.00", activePrincipal: "0.00", totalCollected: "0.00" };
            },
            countActiveLoans: async () => {
                queryCount += 1;
                return 0;
            },
            getBorrowerSummary: async () => {
                queryCount += 1;
                return null;
            },
        });

        const result = await answerAssistantMessage(repo, "tenant-a", "hello there");

        expect(queryCount).toBe(0);
        expect(result.response).toContain("financial overview");
    });

    test("requires a borrower id before running a borrower query", async () => {
        let queryCount = 0;
        const result = await answerAssistantMessage(repository({
            getBorrowerSummary: async () => {
                queryCount += 1;
                return null;
            },
        }), "tenant-a", "borrower summary");

        expect(queryCount).toBe(0);
        expect(result.response).toContain("borrower ID");
    });
});
