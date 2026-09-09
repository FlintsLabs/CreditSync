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
            'className="min-w-0 flex-1 overflow-x-hidden p-4 md:p-8"',
        );
        expect(dashboardSource).toContain(
            'className="flex-1 space-y-6 pb-10"',
        );
        expect(layoutSource).toContain('data-sidebar-state={isSidebarCollapsed ? "collapsed" : "expanded"}');
        expect(layoutSource).toContain("w-[72px]");
        expect(layoutSource).toContain('motion-reduce:transition-none');
    });

  it("presents Dashboard cash metrics as divided cells in one card", () => {
    expect(dashboardSource).toContain(
      "border-b border-border/70 p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0",
    );
    expect(dashboardSource).toContain(
      'className="grid sm:grid-cols-3"',
    );
  });

  it("uses flat divider-separated repayment queues on mobile with desktop containment", () => {
    expect(dashboardSource).toContain(
      'const QUEUE_SECTION_CLASS = "min-w-0 rounded-none border-0 bg-transparent shadow-none md:rounded-lg md:border md:bg-card md:text-card-foreground md:shadow-sm";',
    );
    expect(dashboardSource).toContain(
      'const QUEUE_HEADER_CLASS = "px-0 pb-3 pt-0 md:p-6";',
    );
    expect(dashboardSource).toContain(
      'const QUEUE_CONTENT_CLASS = "divide-y divide-border/70 p-0 md:px-6 md:pb-6";',
    );
    expect(dashboardSource).toContain(
      'const QUEUE_ROW_CLASS = "group flex min-h-16 w-full items-center justify-between gap-3 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:px-3";',
    );
    expect(dashboardSource.match(/className=\{QUEUE_SECTION_CLASS\}/g)).toHaveLength(2);
    expect(dashboardSource.match(/className=\{QUEUE_ROW_CLASS\}/g)).toHaveLength(2);
    expect(dashboardSource).not.toContain(
      'className="group flex w-full flex-col items-stretch gap-3 rounded-xl border p-3 text-left',
    );
  });

  it("uses zero-minimum mobile grid tracks so dashboard content cannot exceed the viewport", () => {
    expect(dashboardSource).toContain(
      'className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.88fr)_minmax(0,1.4fr)]"',
    );
    expect(dashboardSource).toContain(
      'className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2"',
    );
    expect(dashboardSource).toContain(
      'const QUEUE_SECTION_CLASS = "min-w-0 rounded-none',
    );
  });
});
