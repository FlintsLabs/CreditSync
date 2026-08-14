import { describe, expect, test } from "vitest";
import { getBorrowerLabels, getVisibleBorrowerLabels, loanMatchesSearch } from "../src/pages/dashboard/loans/loan-list-model";

describe("loan list label model", () => {
    test("normalizes aliases before tags and deduplicates with Unicode-insensitive matching", () => {
        const loan = {
            id: "loan-123",
            publicId: "loan-123",
            borrowerName: "สมหญิง ใจดี",
            borrowerAliases: [" นก ", "VIP", "", "VIP "],
            borrowerTags: ["vip", "ตลาดเช้า", "เจ้าประจำ", "vip"],
        };

        expect(getBorrowerLabels(loan)).toEqual(["นก", "VIP", "ตลาดเช้า", "เจ้าประจำ"]);
        expect(getVisibleBorrowerLabels(loan)).toEqual({
            visible: ["นก", "VIP", "ตลาดเช้า"],
            overflow: 1,
        });
        expect(loanMatchesSearch(loan, "เจ้าประจำ")).toBe(true);
        expect(loanMatchesSearch(loan, "loan-123")).toBe(true);
        expect(loanMatchesSearch(loan, "ไม่พบ")).toBe(false);
    });

    test("treats missing alias and tag arrays as empty and normalizes aliases with spaces/Unicode case", () => {
        const loan = {
            id: "loan-456",
            publicId: "loan-456",
            borrowerName: "สมชาย",
        };

        expect(getBorrowerLabels(loan)).toEqual([]);
        expect(getVisibleBorrowerLabels(loan)).toEqual({ visible: [], overflow: 0 });
        expect(loanMatchesSearch(loan, "  สมชาย ")).toBe(true);
        expect(loanMatchesSearch(loan, "LOAN-456")).toBe(true);
        expect(loanMatchesSearch(loan, "กข")).toBe(false);
        expect(getBorrowerLabels({ ...loan, borrowerAliases: [" ｎｋ "], borrowerTags: ["ＮＫ"] })).toEqual(["ｎｋ"]);
    });
});
