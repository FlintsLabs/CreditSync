import { describe, expect, test } from "vitest";
import { loanListHeaderClassName, loanListHeaderActionsClassName } from "../src/pages/dashboard/loans/loan-list-layout";

describe("loan list responsive header", () => {
    test("wraps the action group below the heading when the row runs out of space", () => {
        expect(loanListHeaderClassName.split(" ")).toContain("flex-wrap");
        expect(loanListHeaderClassName.split(" ")).toContain("gap-4");
        expect(loanListHeaderActionsClassName.split(" ")).toContain("flex-wrap");
    });
});
