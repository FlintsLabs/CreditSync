import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { EvidencePreviewButton } from "../src/components/evidence/EvidencePreviewButton";

describe("EvidencePreviewButton", () => {
    test("resolves lazily, previews an image, and clears it when closed", async () => {
        const user = userEvent.setup();
        const resolve = vi.fn().mockResolvedValue({ url: "https://signed.example/slip.jpg", mimeType: "image/jpeg" });
        render(<EvidencePreviewButton available label="Preview slip" resolve={resolve} />);

        expect(resolve).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Preview slip" }));
        expect(await screen.findByRole("img", { name: "Preview slip" })).toHaveAttribute("src", "https://signed.example/slip.jpg");
        expect(resolve).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: /close/i }));
        expect(screen.queryByRole("img", { name: "Preview slip" })).not.toBeInTheDocument();
    });

    test("retries a failed resolver and renders PDFs", async () => {
        const user = userEvent.setup();
        const resolve = vi.fn()
            .mockRejectedValueOnce(new Error("expired"))
            .mockResolvedValueOnce({ url: "https://signed.example/slip.pdf", mimeType: "application/pdf" });
        render(<EvidencePreviewButton available label="Preview document" resolve={resolve} />);

        await user.click(screen.getByRole("button", { name: "Preview document" }));
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /retry/i }));
        expect(await screen.findByTitle("Preview document")).toHaveAttribute("src", "https://signed.example/slip.pdf");
    });

    test("renders nothing when evidence is unavailable", async () => {
        const resolve = vi.fn();
        const { container } = render(<EvidencePreviewButton available={false} label="Preview slip" resolve={resolve} />);
        expect(container).toBeEmptyDOMElement();
        await waitFor(() => expect(resolve).not.toHaveBeenCalled());
    });

    test("discards an in-flight signed descriptor after the preview closes", async () => {
        const user = userEvent.setup();
        let finish!: (value: { url: string; mimeType: string }) => void;
        let finishFresh!: (value: { url: string; mimeType: string }) => void;
        const resolve = vi.fn()
            .mockImplementationOnce(() => new Promise((done) => { finish = done; }))
            .mockImplementationOnce(() => new Promise((done) => { finishFresh = done; }));
        render(<EvidencePreviewButton available label="View slip" resolve={resolve} />);

        await user.click(screen.getByRole("button", { name: "View slip" }));
        await user.click(screen.getByRole("button", { name: /close/i }));
        finish({ url: "https://signed.example/expired.jpg", mimeType: "image/jpeg" });
        await waitFor(() => expect(screen.queryByRole("img")).not.toBeInTheDocument());

        await user.click(screen.getByRole("button", { name: "View slip" }));
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
        finishFresh({ url: "https://signed.example/fresh.jpg", mimeType: "image/jpeg" });
        expect(await screen.findByRole("img", { name: "View slip" })).toHaveAttribute("src", "https://signed.example/fresh.jpg");
        expect(resolve).toHaveBeenCalledTimes(2);
    });
});
