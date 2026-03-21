import { Elysia } from "elysia";

export const aiToolsRoute = new Elysia({ prefix: '/ai-tools' })
    .get('/context', () => {
        return {
            status: "ready",
            context: "CreditSync API Context - Micro Loan Finance System",
            version: "1.0.0",
            capabilities: ["loans", "borrowers", "transactions", "analytics"]
        };
    })
    .get('/tools', () => {
        return {
            tools: [
                {
                    name: "calculate_interest",
                    description: "Calculates interest for a loan",
                    endpoint: "/loans/calculate",
                    method: "POST"
                },
                {
                    name: "extract_id_card",
                    description: "Extract text from ID card image via OCR",
                    endpoint: "/files/ocr",
                    method: "POST"
                },
                {
                    name: "get_fund_performance",
                    description: "Retrieve fund performance metrics (Inflow, Outflow, Liability)",
                    endpoint: "/analytics/fund-performance",
                    method: "GET"
                }
            ]
        };
    });
