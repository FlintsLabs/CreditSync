import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import BorrowerCard from "../src/pages/dashboard/borrowers/BorrowerCard";
import BorrowerList from "../src/pages/dashboard/borrowers/BorrowerList";
import { api } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn() } }));

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BorrowerCard", () => {
  test("uses compact vertical padding for the borrower header and actions", () => {
    const { container } = render(
      <MemoryRouter>
        <BorrowerCard borrower={borrower} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    const card = container.querySelector(".w-full.rounded-xl");
    expect(card?.children[0]).toHaveClass("pt-3", "pb-2");
    expect(card?.children[2]).toHaveClass("pt-3", "pb-3");
  });

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

  test("sizes columns from the available list width instead of the viewport", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: [borrower, { ...borrower, id: 2, publicId: "22222222-2222-4222-8222-222222222222", name: "Second Borrower" }],
    });

    render(
      <MemoryRouter>
        <BorrowerList />
      </MemoryRouter>,
    );

    const grid = await screen.findByTestId("borrower-card-grid");
    expect(grid).toHaveClass("grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))]");
    expect(grid.firstElementChild).toHaveClass("w-full");
  });
});
