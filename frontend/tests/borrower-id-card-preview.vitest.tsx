import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import BorrowerForm from "../src/pages/dashboard/borrowers/BorrowerForm";

describe("Borrower ID-card preview", () => {
    test("offers a full preview without replacing the existing upload control", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><BorrowerForm initialData={{ id: 1, name: "Borrower", idCardImageUrl: "https://signed.example/id.jpg", idCardImageRef: "s3://private/id.jpg" }} /></MemoryRouter>);
        expect(document.querySelector('input[type="file"]')).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /preview id card/i }));
        expect(await screen.findByRole("img", { name: /preview id card/i })).toHaveAttribute("src", "https://signed.example/id.jpg");
    });
});
