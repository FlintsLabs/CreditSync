import { Elysia, t } from "elysia";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .get("/context", () => {
        return {
            description: "CreditSync is a Micro Loan finance management system.",
            schema: {
                bankProfiles: "Source of funds (banks).",
                bankLoans: "Money borrowed from banks.",
                borrowers: "End customers.",
                loans: "Money lent to borrowers.",
                transactions: "Repayments from borrowers."
            },
            capabilities: [
                "Track loans and interest",
                "Manage borrowers and calculate ROI",
                "Traceability from bank to customer"
            ]
        };
    })
    .get("/tools", () => {
        return {
            tools: [
                {
                    name: "simulate_loan",
                    description: "Simulate a loan based on principal, rate, and term.",
                    endpoint: "GET /ai-tools/simulate-loan?principal=10000&rate=15&term=12"
                },
                {
                    name: "get_borrower_summary",
                    description: "Get summary of a specific borrower's loans and status.",
                    endpoint: "GET /ai-tools/borrower-summary?borrowerId=1"
                }
            ]
        };
    })
    .get("/simulate-loan", ({ query }) => {
        const principal = Number(query.principal);
        const rate = Number(query.rate);
        const term = Number(query.term); // Term in months

        if (!principal || !rate || !term) {
            return { error: "Missing required query parameters: principal, rate, term" };
        }

        // Simple mock calculation for simulation
        const interest = principal * (rate / 100) * (term / 12);
        const total = principal + interest;
        const monthly = total / term;

        return {
            principal,
            rate,
            term,
            interest,
            total,
            monthly
        };
    }, {
        query: t.Object({
            principal: t.String(),
            rate: t.String(),
            term: t.String()
        })
    })
    .get("/borrower-summary", async ({ query }) => {
        // Mock summary for AI
        const borrowerId = query.borrowerId;

        return {
            borrowerId,
            status: "active",
            totalLoans: 1,
            outstandingBalance: 15000,
            reliabilityScore: 85
        };
    }, {
        query: t.Object({
            borrowerId: t.String()
        })
    });
