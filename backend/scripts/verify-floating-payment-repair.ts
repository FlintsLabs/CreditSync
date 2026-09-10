import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { loans, users } from "../src/db/schema";
import { getLoanPaymentHealth } from "../src/services/loan-payment-health-service";

const loanPublicIds = [
    "019ff2b2-15e2-7df7-a594-eb836ff388f0",
    "019feace-78db-7829-8e40-0bed0febe17c",
    "01a068d3-23b6-7789-a16f-9bc4d05dea96",
    "01a01aee-9191-7dc5-962e-eac5ddeb0e60",
    "01a0447b-a456-75f8-9375-63e264a822ea",
];
const rows = await db.select().from(loans).where(inArray(loans.publicId, loanPublicIds));
const output = [];
for (const loan of rows) {
    const actor = await db.query.users.findFirst({ where: and(eq(users.tenantId, loan.tenantId), eq(users.role, "owner")) });
    if (!actor) throw new Error(`No owner actor for ${loan.publicId}`);
    const health = await getLoanPaymentHealth(db, loan, { asOf: new Date("2026-09-10T12:00:00+07:00"), actorUserId: actor.id });
    output.push({ loanPublicId: loan.publicId, ...health });
}
console.log(JSON.stringify({ asOf: "2026-09-10", verifiedLoans: output.length, results: output }, null, 2));
