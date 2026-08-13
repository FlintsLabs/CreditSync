import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import {
    createIntermediatedDisbursementGroup,
    createTransferEvent,
    getIntermediatedDisbursementGroup,
    listIntermediatedDisbursementGroups,
    previewIntermediatedDisbursement,
} from "../services/intermediated-disbursement-service";

type RouteUser = { id: number; tenantId: string };

function context(user: RouteUser, request: Request): CommandContext {
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

function failure(error: unknown, set: { status?: number | string }) {
    const result = presentDomainError(error);
    set.status = result.status;
    return result.body;
}

async function invoke<T>(
    user: RouteUser | null,
    request: Request,
    set: { status?: number | string },
    operation: (ctx: CommandContext) => Promise<T>,
) {
    if (!user) return failure(new DomainError("UNAUTHORIZED", "Unauthorized", 401), set);
    try {
        return await operation(context(user, request));
    } catch (error) {
        return failure(error, set);
    }
}

const money = t.String({ pattern: "^(0|[1-9]\\d*)\\.\\d{2}$", maxLength: 32 });
const groupId = { params: t.Object({ id: t.String({ format: "uuid" }) }, { additionalProperties: t.Never() }) };

export const intermediatedDisbursementsRoute = new Elysia({ normalize: false })
    .use(authPlugin)
    .get(
        "/intermediated-disbursements",
        ({ query, user, request, set }) => invoke(user, request, set, (ctx) => listIntermediatedDisbursementGroups(ctx, query)),
        {
            query: t.Object({
                loanPublicId: t.Optional(t.String({ format: "uuid" })),
                intermediaryPublicId: t.Optional(t.String({ format: "uuid" })),
                status: t.Optional(t.Union([
                    t.Literal("draft"),
                    t.Literal("needs_review"),
                    t.Literal("ready"),
                    t.Literal("posted"),
                    t.Literal("reversed"),
                ])),
            }, { additionalProperties: t.Never() }),
        },
    )
    .post(
        "/intermediated-disbursements",
        ({ body, user, request, set }) => invoke(user, request, set, (ctx) => createIntermediatedDisbursementGroup(ctx, body)),
        {
            body: t.Object({
                loanPublicId: t.String({ format: "uuid" }),
                intermediaryPublicId: t.String({ format: "uuid" }),
                retainedBalance: money,
                note: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
            }, { additionalProperties: t.Never() }),
        },
    )
    .get(
        "/intermediated-disbursements/:id",
        ({ params, user, request, set }) => invoke(user, request, set, (ctx) => getIntermediatedDisbursementGroup(ctx, params.id)),
        groupId,
    )
    .post(
        "/intermediated-disbursements/:id/events",
        ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => createTransferEvent(ctx, params.id, body)),
        {
            ...groupId,
            body: t.Object({
                role: t.Union([
                    t.Literal("funding_to_intermediary"),
                    t.Literal("borrower_net_payout"),
                    t.Literal("advance_interest_return"),
                ]),
                channel: t.Union([
                    t.Literal("bank_transfer"),
                    t.Literal("cash"),
                    t.Literal("adjustment"),
                ]),
                amount: money,
                transferredAt: t.String({ format: "date-time" }),
                intermediaryBankAccountPublicId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
                senderHint: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
                payeeHint: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
                bankReference: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
                note: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
            }, { additionalProperties: t.Never() }),
        },
    )
    .post(
        "/intermediated-disbursements/:id/preview",
        ({ params, user, request, set }) => invoke(user, request, set, (ctx) => previewIntermediatedDisbursement(ctx, params.id)),
        {
            ...groupId,
            body: t.Object({}, { additionalProperties: t.Never() }),
        },
    );
