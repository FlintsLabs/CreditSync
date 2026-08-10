import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import {
    createPaymentIntake,
    finalizePaymentEvidence,
    getPaymentIntake,
    listPaymentIntakes,
    listPaymentReviewQueue,
    postPayment,
    preparePaymentEvidence,
    previewPaymentMatch,
    reversePayment,
    reviewPaymentIntake,
} from "../services/payment-service";

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

const explicitAllocation = t.Object({
    borrowerPublicId: t.String(),
    loanPublicId: t.String(),
    schedulePublicId: t.Optional(t.String()),
    amount: t.String(),
});

export const paymentIntakesRoute = new Elysia({ prefix: "/payment-intakes" })
    .use(authPlugin)
    .get("/review-queue", async ({ user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await listPaymentReviewQueue(commandContext(user, request));
        } catch (error) {
            return domainFailure(error, set);
        }
    })
    .get("/", async ({ query, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await listPaymentIntakes(commandContext(user, request), { status: query.status });
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { query: t.Object({ status: t.Optional(t.String()) }) })
    .post("/", async ({ body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await createPaymentIntake(commandContext(user, request), body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        body: t.Object({
            amount: t.String(),
            receivedAt: t.String(),
            payerName: t.Optional(t.Nullable(t.String())),
            bankReference: t.Optional(t.Nullable(t.String())),
            qrPayload: t.Optional(t.Nullable(t.String())),
            notes: t.Optional(t.Nullable(t.String())),
            originLoanPublicId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
        }),
    })
    .get("/:id", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await getPaymentIntake(commandContext(user, request), params.id);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }) })
    .post("/:id/review", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await reviewPaymentIntake(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({
            status: t.Union([t.Literal("draft"), t.Literal("needs_review")]),
            notes: t.Optional(t.Nullable(t.String())),
        }),
    })
    .post("/:id/evidence/upload-intents", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await preparePaymentEvidence(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({
            mimeType: t.String(),
            size: t.Number(),
            sha256: t.String(),
            evidenceType: t.Optional(t.Union([t.Literal("slip"), t.Literal("qr")])),
            url: t.Optional(t.String()),
        }),
    })
    .post("/:id/evidence/:evidenceId/finalize", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await finalizePaymentEvidence(commandContext(user, request), params.id, params.evidenceId);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String(), evidenceId: t.String() }) })
    .post("/:id/match-preview", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await previewPaymentMatch(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({ allocations: t.Optional(t.Array(explicitAllocation)) }),
    })
    .post("/:id/post", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await postPayment(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({ proposalPublicId: t.String() }),
    })
    .post("/:id/reverse", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await reversePayment(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({ reason: t.String() }),
    });
