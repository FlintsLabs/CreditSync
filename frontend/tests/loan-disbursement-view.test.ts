import { describe, expect, it } from "vitest";
import { formatDisbursementSummary } from "../src/lib/disbursement-view";

describe("formatDisbursementSummary", () => {
    it("uses the exact signed variance to classify the ledger", () => {
        expect(formatDisbursementSummary({ approvedPrincipal: "5000.00", netDisbursed: "4800.00", variance: "-200.00" }).status).toBe("under_disbursed");
        expect(formatDisbursementSummary({ approvedPrincipal: "5000.00", netDisbursed: "5000.00", variance: "0.00" }).status).toBe("matched");
        expect(formatDisbursementSummary({ approvedPrincipal: "5000.00", netDisbursed: "5000.01", variance: "0.01" }).status).toBe("over_disbursed");
    });
});
