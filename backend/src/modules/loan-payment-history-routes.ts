import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import { listLoanPaymentIntakes } from "../services/payment-service";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";

export const loanPaymentHistoryRoutes = new Elysia().use(authPlugin)
    .get("/:id/payment-intakes", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            return await listLoanPaymentIntakes(loanCommandContext(user, request), params.id);
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String({ format: "uuid" }) }) });
