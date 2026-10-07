import { describe, expect, it } from "vitest";
import { bangkokReceiptInput, bangkokReceiptTimestamp, buildReceiptAllocations, receiptAllocationTotal } from "./transaction-entry-model";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const base = { id: "row-1", borrowerPublicId: a, loanPublicId: b, schedulePublicId: c };

describe("receipt allocation model", () => {
    it("adds exact decimal strings including cents", () => {
        expect(receiptAllocationTotal([{ ...base, amount: "1000.00" }, { ...base, id: "2", loanPublicId: a, amount: "2000.00" }], "en-US")).toBe("3000.00");
        expect(receiptAllocationTotal([{ ...base, amount: "0.10" }, { ...base, id: "2", loanPublicId: a, amount: "0.20" }], "en-US")).toBe("0.30");
        expect(receiptAllocationTotal([{ ...base, amount: "9007199254740993.01" }, { ...base, id: "2", loanPublicId: a, amount: "0.09" }], "en-US")).toBe("9007199254740993.10");
    });

    it("rejects duplicate contract schedule targets but accepts separate installments", () => {
        expect(() => buildReceiptAllocations([{ ...base, amount: "1" }, { ...base, id: "2", amount: "2" }], "en-US")).toThrow(/duplicate/i);
        expect(buildReceiptAllocations([{ ...base, amount: "1" }, { ...base, id: "2", schedulePublicId: a, amount: "2" }], "en-US")).toHaveLength(2);
    });

    it.each(["", "abc", "0", "-1", "1.001", "1e2", "1" + "0".repeat(29) + ".00"])("rejects invalid allocation money %s", (amount) => {
        expect(() => receiptAllocationTotal([{ ...base, amount }], "en-US")).toThrow();
    });

    it("accepts locale grouping and enforces the public amount bound", () => {
        expect(receiptAllocationTotal([{ ...base, amount: "1,234.50" }], "en-US")).toBe("1234.50");
        expect(() => receiptAllocationTotal([{ ...base, amount: "9".repeat(29) + ".99" }, { ...base, id: "2", loanPublicId: a, amount: "0.01" }], "en-US")).toThrow(/bound|maximum|public/i);
    });
});

describe("Bangkok receipt time", () => {
    it("converts local Bangkok time to UTC independent of machine timezone", () => {
        expect(bangkokReceiptTimestamp("2026-10-07T12:12")).toBe("2026-10-07T05:12:00.000Z");
        expect(bangkokReceiptInput("2026-10-07T05:12:00.000Z")).toBe("2026-10-07T12:12");
    });

    it("rejects impossible local dates", () => {
        expect(() => bangkokReceiptTimestamp("2026-02-30T12:12")).toThrow();
    });
});
