import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { floatingTransactionAllocations, loanInterestAccruals, loans } from "../src/db/schema";
import { findFloatingAllocationIssues } from "../src/lib/floating-allocation-integrity";

const loanRows = await db.select({ id: loans.id, publicId: loans.publicId, status: loans.status })
    .from(loans).where(eq(loans.repaymentType, "floating"));
const loanIds = loanRows.map((loan) => loan.id);
const [accrualRows, allocationRows] = loanIds.length
    ? await Promise.all([
        db.select().from(loanInterestAccruals).where(inArray(loanInterestAccruals.loanId, loanIds)),
        db.select().from(floatingTransactionAllocations).where(and(
            inArray(floatingTransactionAllocations.loanId, loanIds),
            eq(floatingTransactionAllocations.component, "interest"),
        )),
    ])
    : [[], []];

const results = loanRows.flatMap((loan) => {
    const issues = findFloatingAllocationIssues({
        accruals: accrualRows.filter((row) => row.loanId === loan.id),
        allocations: allocationRows.filter((row) => row.loanId === loan.id),
    });
    return issues.length ? [{ loanPublicId: loan.publicId, loanStatus: loan.status, issues }] : [];
});

console.log(JSON.stringify({
    scannedFloatingLoans: loanRows.length,
    affectedLoans: results.length,
    issueCount: results.reduce((sum, item) => sum + item.issues.length, 0),
    results,
}, null, 2));
