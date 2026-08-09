import { and, eq } from "drizzle-orm";
import { borrowers, files, loans, transactions } from "../db/schema";

export interface AuthenticatedUser {
    id: number;
    email: string;
    role: string;
    tenantId: string;
}

const tenantWideRoles = new Set(["owner", "manager"]);

export function canAccessTenantWideData(user: Pick<AuthenticatedUser, "role">) {
    return tenantWideRoles.has(user.role);
}

export function isTenantAdminUser(user: AuthenticatedUser | null): user is AuthenticatedUser {
    return !!user && canAccessTenantWideData(user);
}

export function getAccessScopeCacheKey(user: AuthenticatedUser) {
    return canAccessTenantWideData(user) ? "tenant" : `user:${user.id}`;
}

export function requireTenantAdmin(user: AuthenticatedUser | null, set: { status?: number }) {
    if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
    }

    if (!canAccessTenantWideData(user)) {
        set.status = 403;
        return { error: "Forbidden" };
    }

    return null;
}

export function borrowerAccessFilters(user: AuthenticatedUser) {
    const filters = [eq(borrowers.tenantId, user.tenantId)];
    if (!canAccessTenantWideData(user)) {
        filters.push(eq(borrowers.ownerUserId, user.id));
    }
    return filters;
}

export function loanAccessFilters(user: AuthenticatedUser) {
    const filters = [eq(loans.tenantId, user.tenantId)];
    if (!canAccessTenantWideData(user)) {
        filters.push(eq(loans.ownerUserId, user.id));
    }
    return filters;
}

export function transactionAccessFilters(user: AuthenticatedUser) {
    const filters = [eq(transactions.tenantId, user.tenantId)];
    if (!canAccessTenantWideData(user)) {
        filters.push(eq(transactions.ownerUserId, user.id));
    }
    return filters;
}

export function fileAccessFilters(user: AuthenticatedUser) {
    const filters = [eq(files.tenantId, user.tenantId)];
    if (!canAccessTenantWideData(user)) {
        filters.push(eq(files.ownerUserId, user.id));
    }
    return filters;
}

export function assertBorrowerAccess(user: AuthenticatedUser, borrowerOwnerUserId: number | null) {
    return canAccessTenantWideData(user) || borrowerOwnerUserId === user.id;
}

export function mergeFilters<T>(filters: T[], extra?: T) {
    return extra ? and(...filters, extra) : and(...filters);
}
