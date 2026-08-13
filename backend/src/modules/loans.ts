import { Elysia } from "elysia";
import { authPlugin } from "../middleware/auth";
import { loanContractRoutes } from "./loan-contract-routes";
import { loanDisbursementRoutes } from "./loan-disbursement-routes";
import { loanFundingRoutes } from "./loan-funding-routes";
import { loanInterestRateRoutes } from "./loan-interest-rate-routes";
import { loanPaymentHistoryRoutes } from "./loan-payment-history-routes";

/** Public /loans API composition point. Keep this import stable for API consumers. */
export const loansRoute = new Elysia({ prefix: "/loans" })
    .onError(({ code, body, set }) => {
        const floating = body && typeof body === "object"
            ? (body as { floatingDailyInterest?: { accrualCycle?: unknown } }).floatingDailyInterest
            : undefined;
        if (code === "VALIDATION" && floating?.accrualCycle !== undefined
            && !["daily", "weekly"].includes(String(floating.accrualCycle))) {
            set.status = 400;
            return { error: "Floating interest policy is invalid", code: "INVALID_LOAN_TERMS" };
        }
    })
    .use(authPlugin)
    .use(loanContractRoutes)
    .use(loanDisbursementRoutes)
    .use(loanFundingRoutes)
    .use(loanInterestRateRoutes)
    .use(loanPaymentHistoryRoutes);
