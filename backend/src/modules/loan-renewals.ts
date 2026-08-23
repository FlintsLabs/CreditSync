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

function assertClosedPreviewBody(body: Record<string, unknown>) {
    const allowed = ["oldLoanPublicId", "requestedPrincipal", "settlementPolicy", "adjustments", "waivedCharges", "waiverReason"];
    const unexpectedFields = Object.keys(body).filter((key) => !allowed.includes(key)).map((key) => `body.${key}`);
    const adjustments = body.adjustments as Array<Record<string, unknown>> | undefined;
    adjustments?.forEach((line, index) => {
        for (const key of Object.keys(line)) {
            if (!["kind", "amount", "reason"].includes(key)) unexpectedFields.push(`body.adjustments.${index}.${key}`);
        }
    });
    if (unexpectedFields.length) {
        throw new DomainError("VALIDATION_ERROR", "Request body contains unknown fields", 422, { unexpectedFields });
    }
}

export const loanRenewalsRoute = new Elysia({ prefix: "/loan-renewals", normalize: false })
    .use(authPlugin)
    .post("/preview", async ({ body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            assertClosedPreviewBody(body as unknown as Record<string, unknown>);
            return await previewLoanRenewal(commandContext(user, request), body.oldLoanPublicId, {
                requestedPrincipal: body.requestedPrincipal,
                settlementPolicy: body.settlementPolicy,
                adjustments: body.adjustments,
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
            settlementPolicy: t.Optional(t.Union([
                t.Literal("full_contract_interest"),
                t.Literal("accrued_to_date"),
            ])),
            adjustments: t.Optional(t.Array(t.Object({
                kind: t.Union([
                    t.Literal("fee"),
                    t.Literal("penalty"),
                    t.Literal("other_charge"),
                    t.Literal("waiver"),
                ]),
                amount: t.String({ pattern: "^(?:0|[1-9]\\d{0,28})\\.\\d{2}$" }),
                reason: t.String({ minLength: 1, maxLength: 500 }),
            }, { additionalProperties: true }), { maxItems: 50 })),
            waivedCharges: t.Optional(t.String()),
            waiverReason: t.Optional(t.Nullable(t.String())),
        }, { additionalProperties: true }),
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
