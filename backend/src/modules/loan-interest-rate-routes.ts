import { Elysia, t } from "elysia";
import { invalidateTenantCache } from "../lib/cache";
import { authPlugin } from "../middleware/auth";
import { DomainError } from "../services/domain-error";
import {
    executeLoanInterestRateChange,
    listLoanInterestRates,
    previewLoanInterestRateChange,
} from "../services/loan-interest-rate-service";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";

const loanIdParams = t.Object({ id: t.String({ format: "uuid" }) });
const rateType = t.Union([t.Literal("percent"), t.Literal("per_thousand")]);

function assertClosedBody(body: object, allowedKeys: readonly string[]) {
    const unexpected = Object.keys(body).filter((key) => !allowedKeys.includes(key));
    if (unexpected.length) {
        throw new DomainError("VALIDATION_ERROR", `Unexpected body field: ${unexpected[0]}`, 422, { unexpectedFields: unexpected });
    }
}

export const loanInterestRateRoutes = new Elysia({ normalize: false }).use(authPlugin)
    .get("/:id/interest-rates", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            return await listLoanInterestRates(loanCommandContext(user, request), params.id);
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: loanIdParams })
    .post("/:id/interest-rates/preview", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertClosedBody(body, ["effectiveDate", "expiryDate", "rateType", "rate"]);
            return await previewLoanInterestRateChange(loanCommandContext(user, request), params.id, body);
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: loanIdParams,
        body: t.Object({
            effectiveDate: t.String(),
            expiryDate: t.Nullable(t.String()),
            rateType,
            rate: t.String(),
        }, { additionalProperties: true }),
    })
    .post("/:id/interest-rates/execute", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertClosedBody(body, ["previewPublicId", "previewHash", "reason"]);
            const result = await executeLoanInterestRateChange(loanCommandContext(user, request), params.id, body);
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: loanIdParams,
        body: t.Object({
            previewPublicId: t.String({ format: "uuid" }),
            previewHash: t.String({ pattern: "^v1:[0-9a-fA-F]{64}$" }),
            reason: t.String({ minLength: 1, maxLength: 2000 }),
        }, { additionalProperties: true }),
    });
