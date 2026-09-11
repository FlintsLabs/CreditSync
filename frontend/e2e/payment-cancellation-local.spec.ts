import { expect, test } from "@playwright/test";

const id = "019c3a5a-94ce-7f2c-8b08-f56852dca7a1";
test("explicit batch link takes precedence over another saved batch", async ({ page }) => {
    const target = "019c3a5a-94ce-7f2c-8b08-f56852dca7b1";
    const saved = "019c3a5a-94ce-7f2c-8b08-f56852dca7b2";
    const requested: string[] = [];
    await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
        requested.push(path);
        const body = path === `/payment-batches/${target}/workspace`
            ? { batchPublicId: target, batch: { publicId: target, version: 2, status: "needs_review", latestPreview: null }, items: [] }
            : path === "/payment-intakes" ? { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 } : [];
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.addInitScript(({ savedId }) => {
        localStorage.setItem("token", "synthetic-browser-only");
        localStorage.setItem("i18nextLng", "en");
        localStorage.setItem("creditsync.paymentBatch.workspace:anonymous:anonymous:batch-id", savedId);
    }, { savedId: saved });
    await page.goto(`/payments?batch=1&batchId=${target}`);
    await expect(page.getByTestId("payment-batch-editor")).toBeVisible();
    await expect.poll(() => requested.includes(`/payment-batches/${target}/workspace`)).toBe(true);
    expect(requested).not.toContain(`/payment-batches/${saved}/workspace`);
});

test("synthetic cancellation retains history and shows Bangkok time outside Thailand", async ({ page }) => {
    let cancelled = false;
    const commands: Array<Record<string, unknown>> = [];
    const detail = () => ({ publicId: id, status: cancelled ? "cancelled" : "needs_review", amount: "30.30", receivedAt: "2026-09-11T09:30:00.000Z", payerName: "Synthetic browser cancellation", warnings: [], evidence: [], latestProposal: null,
        cancellation: { allowed: !cancelled, stateHash: "a".repeat(64), blockedReason: cancelled ? "PAYMENT_CANCEL_NOT_ALLOWED" : null, batchPublicId: null },
        cancellationMetadata: cancelled ? { reason: "Synthetic duplicate entry", cancelledAt: "2026-09-11T09:45:00.000Z", actorPublicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a2", auditPublicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a3" } : null,
    });
    await page.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/^\/api/, "");
        let body: unknown;
        if (path === "/payment-intakes") body = { items: [detail()], page: 1, pageSize: 25, total: 1, totalPages: 1 };
        else if (path === `/payment-intakes/${id}`) body = detail();
        else if (path === `/payment-intakes/${id}/cancel` && request.method() === "POST") {
            commands.push(request.postDataJSON()); cancelled = true;
            body = { paymentIntakePublicId: id, status: "cancelled", reason: "Synthetic duplicate entry", cancelledAt: "2026-09-11T09:45:00.000Z", cancellationPublicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a4", auditPublicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a3", correlationId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a5" };
        } else if (request.method() === "GET") body = [];
        else throw new Error(`Unexpected mutation: ${path}`);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.addInitScript(() => {
        localStorage.setItem("token", "synthetic-browser-only");
        localStorage.setItem("i18nextLng", "en");
        localStorage.setItem("user", JSON.stringify({ id: 1, name: "Synthetic Actor", email: "actor@example.invalid", role: "owner", tenantId: "browser-cancel" }));
    });
    await page.goto("/payments");
    await page.getByRole("button", { name: /^Synthetic browser cancellation/ }).click();
    await page.getByRole("button", { name: "Cancel intake", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel payment intake" });
    await expect(dialog).toContainText("30.30");
    await expect(dialog).toContainText("4:30 PM");
    await expect(dialog.getByRole("button", { name: "Confirm cancellation" })).toBeDisabled();
    expect(commands).toHaveLength(0);
    await dialog.getByLabel("Reason").fill("Synthetic duplicate entry");
    await dialog.getByRole("button", { name: "Confirm cancellation" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(/Cancelled: Synthetic duplicate entry/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel intake", exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ reason: "Synthetic duplicate entry", expectedStateHash: "a".repeat(64) });
});
