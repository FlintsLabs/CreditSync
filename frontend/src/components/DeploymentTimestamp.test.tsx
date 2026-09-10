import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeploymentTimestamp from "./DeploymentTimestamp";

describe("DeploymentTimestamp", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("fetches runtime metadata with no-store and renders the localized timestamp", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ timestamp: "2026-09-10T17:30:00Z" }), { status: 200 }),
        );

        render(<DeploymentTimestamp language="en" unavailableLabel="Deployment time unavailable" label="Deployed" />);

        await waitFor(() => expect(screen.getByTestId("deployment-timestamp")).toBeInTheDocument());
        expect(screen.getByTestId("deployment-timestamp")).toHaveAttribute("datetime", "2026-09-10T17:30:00Z");
        expect(screen.getByTestId("deployment-timestamp")).toHaveTextContent("September 11, 2026");
        expect(fetchMock).toHaveBeenCalledWith("/deployment.json", { cache: "no-store" });
    });

    it("renders the localized fallback when metadata is missing, invalid, or unavailable", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ timestamp: "invalid" }), { status: 200 }),
        );

        render(<DeploymentTimestamp language="th" unavailableLabel="ไม่พบเวลาการ deploy" label="Deploy ล่าสุด" />);

        await waitFor(() => expect(screen.getByTestId("deployment-timestamp-unavailable")).toBeInTheDocument());
        expect(screen.getByTestId("deployment-timestamp-unavailable")).toHaveTextContent("ไม่พบเวลาการ deploy");
    });
});
