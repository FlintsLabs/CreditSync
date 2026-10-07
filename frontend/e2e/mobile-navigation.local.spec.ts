import { expect, test } from "@playwright/test";

async function setLocalSession(page: import("@playwright/test").Page, role: string, language: "en" | "th") {
    await page.addInitScript(({ userRole, userLanguage }) => {
        localStorage.setItem("token", "synthetic-mobile-navigation-session");
        localStorage.setItem("user", JSON.stringify({ id: 7, name: "Synthetic Operator", email: "operator@example.invalid", role: userRole }));
        localStorage.setItem("i18nextLng", userLanguage);
    }, { userRole: role, userLanguage: language });
    await page.route("**/api/**", (route) => route.abort());
}

async function footerTextOverlapsAssistant(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
        const footer = document.querySelector<HTMLElement>("[data-testid='application-footer']")!;
        const aiButton = document.querySelector<HTMLElement>("[data-testid='ai-assistant-root'] button")!;
        const ai = aiButton.getBoundingClientRect();
        return [...footer.querySelectorAll<HTMLElement>("a, span")]
            .filter((element) => element.textContent?.trim())
            .filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.left < ai.right && rect.right > ai.left && rect.top < ai.bottom && rect.bottom > ai.top;
            })
            .map((element) => element.textContent?.trim());
    });
}

test("responsive navigation keeps role access, focus, and safe-area clearance", async ({ page }, testInfo) => {
    const screenshotPath = (name: string) => testInfo.outputPath(name);
    await setLocalSession(page, "owner", "en");
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/settings");
    await expect(page.getByRole("navigation", { name: "Sidebar navigation" })).toBeVisible();
    await expect(page.getByTestId("mobile-primary-navigation")).toBeHidden();
    await page.screenshot({ path: screenshotPath("desktop-1280-en.png") });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(100);
    expect(await footerTextOverlapsAssistant(page)).toEqual([]);
    await page.screenshot({ path: screenshotPath("desktop-1280-en-footer-bottom.png") });
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.setViewportSize({ width: 320, height: 720 });
    await page.addStyleTag({ content: ":root { --safe-area-bottom: 24px !important; }" });
    await page.getByRole("button", { name: "Open AI Assistant" }).click();
    const chatCard = page.getByTestId("ai-assistant-root").locator(":scope > div");
    const chatBounds = await chatCard.boundingBox();
    await page.screenshot({ path: screenshotPath("mobile-320-en-ai-chat.png") });
    expect(chatBounds).not.toBeNull();
    expect(chatBounds!.x).toBeGreaterThanOrEqual(8);
    expect(chatBounds!.x + chatBounds!.width).toBeLessThanOrEqual(312);
    for (const height of [640, 568]) {
        await page.setViewportSize({ width: 320, height });
        const viewportState = await page.evaluate(() => {
            const card = document.querySelector<HTMLElement>("[data-testid='ai-assistant-root'] > div")!;
            const closeButton = card.querySelector<HTMLElement>("button[aria-label='Close AI Assistant']")!;
            const messageArea = card.querySelector<HTMLElement>(".overflow-y-auto")!;
            const input = card.querySelector<HTMLInputElement>("input[aria-label='Message']")!;
            const bounds = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                return { top: rect.top, bottom: rect.bottom };
            };
            return {
                card: bounds(card),
                close: bounds(closeButton),
                messages: { ...bounds(messageArea), overflowY: getComputedStyle(messageArea).overflowY },
                input: { ...bounds(input), disabled: input.disabled },
                transitionProperty: getComputedStyle(card).transitionProperty,
                transitionDuration: getComputedStyle(card).transitionDuration,
                animationName: getComputedStyle(card).animationName,
                viewportHeight: window.innerHeight,
            };
        });
        expect(viewportState.card.top).toBeGreaterThanOrEqual(8);
        expect(viewportState.close.top).toBeGreaterThanOrEqual(0);
        expect(viewportState.input.bottom).toBeLessThanOrEqual(height);
        expect(viewportState.input.disabled).toBe(false);
        expect(viewportState.messages.overflowY).toBe("auto");
        expect(viewportState.transitionProperty).toBe("none");
        expect(viewportState.transitionDuration).toBe("0s");
        expect(viewportState.animationName).toBe("none");
        if (height === 568) {
            await page.screenshot({ path: screenshotPath("mobile-320x568-en-ai-chat.png") });
        } else {
            await page.screenshot({ path: screenshotPath("mobile-320x640-en-ai-chat.png") });
        }
    }
    await page.getByTestId("ai-assistant-root").getByRole("textbox", { name: "Message" }).fill("Mobile layout check");
    await expect(page.getByTestId("ai-assistant-root").getByRole("textbox", { name: "Message" })).toHaveValue("Mobile layout check");
    await page.setViewportSize({ width: 320, height: 720 });
    await page.getByTestId("ai-assistant-root").getByRole("button", { name: "Close AI Assistant" }).last().click();

    for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: width === 768 ? 1024 : 844 });
        await page.addStyleTag({ content: ":root { --safe-area-bottom: 24px !important; }" });
        const mobileNav = page.getByTestId("mobile-primary-navigation");

        if (width < 768) {
            await expect(mobileNav).toBeVisible();
            await expect(page.getByRole("navigation", { name: "Sidebar navigation" })).toBeHidden();
            const bounds = await page.evaluate(() => {
                const nav = document.querySelector<HTMLElement>("[data-testid='mobile-primary-navigation']")!;
                const main = document.querySelector<HTMLElement>("main")!;
                const footer = document.querySelector<HTMLElement>("[data-testid='application-footer']")!;
                const assistant = document.querySelector<HTMLElement>("[data-testid='ai-assistant-root']")!;
                return {
                    navBottom: nav.getBoundingClientRect().bottom,
                    viewportBottom: window.innerHeight,
                    navPadding: getComputedStyle(nav).paddingBottom,
                    mainPadding: getComputedStyle(main).paddingBottom,
                    footerPadding: getComputedStyle(footer).paddingBottom,
                    assistantBottom: getComputedStyle(assistant).bottom,
                    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
                    labelOverflow: [...nav.querySelectorAll("span")].some((label) => label.scrollWidth > label.clientWidth),
                    sarabunLoaded: document.documentElement.lang === "th"
                        ? document.fonts.check('12px Sarabun', "ชำระเงิน")
                        : true,
                };
            });
            expect(bounds.navBottom).toBe(bounds.viewportBottom);
            expect(bounds.navPadding).toBe("32px");
            expect(bounds.mainPadding).toBe("120px");
            expect(bounds.footerPadding).toBe("120px");
            expect(bounds.assistantBottom).toBe("120px");
            expect(bounds.horizontalOverflow).toBe(false);
            expect(bounds.labelOverflow).toBe(false);
            expect(bounds.sarabunLoaded).toBe(true);
            if (width === 390) {
                await page.screenshot({ path: screenshotPath("mobile-390-en.png"), fullPage: true });
            }
        } else {
            await expect(mobileNav).toBeHidden();
            await expect(page.getByRole("navigation", { name: "Sidebar navigation" })).toBeVisible();
        }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/loans/demo-route");
    await expect(page.getByTestId("mobile-primary-navigation").getByRole("link", { name: "Loans" })).toHaveAttribute("aria-current", "page");
    const loanLink = page.getByTestId("mobile-primary-navigation").getByRole("link", { name: "Loans" });
    await loanLink.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("mobile-primary-navigation").getByRole("link", { name: "Transactions" })).toBeFocused();
    expect(await page.getByTestId("mobile-primary-navigation").getByRole("link", { name: "Transactions" }).evaluate((node) => node.matches(":focus-visible"))).toBe(true);

    await page.addStyleTag({ content: ":root { --safe-area-bottom: 24px !important; }" });
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByTestId("mobile-sidebar");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("navigation", { name: "Drawer navigation" }).getByRole("link", { name: "Matching" })).toBeVisible();
    expect(await drawer.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
    const drawerAccountTrigger = drawer.getByTestId("sidebar-account-footer").getByRole("button", { name: "Open account menu for Synthetic Operator" });
    const accountTriggerBounds = await drawerAccountTrigger.boundingBox();
    expect(accountTriggerBounds).not.toBeNull();
    expect(accountTriggerBounds!.y + accountTriggerBounds!.height).toBeLessThanOrEqual(844 - 24);
    expect(await drawerAccountTrigger.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit !== null && node.contains(hit);
    })).toBe(true);
    await drawerAccountTrigger.click();
    const accountMenu = page.getByRole("menu");
    await expect(accountMenu).toBeVisible();
    expect(Number(await accountMenu.evaluate((node) => getComputedStyle(node).zIndex))).toBeGreaterThan(
        Number(await page.getByTestId("ai-assistant-root").evaluate((node) => getComputedStyle(node).zIndex)),
    );
    await page.screenshot({ path: screenshotPath("mobile-390-en-drawer-account-menu-reduced-motion.png"), fullPage: true });

    const collectorPage = await page.context().newPage();
    await setLocalSession(collectorPage, "collector", "th");
    await collectorPage.setViewportSize({ width: 320, height: 720 });
    await collectorPage.goto("/loans/demo-route");
    await collectorPage.addStyleTag({ content: ":root { --safe-area-bottom: 24px !important; }" });
    const collectorNav = collectorPage.getByTestId("mobile-primary-navigation");
    await expect(collectorNav.getByRole("link", { name: "ตั้งค่า" })).toBeVisible();
    await expect(collectorNav.getByRole("link", { name: "สัญญาเงินกู้" })).toHaveAttribute("aria-current", "page");
    await expect(collectorNav.getByRole("link", { name: "จับคู่เงินทุน" })).toHaveCount(0);
    const thaiLabelsFit = await collectorNav.locator("span").evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth));
    expect(thaiLabelsFit).toBe(true);
    await collectorPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await collectorPage.waitForTimeout(100);
    expect(await footerTextOverlapsAssistant(collectorPage)).toEqual([]);
    await collectorPage.screenshot({ path: screenshotPath("mobile-320-th-collector-footer-bottom.png") });
    await collectorPage.screenshot({ path: screenshotPath("mobile-320-th-collector.png"), fullPage: true });
});
