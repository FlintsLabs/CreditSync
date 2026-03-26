import { Elysia } from "elysia";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .get("/context", async ({ user }) => {
        // Return context useful for AI flows (MCP)
        return {
            status: "success",
            data: {
                tenantId: user?.tenantId,
                role: user?.role,
                schema: {
                    tables: [
                        "users", "tenant_configs", "bank_profiles", "bank_loans",
                        "borrowers", "loans", "transactions", "files", "bot_uploads", "bank_transactions"
                    ]
                },
                capabilities: [
                    "fund_management",
                    "borrower_management",
                    "loan_calculator",
                    "transaction_recording",
                    "ocr_processing",
                    "webhook_automation"
                ]
            }
        };
    })
    .get("/tools", async () => {
        // Return available tools/functions for AI to call
        return {
            status: "success",
            data: {
                tools: [
                    {
                        name: "get_borrowers",
                        description: "List all borrowers for the current tenant",
                        endpoint: "/borrowers",
                        method: "GET"
                    },
                    {
                        name: "get_loans",
                        description: "List all active loans",
                        endpoint: "/loans",
                        method: "GET"
                    },
                    {
                        name: "record_transaction",
                        description: "Record a new repayment transaction",
                        endpoint: "/transactions",
                        method: "POST"
                    }
                ]
            }
        };
    });
