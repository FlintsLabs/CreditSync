import { Elysia, t } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import {
    answerAssistantMessage,
    type AssistantChatRepository,
} from "../services/assistant-chat-service";

const repository: AssistantChatRepository = {
    async getFinancialOverview(tenantId) {
        const [[loanAggregate], [transactionAggregate]] = await Promise.all([
            db.select({
                totalLent: sql<string>`coalesce(sum(${loans.principalAmount}), 0)::text`,
                activePrincipal: sql<string>`coalesce(sum(case when ${loans.status} = 'active' then ${loans.principalAmount} else 0 end), 0)::text`,
            }).from(loans).where(eq(loans.tenantId, tenantId)),
            db.select({
                totalCollected: sql<string>`coalesce(sum(${transactions.amount}), 0)::text`,
            }).from(transactions).where(eq(transactions.tenantId, tenantId)),
        ]);

        return {
            totalLent: loanAggregate?.totalLent ?? "0.00",
            activePrincipal: loanAggregate?.activePrincipal ?? "0.00",
            totalCollected: transactionAggregate?.totalCollected ?? "0.00",
        };
    },
    async countActiveLoans(tenantId) {
        const [result] = await db.select({
            count: sql<number>`count(*)::int`,
        }).from(loans).where(and(eq(loans.tenantId, tenantId), eq(loans.status, "active")));
        return result?.count ?? 0;
    },
    async getBorrowerSummary(tenantId, borrowerId) {
        const borrower = await db.query.borrowers.findFirst({
            where: and(eq(borrowers.tenantId, tenantId), eq(borrowers.id, borrowerId)),
        });
        if (!borrower) return null;

        const [result] = await db.select({
            count: sql<number>`count(*)::int`,
        }).from(loans).where(and(
            eq(loans.tenantId, tenantId),
            eq(loans.borrowerId, borrowerId),
            eq(loans.status, "active"),
        ));

        return { name: borrower.name, activeLoansCount: result?.count ?? 0 };
    },
};

export const assistantChatRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .post("/chat", async ({ body, user, set }) => {
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        try {
            return await answerAssistantMessage(repository, user.tenantId, body.message);
        } catch (error) {
            console.error("Assistant chat request failed", error);
            set.status = 500;
            return { error: "Unable to process assistant request" };
        }
    }, {
        body: t.Object({
            message: t.String({ minLength: 1, maxLength: 500 }),
        }),
    });
