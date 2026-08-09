import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import {
    executeLoanRenewal,
    previewLoanRenewal,
    reverseLoanRenewal,
} from "../services/loan-renewal-service";

type RouteUser = { id: number; tenantId: string };

function commandContext(user: RouteUser, request: Request): CommandContext {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    return {
        tenantId: user.tenantId,
        actorUserId: user.id,
        actorSource: "web",
        requestId,
        correlationId: request.headers.get("x-correlation-id") ?? requestId,
        idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    };
}

function domainFailure(error: unknown, set: { status?: number | string }) {
    const presented = presentDomainError(error);
    set.status = presented.status;
    return presented.body;
}

function unauthorized(set: { status?: number | string }) {
    return domainFailure(new DomainError("UNAUTHORIZED", "Unauthorized", 401), set);
}

export const loanRenewalsRoute = new Elysia({ prefix: "/loan-renewals" })
    .use(authPlugin)
    .post("/preview", async ({ body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await previewLoanRenewal(commandContext(user, request), body.oldLoanPublicId, {
                requestedPrincipal: body.requestedPrincipal,
                waivedCharges: body.waivedCharges,
                waiverReason: body.waiverReason ?? undefined,
            });
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        body: t.Object({
            oldLoanPublicId: t.String(),
            requestedPrincipal: t.String(),
            waivedCharges: t.Optional(t.String()),
            waiverReason: t.Optional(t.Nullable(t.String())),
        }),
    })
    .post("/:id/execute", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await executeLoanRenewal(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({
            previewHash: t.String(),
            confirmed: t.Boolean(),
            reason: t.String(),
        }),
    })
    .post("/:id/reverse", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await reverseLoanRenewal(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({ reason: t.String() }),
    });
