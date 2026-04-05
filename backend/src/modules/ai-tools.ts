import { Elysia, t } from "elysia";

// This module serves as the centralized registry for AI tools (MCP/Flow compatible).
// It exposes endpoints that an AI agent or Model Context Protocol client can query
// to discover available functions and their parameter schemas.

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .get("/tools", () => {
        return {
            tools: [
                {
                    name: "calculate_loan_schedule",
                    description: "Calculates the repayment schedule for a loan based on principal, interest rate, term, and frequency.",
                    parameters: {
                        type: "object",
                        properties: {
                            principal: {
                                type: "number",
                                description: "The total principal amount of the loan."
                            },
                            interestRate: {
                                type: "number",
                                description: "The annual interest rate (percentage)."
                            },
                            termMonths: {
                                type: "number",
                                description: "The duration of the loan in months."
                            },
                            repaymentType: {
                                type: "string",
                                enum: ["daily", "weekly", "monthly"],
                                description: "The frequency of repayment."
                            },
                            startDate: {
                                type: "string",
                                description: "The start date of the loan in YYYY-MM-DD format."
                            }
                        },
                        required: ["principal", "interestRate", "termMonths", "repaymentType", "startDate"]
                    }
                },
                {
                    name: "get_borrower_summary",
                    description: "Retrieves a summary of a specific borrower's details and active loans.",
                    parameters: {
                        type: "object",
                        properties: {
                            borrowerId: {
                                type: "number",
                                description: "The unique identifier of the borrower."
                            }
                        },
                        required: ["borrowerId"]
                    }
                }
            ]
        };
    })
    .get("/context", () => {
        // This endpoint could be used by an AI to fetch global context
        // such as current active tenant, system status, etc.
        return {
            system: "CreditSync Finance System",
            capabilities: ["loan_calculation", "borrower_management", "transaction_tracking"]
        };
    });
