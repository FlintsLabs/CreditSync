import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { paymentIntakes, users } from "../src/db/schema";
import type { CommandContext } from "../src/services/command-context";
import { backfillPostedRestoreSchedule } from "../src/services/payment-reconciliation-service";

const paymentIntakePublicId = process.env.TARGET_PAYMENT_INTAKE_PUBLIC_ID;
const execute = process.env.EXECUTE_BACKFILL === "yes";
if (!paymentIntakePublicId) throw new Error("TARGET_PAYMENT_INTAKE_PUBLIC_ID is required");

const intake = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, paymentIntakePublicId) });
if (!intake) throw new Error("Target payment intake not found");
const actorUserId = intake.createdByUserId ?? intake.ownerUserId;
if (actorUserId === null) throw new Error("Target payment intake has no actor");
const actor = await db.query.users.findFirst({ where: and(eq(users.tenantId, intake.tenantId), eq(users.id, actorUserId)) });
if (!actor) throw new Error("Target actor not found");

const idempotencyKey = `restore-schedule-backfill:${paymentIntakePublicId}:v1`;
const reason = "Repair schedule aggregate after verified exact payment restore";
console.log(JSON.stringify({ execute, paymentIntakePublicId, idempotencyKey, reason }));
if (!execute) process.exit(0);

const context: CommandContext = {
    tenantId: intake.tenantId,
    actorUserId: actor.id,
    actorSource: "system",
    requestId: idempotencyKey,
    correlationId: idempotencyKey,
    idempotencyKey,
};
const result = await backfillPostedRestoreSchedule(context, { paymentIntakePublicId, reason, idempotencyKey });
console.log(JSON.stringify(result));
