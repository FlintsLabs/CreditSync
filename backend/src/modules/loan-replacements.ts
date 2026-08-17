import { Elysia, t } from "elysia";
import { invalidateTenantCache } from "../lib/cache";
import { authPlugin } from "../middleware/auth";
import { DomainError } from "../services/domain-error";
import {
    executeLoanReplacement,
    previewLoanReplacement,
    reverseLoanReplacement,
} from "../services/loan-replacement-service";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";
import {
    loanReplacementExecuteBody,
    loanReplacementPreviewBody,
    loanReplacementReverseBody,
} from "./loan-route-schemas";

const strict = { additionalProperties: false } as const;

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[]) {
    const unexpectedFields = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unexpectedFields.length) {
        throw new DomainError("VALIDATION_ERROR", "Request body contains unknown fields", 422, {
            unexpectedFields: unexpectedFields.map((key) => `body.${key}`),
        });
    }
}

/** Authenticated public lifecycle boundary for atomic loan replacements. */
export const loanReplacementRoutes = new Elysia({ normalize: false })
    .use(authPlugin)
    .post("/replacements/preview", async ({ body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as Record<string, unknown>, ["oldLoanPublicId", "replacementDraftPublicId", "reason"]);
            return await previewLoanReplacement(loanCommandContext(user, request), body);
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { body: loanReplacementPreviewBody })
    .post("/replacements/:publicId/execute", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as Record<string, unknown>, ["confirmed", "previewHash", "expectedOldBalanceVersion", "expectedReplacementDraftVersion", "reason"]);
            const result = await executeLoanReplacement(loanCommandContext(user, request), {
                replacementPublicId: params.publicId,
                ...body,
                confirmed: body.confirmed as true,
            });
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: t.Object({ publicId: t.String() }, strict),
        body: loanReplacementExecuteBody,
    })
    .post("/replacements/:publicId/reverse", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertKnownKeys(body as Record<string, unknown>, ["reason"]);
            const result = await reverseLoanReplacement(loanCommandContext(user, request), {
                replacementPublicId: params.publicId,
                ...body,
            });
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: t.Object({ publicId: t.String() }, strict),
        body: loanReplacementReverseBody,
    });
