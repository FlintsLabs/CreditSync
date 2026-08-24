import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import appI18n from "../../../lib/i18n";
import { RenewalSummaryCard } from "./RenewalSummaryCard";
import { summaryFixture } from "./renewal-summary-image.test";

describe("RenewalSummaryCard", () => {
    beforeEach(async () => { await appI18n.changeLanguage("en"); });
    test("shows the deterministic preview and download without an execute action", () => {
        render(<RenewalSummaryCard summary={summaryFixture} />);
        expect(screen.getByLabelText(/summary image preview/i)).not.toBeNull();
        expect(screen.getByRole("button", { name: /download summary image/i })).not.toBeNull();
        expect(screen.getByRole("button", { name: /copy summary image/i })).not.toBeNull();
        expect(screen.queryByRole("button", { name: /confirm renewal/i })).toBeNull();
    });
});
