import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import i18n from "../src/lib/i18n";
import { FloatingInterestRateCard } from "../src/pages/dashboard/loans/FloatingInterestRateCard";

const LOAN_ID = "0198c481-3e2b-7000-8000-000000000031";
const PERIOD_ID = "0198c481-3e2b-7000-8000-000000000032";
const PREVIEW_ID = "0198c481-3e2b-7000-8000-000000000033";
const HASH = `v1:${"a".repeat(64)}`;

const timeline = {
    loanPublicId: LOAN_ID, asOfDate: "2026-08-11", earliestEditableDate: "2026-08-12", timelineVersion: "b".repeat(64),
    currentPeriod: { publicId: PERIOD_ID, effectiveDate: "2026-08-01", expiryDate: null, rateType: "per_thousand", rate: "15.0000" },
    dailyInterestAtCurrentPrincipal: "60.00", nextChange: null,
    timeline: [{ publicId: PERIOD_ID, effectiveDate: "2026-08-01", expiryDate: null, rateType: "per_thousand", rate: "15.0000" }],
};

describe("FloatingInterestRateCard", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("en");
        vi.restoreAllMocks();
        vi.spyOn(api, "get").mockResolvedValue({ data: timeline } as never);
    });

    it("shows exact daily interest and executes only the previewed confirmed change", async () => {
        const post = vi.spyOn(api, "post").mockImplementation(async (url) => {
            if (String(url).endsWith("/preview")) return { data: {
                publicId: PREVIEW_ID, previewHash: HASH, expiresAt: "2026-08-11T10:15:00.000Z",
                request: { effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1.0000" },
                beforeTimeline: timeline.timeline,
                afterTimeline: [
                    { ...timeline.timeline[0], expiryDate: "2026-08-31" },
                    { publicId: PREVIEW_ID, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1.0000" },
                ],
            } } as never;
            return { data: { ...timeline, nextChange: { publicId: PREVIEW_ID, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1.0000" } } } as never;
        });
        render(<FloatingInterestRateCard loanPublicId={LOAN_ID} />);

        expect(await screen.findByText(/60\.00/)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-09-01" } });
        fireEvent.change(screen.getByLabelText("Rate type"), { target: { value: "percent" } });
        fireEvent.change(screen.getByLabelText("Rate"), { target: { value: "1" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview rate change" }));

        expect(await screen.findByRole("heading", { name: "Confirm this interest timeline?" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Confirm rate change" })).toBeDisabled();
        fireEvent.change(screen.getByLabelText("Reason for change"), { target: { value: "Owner approved" } });
        fireEvent.click(screen.getByRole("button", { name: "Confirm rate change" }));

        await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
        expect(post.mock.calls[1]?.[1]).toEqual({ previewPublicId: PREVIEW_ID, previewHash: HASH, reason: "Owner approved" });
        expect(post.mock.calls[1]?.[2]).toMatchObject({ headers: { "Idempotency-Key": expect.any(String) } });
    });
});
