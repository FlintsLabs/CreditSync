import { Elysia, t } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { fundLedgerEntries, fundRolloverEntries } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { createAuditLog } from "../lib/audit-log";
import { getBankProfileSettlementSummary } from "../lib/fund-settlement";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";

const outgoingEntryTypes = new Set(["surplus_transfer", "refinance_out", "capitalization"]);

export const fundRolloversRoute = new Elysia({ prefix: "/fund-rollovers" })
    .use(authPlugin)
    .get("/", async ({ user, query }) => {
        if (!user) return [];

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "fund-rollovers",
            key: `list:profile=${query.bankProfileId ?? "all"}:loan=${query.bankLoanId ?? "all"}`,
            ttlSeconds: 30,
            loader: async () => {
                const rows = await db.select().from(fundRolloverEntries).where(eq(fundRolloverEntries.tenantId, user.tenantId)).orderBy(desc(fundRolloverEntries.createdAt));

                return rows.filter((row) => {
            if (query.bankProfileId && row.fromBankProfileId !== Number(query.bankProfileId) && row.toBankProfileId !== Number(query.bankProfileId)) {
                return false;
            }
            if (query.bankLoanId && row.fromBankLoanId !== Number(query.bankLoanId) && row.toBankLoanId !== Number(query.bankLoanId)) {
                return false;
            }
            return true;
        });
            },
        });
    }, {
        query: t.Object({
            bankProfileId: t.Optional(t.String()),
            bankLoanId: t.Optional(t.String()),
        })
    })
    .post("/", async ({ body, user, set }) => {
        if (!user) throw new Error("Unauthorized");

        if (!body.fromBankProfileId && !body.toBankProfileId) {
            set.status = 400;
            return { error: "At least one side of the rollover must reference a fund source" };
        }

        if (body.fromBankProfileId) {
            const summary = await getBankProfileSettlementSummary(user.tenantId, body.fromBankProfileId);
            if (outgoingEntryTypes.has(body.entryType) && body.amount > summary.carryForwardAvailable + 0.0001) {
                set.status = 400;
                return {
                    error: "Rollover amount exceeds carry-forward available balance",
                    carryForwardAvailable: summary.carryForwardAvailable,
                };
            }
        }

        return await db.transaction(async (tx) => {
            const created = await tx.insert(fundRolloverEntries).values({
                tenantId: user.tenantId,
                fromBankProfileId: body.fromBankProfileId,
                fromBankLoanId: body.fromBankLoanId,
                toBankProfileId: body.toBankProfileId,
                toBankLoanId: body.toBankLoanId,
                entryType: body.entryType,
                amount: body.amount.toFixed(2),
                effectiveDate: body.effectiveDate,
                note: body.note,
                createdByUserId: user.id,
            }).returning().then((rows) => rows[0]);

            if (body.fromBankProfileId) {
                await tx.insert(fundLedgerEntries).values({
                    tenantId: user.tenantId,
                    bankProfileId: body.fromBankProfileId,
                    bankLoanId: body.fromBankLoanId,
                    rolloverEntryId: created.id,
                    entryDate: new Date(body.effectiveDate),
                    entryType: "rollover_out",
                    amount: body.amount.toFixed(2),
                    note: body.note ?? `Rollover out ${body.entryType}`,
                    createdByUserId: user.id,
                });
            }

            if (body.toBankProfileId) {
                await tx.insert(fundLedgerEntries).values({
                    tenantId: user.tenantId,
                    bankProfileId: body.toBankProfileId,
                    bankLoanId: body.toBankLoanId,
                    rolloverEntryId: created.id,
                    entryDate: new Date(body.effectiveDate),
                    entryType: "rollover_in",
                    amount: body.amount.toFixed(2),
                    note: body.note ?? `Rollover in ${body.entryType}`,
                    createdByUserId: user.id,
                });
            }

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "fund_rollover",
                entityId: created.id,
                action: "created",
                payload: created,
            });

            await invalidateTenantCache(user.tenantId);

            return created;
        });
    }, {
        body: t.Object({
            fromBankProfileId: t.Optional(t.Number()),
            fromBankLoanId: t.Optional(t.Number()),
            toBankProfileId: t.Optional(t.Number()),
            toBankLoanId: t.Optional(t.Number()),
            entryType: t.Union([
                t.Literal("surplus_transfer"),
                t.Literal("deficit_support"),
                t.Literal("refinance_in"),
                t.Literal("refinance_out"),
                t.Literal("capitalization"),
                t.Literal("manual_adjustment"),
            ]),
            amount: t.Number(),
            effectiveDate: t.String(),
            note: t.Optional(t.String()),
        })
    });
