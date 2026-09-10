import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { LoanDetailTabs } from "./LoanDetailTabs";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({
        t: (_key: string, fallback?: string) => fallback ?? _key,
    }),
}));

describe("LoanDetailTabs", () => {
    test("includes an accrual table tab", () => {
        render(<LoanDetailTabs value="information" onChange={() => undefined} renderPanel={() => null} />);

        expect(screen.getByRole("tab", { name: "Accrual Table" })).toBeTruthy();
    });
});
