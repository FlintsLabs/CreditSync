import { Elysia, t } from "elysia";
import { invalidateTenantCache } from "../lib/cache";
import { authPlugin } from "../middleware/auth";
import { DomainError } from "../services/domain-error";
import { postFloatingAccrualPayment, previewFloatingAccrualPayment } from "../services/floating-accrual-payment-service";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";

const loanIdParams = t.Object({ id: t.String({ format: "uuid" }) });
const targetSchema = t.Object({
    accrualDate: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    amount: t.String({ pattern: "^(0|[1-9]\\d*)\\.\\d{2}$", maxLength: 32 }),
}, { additionalProperties: false });
const previewBody = t.Object({
    amount: t.String({ pattern: "^(0|[1-9]\\d*)\\.\\d{2}$", maxLength: 32 }),
    receivedAt: t.String({ format: "date-time" }),
    targets: t.Array(targetSchema, { minItems: 1, maxItems: 366 }),
    paymentIntakePublicId: t.Optional(t.String({ format: "uuid" })),
    notes: t.Optional(t.Nullable(t.String({ maxLength: 4000 }))),
    bankReference: t.Optional(t.Nullable(t.String({ maxLength: 512 }))),
}, { additionalProperties: false });
const postBody = t.Object({
    paymentIntakePublicId: t.String({ format: "uuid" }),
    proposalPublicId: t.String({ format: "uuid" }),
    confirmed: t.Literal(true),
}, { additionalProperties: false });

function assertCommandHeaders(request: Request) {
    if (!request.headers.get("x-request-id")?.trim() || !request.headers.get("x-correlation-id")?.trim()) {
        throw new DomainError("COMMAND_CONTEXT_REQUIRED", "X-Request-Id and X-Correlation-Id are required", 400);
    }
    if (!request.headers.get("idempotency-key")?.trim()) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required", 400);
}

export const loanAccrualPaymentRoutes = new Elysia({ normalize: false }).use(authPlugin)
    .post("/:id/accrual-payments/preview", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertCommandHeaders(request);
            return await previewFloatingAccrualPayment(loanCommandContext(user, request), params.id, body);
        } catch (error) { return loanDomainFailure(error, set); }
    }, { params: loanIdParams, body: previewBody })
    .post("/:id/accrual-payments/post", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertCommandHeaders(request);
            const result = await postFloatingAccrualPayment(loanCommandContext(user, request), params.id, body);
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) { return loanDomainFailure(error, set); }
    }, { params: loanIdParams, body: postBody });
