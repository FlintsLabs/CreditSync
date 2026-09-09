import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import {
    executeLoanSettlement,
    previewLoanSettlement,
    reverseLoanSettlement,
} from "../services/loan-settlement-service";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";

const settlementIdParams = t.Object({ id: t.String({ format: "uuid" }) }, { additionalProperties: t.Never() });

export const loanSettlementRoutes = new Elysia({ prefix: "/loan-settlements", normalize: false })
    .use(authPlugin)
    .post("/preview", async ({ body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            return await previewLoanSettlement(
                loanCommandContext(user, request),
                body.loanPublicId,
                body.asOfDate,
            );
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        body: t.Object({
            loanPublicId: t.String({ format: "uuid" }),
            asOfDate: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
        }, { additionalProperties: t.Never() }),
    })
    .post("/:id/execute", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            return await executeLoanSettlement(loanCommandContext(user, request), {
                settlementPublicId: params.id,
                previewHash: body.previewHash,
                confirmed: body.confirmed,
                reason: body.reason,
            });
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: settlementIdParams,
        body: t.Object({
            previewHash: t.String({ pattern: "^v1:[0-9a-fA-F]{64}$" }),
            confirmed: t.Boolean(),
            reason: t.String({ minLength: 1, maxLength: 2000 }),
        }, { additionalProperties: t.Never() }),
    })
    .post("/:id/reverse", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            return await reverseLoanSettlement(loanCommandContext(user, request), {
                settlementPublicId: params.id,
                reason: body.reason,
            });
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: settlementIdParams,
        body: t.Object({
            reason: t.String({ minLength: 1, maxLength: 2000 }),
        }, { additionalProperties: t.Never() }),
    });
