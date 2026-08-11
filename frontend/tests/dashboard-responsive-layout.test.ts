import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const frontendRoot = resolve(import.meta.dirname, "..");
const layoutSource = readFileSync(
  resolve(frontendRoot, "src/layouts/DashboardLayout.tsx"),
  "utf8",
);
const dashboardSource = readFileSync(
  resolve(frontendRoot, "src/pages/dashboard/Dashboard.tsx"),
  "utf8",
);

describe("authenticated responsive page layout", () => {
  it("uses compact mobile page edges without adding a second Dashboard inset", () => {
    expect(layoutSource).toContain(
      'className="flex-1 overflow-x-hidden p-2 md:p-8"',
    );
    expect(dashboardSource).toContain(
      'className="flex-1 space-y-6 pb-10"',
    );
  });

  it("presents Dashboard cash metrics as divided cells in one card", () => {
    expect(dashboardSource).toContain(
      "border-b border-border/70 p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0",
    );
    expect(dashboardSource).toContain(
      'className="grid sm:grid-cols-3"',
    );
  });
});
