import { describe, expect, test } from "vitest";
import { repaymentLineageTarget } from "./loan-repayment-history-model";

describe("repayment repost lineage", () => {
    test("links a posted child back to the reversed source", () => {
        expect(repaymentLineageTarget({ repostOfIntakePublicId: "source-id", repostedByIntakePublicId: null })).toEqual({
            publicId: "source-id",
            labelKey: "loanDetail.repaymentHistory.viewOriginal",
        });
    });

    test("links a reversed source forward to its posted child", () => {
        expect(repaymentLineageTarget({ repostOfIntakePublicId: null, repostedByIntakePublicId: "child-id" })).toEqual({
            publicId: "child-id",
            labelKey: "loanDetail.repaymentHistory.viewRepost",
        });
    });
});
