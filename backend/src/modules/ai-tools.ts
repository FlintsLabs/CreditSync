import { Elysia } from "elysia";
import { db } from "../db";
import { loans, borrowers, bankLoans, transactions } from "../db/schema";
import { eq } from "drizzle-orm";

// AI Integration endpoints (MCP/Flow ready)
export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .get("/context", async () => {
        // Return structured context about the application state, schema, etc.
        // Used by AI to understand the current state
        return {
            schema: {
                tables: ["users", "tenant_configs", "bank_profiles", "bank_loans", "borrowers", "loans", "transactions", "files", "bot_uploads", "bank_transactions"],
                version: "1.0",
                description: "Multi-tenant Micro Loan finance application schema"
            },
            status: "active",
            timestamp: new Date().toISOString()
        };
    })
    .get("/tools", async () => {
        // Expose available tools/functions for AI agents (Model Context Protocol format)
        return {
            tools: [
                {
                    name: "calculate_loan",
                    description: "Calculates loan installment schedules based on principal, interest rate, term, and repayment type.",
                    endpoint: "/loans/calculate",
                    method: "POST"
                },
                {
                    name: "extract_id_card",
                    description: "Extracts text and ID card number from an uploaded image.",
                    endpoint: "/borrowers/extract-id-card",
                    method: "POST"
                },
                 {
                    name: "get_loan_closing_summary",
                    description: "Calculates the closing summary for a specific loan.",
                    endpoint: "/loans/:id/closing-summary",
                    method: "GET"
                }
            ]
        };
    });
