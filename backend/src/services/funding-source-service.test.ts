import { describe, expect, test } from "bun:test";
import { presentFundingSources } from "./funding-source-service";

describe("funding source service", () => {
    test("presents read-only funding sources with public UUIDs and exact money strings only", () => {
        const result = presentFundingSources(
            [{
                id: 11,
                publicId: "0198c481-3e2b-7000-8000-000000000011",
                name: "Capital Pool",
                type: "personal_savings",
                providerName: null,
                status: "active",
                creditLimit: "100000.5",
                accountingMode: "capital_pool",
                reinvestProfitMode: "retain_in_pool",
            }],
            [{
                id: 22,
                publicId: "0198c481-3e2b-7000-8000-000000000022",
                bankProfileId: 11,
                amount: "50000",
                outstandingPrincipal: "25000.1",
                outstandingInterest: "100.2",
                outstandingFees: "0",
                outstandingPenalties: "5",
                interestRate: "7.5",
                startDate: "2026-01-01",
                termMonths: 12,
                status: "active",
            }],
        );

        expect(result).toEqual({
            profiles: [{
                publicId: "0198c481-3e2b-7000-8000-000000000011",
                name: "Capital Pool",
                type: "personal_savings",
                providerName: null,
                status: "active",
                creditLimit: "100000.50",
                accountingMode: "capital_pool",
                reinvestProfitMode: "retain_in_pool",
                drawdowns: [{
                    publicId: "0198c481-3e2b-7000-8000-000000000022",
                    amount: "50000.00",
                    outstandingPrincipal: "25000.10",
                    outstandingInterest: "100.20",
                    outstandingFees: "0.00",
                    outstandingPenalties: "5.00",
                    interestRate: "7.50",
                    startDate: "2026-01-01",
                    termMonths: 12,
                    status: "active",
                }],
            }],
        });
        expect(JSON.stringify(result)).not.toContain('"id":11');
        expect(JSON.stringify(result)).not.toContain('"bankProfileId"');
    });
});
