import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

const ids = {
    batch: "019ff2b2-15e2-7df7-a594-eb836ff388f0",
    staging: "019ff2b2-15e2-7df7-a594-eb836ff388f1",
    batchItem: "019ff2b2-15e2-7df7-a594-eb836ff388f2",
    borrower: "019ff2b2-15e2-7df7-a594-eb836ff388f3",
    loan: "019ff2b2-15e2-7df7-a594-eb836ff388f4",
    preview: "019ff2b2-15e2-7df7-a594-eb836ff388f5",
    audit: "019ff2b2-15e2-7df7-a594-eb836ff388f6",
    correlation: "019ff2b2-15e2-7df7-a594-eb836ff388f7",
};

function base64Url(value: string) {
    return Buffer.from(value).toString("base64url");
}

function localTestJwt() {
    const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64Url(JSON.stringify({ sub: "browser-actor", tenantId: "browser-tenant", role: "owner", exp: 4_000_000_000 }));
    const unsigned = `${header}.${payload}`;
    const signature = createHmac("sha256", "browser-local-test-secret").update(unsigned).digest("base64url");
    return `${unsigned}.${signature}`;
}

function response(body: unknown) {
    return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

test("synthetic local tenant: upload, mocked OCR review, chronology preview, confirmation, receipt", async ({ page }) => {
    // OCR is intentionally mocked here; backend OCR/runtime accuracy is covered separately.
    let reviewed = false;
    let extracted = false;
    let executed = false;
    let revision = 1;
    let clientItemKey = "synthetic-item";

    await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname.replace(/^\/api/, "");
        if (request.method() === "POST" && path === "/payment-batches/stage") {
            const body = request.postDataJSON() as { items?: Array<{ clientItemKey: string }> };
            clientItemKey = body.items?.[0]?.clientItemKey ?? clientItemKey;
            return route.fulfill(response({ batchPublicId: ids.batch, items: [{ publicId: ids.staging, clientItemKey }] }));
        }
        if (request.method() === "POST" && path.endsWith("/evidence/prepare")) {
            return route.fulfill(response({ evidencePublicId: "019ff2b2-15e2-7df7-a594-eb836ff388f8", status: "ready" }));
        }
        if (request.method() === "POST" && path.endsWith("/review")) {
            reviewed = true;
            revision += 1;
            return route.fulfill(response({ paymentIntakePublicId: "019ff2b2-15e2-7df7-a594-eb836ff388f9", revision }));
        }
        if (request.method() === "POST" && path.endsWith("/edit")) {
            revision += 1;
            return route.fulfill(response({ revision }));
        }
        if (request.method() === "POST" && path.endsWith("/extract")) {
            extracted = true;
            return route.fulfill(response({ stagingRevision: revision, proposal: { status: "needs_human_review", reviewRequired: true, amount: "120.00", transferredAt: "2026-09-09T04:00:00.000Z", payerName: "Synthetic Payer", receiverName: "Synthetic Operator", fee: "0.00", evidenceSha256: "a".repeat(64) } }));
        }
        if (request.method() === "GET" && path.endsWith("/candidates")) {
            return route.fulfill(response({ stagingItemPublicId: ids.staging, stagingRevision: revision, batchRevision: revision, inputFingerprint: "synthetic-fingerprint", borrowerResolution: "candidate", borrowerCandidates: [{ publicId: ids.borrower, name: "Synthetic Borrower", matchType: "canonical" }], contractCandidates: [{ borrowerPublicId: ids.borrower, borrowerName: "Synthetic Borrower", loanPublicId: ids.loan, repaymentType: "floating", status: "active", eligible: true, eligibilityCode: null, startDate: "2026-09-01", principalAmount: "10000.00", outstandingPrincipal: "10000.00", dueComponents: { principal: "0.00", interest: "120.00", fee: "0.00", penalty: "0.00" }, proposalComponents: { principal: "0.00", interest: "120.00", fee: "0.00", penalty: "0.00" }, schedules: [] }], candidateLimitReached: false, reviewRequired: true }));
        }
        if (request.method() === "POST" && path === `/payment-batches/${ids.batch}/preview`) {
            return route.fulfill(response({ publicId: ids.preview, status: "ready", version: revision, previewHash: "preview-hash", confirmationHash: "confirmation-hash", evidenceReady: true, allocations: [{ itemPublicId: ids.batchItem, borrowerPublicId: ids.borrower, loanPublicId: ids.loan, amount: "120.00", targetDueDate: "2026-09-09", intent: "on_time", calculatedComponents: { principal: "0.00", interest: "120.00", fee: "0.00", penalty: "0.00" } }], candidates: [], warnings: [] }));
        }
        if (request.method() === "POST" && path === `/payment-batches/${ids.batch}/execute`) {
            executed = true;
            return route.fulfill(response({ receipt: { receiptPublicId: "019ff2b2-15e2-7df7-a594-eb836ff388fa", auditPublicId: ids.audit, correlationId: ids.correlation } }));
        }
        if (request.method() === "GET" && path === `/payment-batches/${ids.batch}/workspace`) {
            return route.fulfill(response({ batchPublicId: ids.batch, batch: { publicId: ids.batch, version: revision, status: executed ? "posted" : "draft", borrowerPublicId: reviewed ? ids.borrower : null, latestPreview: null }, items: [{ publicId: ids.staging, clientItemKey, revision, paymentIntakePublicId: reviewed ? "019ff2b2-15e2-7df7-a594-eb836ff388f9" : null, batchItemPublicId: reviewed ? ids.batchItem : null, amount: reviewed ? "120.00" : null, receivedAt: reviewed ? "2026-09-09T04:00:00.000Z" : null, payerName: "Synthetic Payer", evidenceStatus: "ready", intent: "on_time" }] }));
        }
        return route.fulfill(response({}));
    });

    await page.addInitScript(({ token }) => {
        localStorage.setItem("token", token);
        localStorage.setItem("user", JSON.stringify({ id: 1, name: "Synthetic Actor", email: "actor@example.test", role: "owner", tenantId: "browser-tenant" }));
    }, { token: localTestJwt() });

    await page.goto("/payments?batch=1");
    await expect(page.getByTestId("payment-batch-editor")).toBeVisible();
    const row = page.getByTestId("payment-batch-row");
    await page.locator('input[type="file"]').setInputFiles({ name: "synthetic-slip.png", mimeType: "image/png", buffer: Buffer.from("synthetic-slip") });
    await row.getByLabel("Amount").fill("120.00");
    await row.getByLabel("Transfer date and time").fill("2026-09-09T11:00");
    await row.getByLabel("Target due date").fill("2026-09-09");
    await page.getByRole("button", { name: "Upload and review" }).click();
    await expect(page.getByRole("button", { name: "Extract review candidates" })).toBeVisible();
    await page.screenshot({ path: "../.codex-task-logs/browser-qa/01-upload-review.png", fullPage: true });

    await page.getByRole("button", { name: "Extract review candidates" }).click();
    await expect(page.getByText("OCR candidates only; confirm every field before review")).toBeVisible();
    await page.getByRole("button", { name: "Use candidate for review" }).click();
    await page.getByRole("button", { name: /All slips uploaded and reviewed/ }).click();
    await expect(page.getByText("Human review required; no automatic posting")).toBeVisible();
    await page.screenshot({ path: "../.codex-task-logs/browser-qa/02-ocr-manual-review.png", fullPage: true });

    await row.locator("select").first().selectOption(ids.borrower);
    await row.getByRole("button", { name: "Add contract allocation" }).click();
    await row.getByLabel("Contract candidate").selectOption(ids.loan);
    await row.getByLabel("Allocation amount").fill("120.00");
    page.once("dialog", (dialog) => dialog.accept("Synthetic browser QA review"));
    await row.getByRole("button", { name: "paymentBatch.editReviewed" }).click();
    await page.getByRole("button", { name: "Preview complete batch" }).click();
    await expect(page.getByTestId("payment-batch-preview")).toContainText("Preview ready");
    await page.screenshot({ path: "../.codex-task-logs/browser-qa/03-chronology-preview.png", fullPage: true });

    await page.getByRole("checkbox", { name: /confirm this exact execution/i }).check();
    await page.getByRole("button", { name: "Execute batch" }).click();
    await expect(page.getByTestId("payment-batch-receipt")).toContainText(ids.audit);
    await expect(page.getByTestId("payment-batch-receipt")).toContainText(ids.correlation);
    await page.screenshot({ path: "../.codex-task-logs/browser-qa/04-receipt.png", fullPage: true });
    expect(extracted).toBe(true);
    expect(executed).toBe(true);
});
