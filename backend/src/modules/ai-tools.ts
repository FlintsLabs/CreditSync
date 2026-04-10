import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { calculateLoanSchedule, RepaymentType } from "../lib/calculator";

// Define the available tools for the AI MCP
const AVAILABLE_TOOLS = [
    {
        name: "get_borrowers",
        description: "Fetch a list of borrowers for the current tenant",
        parameters: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_borrower_details",
        description: "Fetch details of a specific borrower by their ID",
        parameters: {
            type: "object",
            properties: {
                borrowerId: {
                    type: "number",
                    description: "The ID of the borrower to fetch"
                }
            },
            required: ["borrowerId"]
        }
    },
    {
        name: "calculate_loan_schedule",
        description: "Calculate a repayment schedule for a loan",
        parameters: {
            type: "object",
            properties: {
                principal: { type: "number", description: "Loan principal amount" },
                interestRate: { type: "number", description: "Annual interest rate (%)" },
                termMonths: { type: "number", description: "Term of the loan in months" },
                repaymentType: { type: "string", description: "Repayment frequency (daily, weekly, monthly)" },
                startDate: { type: "string", description: "Start date of the loan (ISO string)" }
            },
            required: ["principal", "interestRate", "termMonths", "repaymentType", "startDate"]
        }
    }
];

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/tools", () => {
        // Return the list of available tools and their schemas
        return {
            tools: AVAILABLE_TOOLS
        };
    })
    .post("/execute", async ({ body, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const { tool, params } = body;

        try {
            switch (tool) {
                case "get_borrowers": {
                    const borrowerList = await db.select({
                        id: borrowers.id,
                        name: borrowers.name,
                        creditScore: borrowers.creditScore,
                    })
                        .from(borrowers)
                        .where(eq(borrowers.tenantId, user.tenantId));
                    return { result: borrowerList };
                }

                case "get_borrower_details": {
                    const borrowerId = (params as any).borrowerId;
                    if (!borrowerId) throw new Error("Missing borrowerId");

                    const borrower = await db.query.borrowers.findFirst({
                        where: and(eq(borrowers.id, borrowerId), eq(borrowers.tenantId, user.tenantId))
                    });

                    if (!borrower) return { error: "Borrower not found" };
                    return { result: borrower };
                }

                case "calculate_loan_schedule": {
                    const p = params as any;
                    const schedule = calculateLoanSchedule({
                        principal: p.principal,
                        interestRate: p.interestRate,
                        termMonths: p.termMonths,
                        repaymentType: p.repaymentType as RepaymentType,
                        startDate: new Date(p.startDate)
                    });
                    return { result: schedule };
                }

                default:
                    set.status = 400;
                    return { error: `Tool '${tool}' is not recognized` };
            }
        } catch (error: any) {
            set.status = 500;
            return { error: error.message };
        }
    }, {
        body: t.Object({
            tool: t.String(),
            params: t.Record(t.String(), t.Any())
        })
    });
