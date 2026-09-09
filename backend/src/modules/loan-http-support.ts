import Decimal from "decimal.js";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import { parseMoney } from "../lib/money";

export type RouteUser = { id: number; tenantId: string };

export function loanCommandContext(user: RouteUser, request: Request): CommandContext {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "web", requestId, correlationId: request.headers.get("x-correlation-id") ?? requestId, idempotencyKey: request.headers.get("idempotency-key") ?? undefined };
}

export function loanDomainFailure(error: unknown, set: { status?: number | string }) {
    const presented = presentDomainError(error);
    set.status = presented.status;
    return presented.body;
}

export function loanUnauthorized(set: { status?: number | string }) {
    return loanDomainFailure(new DomainError("UNAUTHORIZED", "Unauthorized", 401), set);
}

export function loanForbidden(set: { status?: number | string }) {
    return loanDomainFailure(new DomainError("FORBIDDEN", "Forbidden", 403), set);
}

export function loanMoneyInput(value: string, field: string) {
    try { return parseMoney(value); }
    catch { throw new DomainError("INVALID_MONEY", `${field} must be a non-negative string with exactly two decimals`, 400); }
}

export function serializeSignedMoney(value: Decimal.Value) {
    const money = new Decimal(value);
    if (!money.isFinite()) throw new DomainError("INVALID_MONEY", "Money must be finite", 500);
    return money.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
