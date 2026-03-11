import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import { db } from "../db";
import { borrowers, loans } from "../db/schema";
import { eq } from "drizzle-orm";

// -----------------------------------------------------------------------------
// AI Model Context Protocol (MCP) / Function Calling Interface
// -----------------------------------------------------------------------------
// This module provides a structured, introspectable API for AI Agents
// to interact with the Micro Loan system on behalf of the user.

const AI_TOOLS_SCHEMA = {
    "name": "creditsync_api",
    "description": "Tools for managing micro loans and borrower data.",
    "tools": [
        {
            "name": "get_borrower_summary",
            "description": "Retrieves the summary and active loans for a specific borrower.",
            "parameters": {
                "type": "object",
                "properties": {
                    "borrowerId": {
                        "type": "integer",
                        "description": "The ID of the borrower."
                    }
                },
                "required": ["borrowerId"]
            }
        },
        {
            "name": "calculate_loan_payoff",
            "description": "Calculates the pro-rated closing amount for a loan as of today.",
            "parameters": {
                "type": "object",
                "properties": {
                    "loanId": {
                        "type": "integer",
                        "description": "The ID of the loan to calculate."
                    }
                },
                "required": ["loanId"]
            }
        }
    ]
};

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    // 1. Schema Endpoint: Allows the AI to discover available tools
    .get("/schema", () => {
        return AI_TOOLS_SCHEMA;
    })
    // 2. Execute Endpoint: Allows the AI to call a tool
    .post("/execute", async ({ body, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized AI access" };
        }

        const { toolName, parameters } = body;

        try {
            switch (toolName) {
                case "get_borrower_summary": {
                    const bId = (parameters as any).borrowerId;

                    const borrower = await db.query.borrowers.findFirst({
                        where: eq(borrowers.id, bId)
                    });

                    if (!borrower || borrower.tenantId !== user.tenantId) {
                        return { error: "Borrower not found or access denied." };
                    }

                    const activeLoans = await db.select().from(loans).where(eq(loans.borrowerId, bId));

                    return {
                        success: true,
                        data: {
                            borrower: {
                                name: borrower.name,
                                creditScore: borrower.creditScore,
                                status: activeLoans.length > 0 ? "active" : "inactive"
                            },
                            activeLoans: activeLoans.map(l => ({ id: l.id, principal: l.principalAmount, status: l.status }))
                        }
                    };
                }

                // Add other tools here (calculate_loan_payoff would call calculator logic)

                default:
                    set.status = 400;
                    return { error: `Tool ${toolName} is not implemented or recognized.` };
            }
        } catch (error: any) {
            set.status = 500;
            return { error: "Internal error executing tool", details: error.message };
        }
    }, {
        body: t.Object({
            toolName: t.String(),
            parameters: t.Any()
        })
    });
