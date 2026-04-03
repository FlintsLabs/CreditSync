import { Elysia, t } from "elysia";

// This module provides endpoints for AI Models/MCP to interact with the system
export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .get("/context", () => {
        return {
            system: "CreditSync",
            description: "A Micro Loan finance application",
            features: [
                "Borrower Management",
                "Loan Management & Calculations",
                "Transaction & Payment Tracking",
                "Bank Loan Profiling"
            ]
        };
    }, {
        detail: {
            tags: ['AI Tools'],
            summary: "Get System Context for AI"
        }
    })
    .get("/tools", () => {
        return {
            tools: [
                {
                    name: "calculate_loan_interest",
                    description: "Calculate the interest and installment plan for a loan.",
                    schema: {
                        type: "object",
                        properties: {
                            principalAmount: { type: "number", description: "The initial loan amount." },
                            interestRate: { type: "number", description: "The interest rate percentage." },
                            repaymentType: { type: "string", enum: ["daily", "weekly", "monthly", "floating"] },
                            termInDays: { type: "number" }
                        },
                        required: ["principalAmount", "interestRate", "repaymentType"]
                    }
                },
                {
                    name: "get_borrower_summary",
                    description: "Get a summarized view of a borrower's active loans and total debt.",
                    schema: {
                        type: "object",
                        properties: {
                            borrowerId: { type: "number" }
                        },
                        required: ["borrowerId"]
                    }
                }
            ]
        };
    }, {
        detail: {
            tags: ['AI Tools'],
            summary: "Get Available Tools/Schemas for AI integration"
        }
    });
