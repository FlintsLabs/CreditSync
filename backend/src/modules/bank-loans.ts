import { Elysia, t } from "elysia";
import { db } from "../db";
import { bankLoans } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { authPlugin } from "../middleware/auth";

export const bankLoansRoute = new Elysia({ prefix: "/bank-loans" })
    .use(authPlugin)
    .get("/", async ({ user, query }) => {
        if (!user) return [];
        const whereClause = [eq(bankLoans.tenantId, user.tenantId)];
        if (query.bankProfileId) {
            whereClause.push(eq(bankLoans.bankProfileId, query.bankProfileId));
        }
        return await db.select().from(bankLoans)
            .where(and(...whereClause))
            .orderBy(desc(bankLoans.createdAt));
    }, {
        query: t.Object({
            bankProfileId: t.Optional(t.String())
        })
    })
    .post("/", async ({ body, user }) => {
        if (!user) throw new Error("Unauthorized");
        const result = await db.insert(bankLoans).values({
            tenantId: user.tenantId,
            bankProfileId: body.bankProfileId,
            amount: body.amount.toString(),
            interestRate: body.interestRate.toString(),
            startDate: body.startDate,
            termMonths: body.termMonths,
            status: "active"
        }).returning();
        return result[0];
    }, {
        body: t.Object({
            bankProfileId: t.Optional(t.String()),
            amount: t.Number(),
            interestRate: t.Number(), // % per year
            startDate: t.Optional(t.String()),
            termMonths: t.Optional(t.Number())
        })
    });
