import { Elysia, t } from "elysia";
import { invalidateTenantCache } from "../lib/cache";
import { authPlugin } from "../middleware/auth";
import { DomainError } from "../services/domain-error";
import { getLoanWaiver, listLoanWaivers, executeLoanWaiver, previewLoanWaiver, reverseLoanWaiver } from "../services/loan-waiver-service";
import { executeEarlyLoanSettlement, previewEarlyLoanSettlement } from "../services/payment-service";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";

const strict = { additionalProperties: false } as const;
const preserveUnknown = { additionalProperties: true } as const;
function validationFailure(set: { status?: number | string }) {
    return loanDomainFailure(new DomainError("VALIDATION_ERROR", "Request body contains invalid or unknown fields", 422), set);
}
function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[]) {
    const unexpectedFields = Object.keys(value).filter(key => !allowed.includes(key)).map(key => `body.${key}`);
    if (unexpectedFields.length) throw new DomainError("VALIDATION_ERROR", "Request body contains unknown fields", 422, { unexpectedFields });
}

export const loanWaiverRoutes = new Elysia({ normalize: false })
    .use(authPlugin)
    .onError(({ code, set }) => code === "VALIDATION" ? validationFailure(set) : undefined)
    .get("/:id/waivers", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try { return await listLoanWaivers(loanCommandContext(user, request), params.id); }
        catch (error) { return loanDomainFailure(error, set); }
    }, { params: t.Object({ id: t.String() }, strict) })
    .get("/waivers/:id", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try { return await getLoanWaiver(loanCommandContext(user, request), params.id); }
        catch (error) { return loanDomainFailure(error, set); }
    }, { params: t.Object({ id: t.String() }, strict) })
    .post("/:id/waivers/preview", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as unknown as Record<string, unknown>, ["component", "amount", "reason"]);
            return await previewLoanWaiver(loanCommandContext(user, request), params.id, body);
        }
        catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ id: t.String() }, strict),
        body: t.Object({ component: t.Union([t.Literal("interest"), t.Literal("fee"), t.Literal("penalty")]), amount: t.String(), reason: t.String() }, preserveUnknown),
    })
    .post("/waivers/:id/execute", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as unknown as Record<string, unknown>, ["confirmed", "previewHash", "expectedBalanceVersion", "reason"]);
            const result = await executeLoanWaiver(loanCommandContext(user, request), params.id, body);
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ id: t.String() }, strict),
        body: t.Object({ confirmed: t.Boolean(), previewHash: t.String(), expectedBalanceVersion: t.String(), reason: t.String() }, preserveUnknown),
    })
    .post("/waivers/:id/reverse", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as unknown as Record<string, unknown>, ["reason"]);
            const result = await reverseLoanWaiver(loanCommandContext(user, request), params.id, body);
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) { return loanDomainFailure(error, set); }
    }, { params: t.Object({ id: t.String() }, strict), body: t.Object({ reason: t.String() }, preserveUnknown) })
    .post("/:id/early-settlement/preview", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as unknown as Record<string, unknown>, ["settlementDate"]);
            return await previewEarlyLoanSettlement(loanCommandContext(user, request), params.id, body);
        }
        catch (error) { return loanDomainFailure(error, set); }
    }, { params: t.Object({ id: t.String() }, strict), body: t.Object({ settlementDate: t.String() }, preserveUnknown) })
    .post("/early-settlement/:previewId/execute", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as unknown as Record<string, unknown>, ["confirmed", "previewHash", "expectedBalanceVersion"]);
            const result = await executeEarlyLoanSettlement(loanCommandContext(user, request), params.previewId, body);
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ previewId: t.String() }, strict),
        body: t.Object({ confirmed: t.Boolean(), previewHash: t.String(), expectedBalanceVersion: t.String() }, preserveUnknown),
    });
