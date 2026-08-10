import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import BorrowerCard from "../src/pages/dashboard/borrowers/BorrowerCard";

const borrower = {
  id: 1,
  publicId: "11111111-1111-4111-8111-111111111111",
  name: "Sample Borrower",
  photoUrl: null,
  idCardNumber: "1234567890123",
  tags: ["Sample alias"],
  phone: "0812345678",
  creditScore: 720,
  googleMapsUrl: null,
};

const originalClipboard = navigator.clipboard;

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
});

describe("BorrowerCard", () => {
  test("masks a visible ID while copying the complete stored value", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <MemoryRouter>
        <BorrowerCard borrower={borrower} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByText("1-2345-•••••-12-3")).toBeInTheDocument();
    expect(screen.queryByText("1-2345-67890-12-3")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /copy id card/i }));

    expect(writeText).toHaveBeenCalledWith("1234567890123");
    expect(await screen.findByRole("status")).toHaveTextContent(/copied/i);
  });

  test("does not offer copy when an ID is missing or malformed", () => {
    render(
      <MemoryRouter>
        <BorrowerCard borrower={{ ...borrower, idCardNumber: null }} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/no id card/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy id card/i })).not.toBeInTheDocument();
  });
});
