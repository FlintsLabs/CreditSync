import { expect, test } from "@playwright/test";

const loanId = "019c3a5a-94ce-7f2c-8b08-f56852dca7a1";
const borrowerId = "019c3a5a-94ce-7f2c-8b08-f56852dca7a2";
test.use({ timezoneId: "America/Los_Angeles" });

test("selected accrual review recovers an expired preview and a lost post across access and refresh failures", async ({ page }) => {
    const previewCommands: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const postCommands: Array<{ body: Record<string, unknown>; key: string }> = [];
    let postCount = 0;
    const postKeys: string[] = [];
    let expireFirstPost = false;
    let failOneRefresh = false;
    let loanLoads = 0;
    const loan = {
        id: "loan-row", publicId: loanId, borrowerPublicId: borrowerId, principalAmount: "4000.00", interestRate: "0.0000", repaymentType: "floating", termMonths: null,
        installmentAmount: null, totalInstallments: null, startDate: "2026-09-30", nextDueDate: null, outstandingPrincipal: "4000.00", outstandingInterest: "80.00", outstandingFees: "0.00", status: "active", floatingAccrualCycle: "daily", interestPeriodUnit: "day", floatingInterestPolicy: { periodUnit: "day", periodLength: 1, rateMode: "percent", rate: "2.0000", advanceInterestPeriods: 0, advanceInterestRefundPolicy: "non_refundable" },
        accruals: [{ publicId: "accrual-row", accrualDate: "2026-10-06", periodStartDate: "2026-10-06", periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "0.00", remainingAmount: "80.00", status: "accrued", receiptHistory: [] }],
    };
    await page.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/^\/api/, "");
        let body: unknown;
        let status = 200;
        if (path === `/loans/${loanId}`) {
            loanLoads++;
            if (failOneRefresh) { failOneRefresh = false; status = 503; body = { error: "Synthetic refresh unavailable" }; }
            else body = loan;
        } else if (path === `/loans/${loanId}/funding-allocations`) body = [];
        else if (path === `/loans/${loanId}/interest-rates`) body = { loanPublicId: loanId, asOfDate: "2026-10-07", currentPeriod: { publicId: "rate-period", effectiveDate: "2026-09-30", expiryDate: null, rateType: "percent", rate: "2.0000" }, dailyInterestAtCurrentPrincipal: "80.00", nextChange: null, earliestEditableDate: "2026-10-08", timeline: [{ publicId: "rate-period", effectiveDate: "2026-09-30", expiryDate: null, rateType: "percent", rate: "2.0000" }] };
        else if (path === `/loans/${loanId}/allocation-state`) body = {};
        else if (path === `/loans/${loanId}/profitability`) body = { borrowerRevenueCollected: "0.00", fundCostPaid: "0.00", realizedSpread: "0.00", unrealizedSpread: "0.00", fundedPrincipal: "4000.00", unallocatedPrincipalGap: "0.00", estimatedOutstandingFundingCost: "0.00", fundingShare: 1 };
        else if (path === `/borrowers/${borrowerId}`) body = { id: "borrower-row", publicId: borrowerId, name: "Synthetic Accrual Borrower" };
        else if (path === `/loans/${loanId}/accrual-payments/preview` && request.method() === "POST") {
            previewCommands.push({ body: request.postDataJSON(), headers: request.headers() });
            body = { id: "preview-row", publicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a3", paymentIntakePublicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a4", status: "ready", receivedAt: "2026-10-07T08:45:00.000Z", targets: [{ accrualDate: "2026-10-06", amount: "80.00" }], totalAllocated: "80.00", warnings: [], remainingDebt: { principal: "4000.00", fees: "0.00", interest: "80.00", penalty: "0.00" } };
        } else if (path === `/loans/${loanId}/accrual-payments/post` && request.method() === "POST") {
            postCount++;
            postKeys.push(request.headers()["idempotency-key"] ?? "");
            postCommands.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] ?? "" });
            if (postCount === 1 && expireFirstPost) { status = 409; body = { code: "STALE_PAYMENT_PROPOSAL", error: "Synthetic expired proposal" }; }
            else if (postCount === 2) { await route.abort("connectionreset"); return; }
            else if (postCount === 3) { status = 401; body = { code: "UNAUTHORIZED", error: "Synthetic auth detail" }; }
            else { failOneRefresh = true; body = { publicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a4", receiptPublicId: "receipt-transaction", auditPublicId: "receipt-audit", correlationId: "receipt-correlation", status: "posted" }; }
        }
        else if (request.method() === "GET") body = [];
        else { status = 404; body = { error: `Unexpected synthetic endpoint ${path}` }; }
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.addInitScript(() => {
        localStorage.setItem("token", "synthetic-browser-only");
        localStorage.setItem("i18nextLng", "en");
        localStorage.setItem("user", JSON.stringify({ id: 1, name: "Synthetic owner", email: "owner@example.invalid", role: "owner", tenantId: "browser-accrual" }));
    });
    await page.clock.install({ time: new Date("2026-10-07T08:45:00.000Z") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/loans/${loanId}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("tab", { name: "Accrual Table" })).toBeVisible();
    await page.getByRole("tab", { name: "Accrual Table" }).click({ force: true });
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByRole("button", { name: "Pay" }).click();
    const dialog = page.getByRole("dialog", { name: "Pay selected daily interest" });
    await expect(dialog).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByLabel("Actual received time (Bangkok)").fill("2026-10-07T15:45");
    await dialog.getByRole("button", { name: "Preview" }).click();
    await expect(dialog.getByRole("button", { name: "Confirm payment" })).toBeVisible();
    expect(previewCommands).toHaveLength(1);
    expect(previewCommands[0]!.body).toMatchObject({ amount: "80.00", receivedAt: "2026-10-07T08:45:00.000Z", targets: [{ accrualDate: "2026-10-06", amount: "80.00" }] });
    expect(previewCommands[0]!.headers["idempotency-key"]).toBeTruthy();
    const previewClientTime = await page.evaluate(() => Date.now());
    await page.clock.fastForward(900_001);
    expect(await page.evaluate((startedAt) => Date.now() - startedAt, previewClientTime)).toBeGreaterThanOrEqual(900_000);
    expireFirstPost = true;
    await dialog.getByRole("button", { name: "Confirm payment" }).click();
    await expect(dialog.getByRole("alert")).toContainText("This preview is stale");
    await dialog.getByRole("button", { name: "Preview" }).click();
    await expect(dialog.getByRole("button", { name: "Confirm payment" })).toBeVisible();
    expect(previewCommands).toHaveLength(2);
    expect(previewCommands[1]!.body).toMatchObject({ paymentIntakePublicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a4", targets: [{ accrualDate: "2026-10-06", amount: "80.00" }] });
    expect(previewCommands[1]!.headers["idempotency-key"]).not.toBe(previewCommands[0]!.headers["idempotency-key"]);
    await dialog.getByRole("button", { name: "Confirm payment" }).click();
    await expect(dialog.getByRole("button", { name: "Retry payment" })).toBeVisible();
    expect(postCommands[0]!.body).toEqual(postCommands[1]!.body);
    expect(postCommands[0]!.key).not.toBe(postCommands[1]!.key);
    await dialog.getByRole("button", { name: "Retry payment" }).click();
    await expect(dialog).toContainText("Access could not be verified. This saved payment may already be posted; restore access and retry this same payment.");
    await dialog.getByRole("button", { name: "Retry payment" }).click();
    await expect(dialog).toContainText("Payment posted. The receipt remains saved for safe recovery.");
    await expect(dialog.getByRole("button", { name: "Refresh loan history" })).toBeVisible();
    expect(postCount).toBe(4);
    expect(postKeys[1]).not.toBe(postKeys[0]);
    expect(postKeys.slice(1)).toEqual([postKeys[1], postKeys[1], postKeys[1]]);
    await dialog.getByRole("button", { name: "Refresh loan history" }).click();
    await expect(dialog).not.toBeVisible();
    expect(loanLoads).toBeGreaterThanOrEqual(3);
    await page.addInitScript(() => localStorage.setItem("i18nextLng", "th"));
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "ตาราง Accrue" }).click({ force: true });
    await page.getByRole("button", { name: "รับชำระ" }).click();
    const thaiDialog = page.getByRole("dialog", { name: "รับชำระดอกเบี้ยรายวันที่เลือก" });
    await expect(thaiDialog).toBeVisible();
    await expect.poll(async () => {
        const bounds = await thaiDialog.boundingBox();
        return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
    }).toBe(true);
});
