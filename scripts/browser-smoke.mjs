import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { createApp } from "../server.js";
import { buildPreview } from "./build-preview.mjs";

// Uses an installed browser; no real inbox or AI credential is needed.
const server = createApp({ apiKey: "" });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH === "auto"
        ? chromium.executablePath()
        : process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mkdir("test-results", { recursive: true });
  await page.goto(base);
  await page.getByText("Offline demo", { exact: true }).waitFor();
  assert.equal(await page.locator(".sample-card").count(), 3);
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Analyze email" }).click();
  await page.locator("#analysis-result").waitFor();
  assert.match(
    await page.locator("#summary-text").innerText(),
    /spring launch plan/,
  );
  assert.match(await page.locator("#deadline").innerText(), /Friday/);
  assert.match(await page.locator("#reply-body").inputValue(), /Hi Jamie/);
  await page.locator("#reply-tone").selectOption("friendly");
  await page.getByRole("button", { name: "Regenerate" }).click();
  await page.waitForFunction(() =>
    document.getElementById("reply-body").value.includes("Thanks so much"),
  );
  await page.getByRole("button", { name: "Copy reply" }).click();
  await page.getByRole("status").filter({ hasText: "Reply copied" }).waitFor();
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /Hi Jamie/,
  );
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download reply" }).click();
  const download = await downloaded;
  assert.match(
    await readFile(await download.path(), "utf8"),
    /Subject: Re: A fresh look/,
  );
  assert.match(await readFile(await download.path(), "utf8"), /Thanks so much/);
  await page.screenshot({
    path: "test-results/desktop-result.png",
    fullPage: true,
  });

  await page.locator("#reply-body").fill("My carefully edited reply.");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator(".sample-card").nth(1).click();
  assert.equal(
    await page.locator("#reply-body").inputValue(),
    "My carefully edited reply.",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".sample-card").nth(1).click();
  assert.equal(await page.locator("#analysis-result").isVisible(), false);
  await page.getByRole("button", { name: "Analyze email" }).click();
  await page.locator("#analysis-result").waitFor();
  assert.equal(await page.locator("#category-tag").innerText(), "Meeting");

  await page.getByRole("tab", { name: "Paste your own" }).click();
  await page.getByRole("button", { name: "Analyze email" }).click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.locator("#error-text").innerText(), /Paste an email/);
  await page.locator("#email-from").fill("Taylor <taylor@example.com>");
  await page.locator("#email-subject").fill("Urgent invoice");
  await page
    .locator("#email-body")
    .fill(
      'Please review the invoice by tomorrow. <img src=x onerror="window.xss=true">',
    );
  await page.getByRole("button", { name: "Analyze email" }).click();
  await page.locator("#analysis-result").waitFor();
  assert.equal(await page.locator("#category-tag").innerText(), "Finance");
  assert.equal(
    await page.locator("#priority-tag").innerText(),
    "High priority",
  );
  assert.match(await page.locator("#reply-body").inputValue(), /Hi Taylor/);
  assert.equal(await page.evaluate(() => window.xss), undefined);
  assert.equal(await page.locator("#summary-text img").count(), 0);
  await page.locator("#email-body").fill("A changed message.");
  assert.equal(await page.locator("#regenerate-button").isDisabled(), true);

  await page.getByRole("button", { name: "How it works" }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").isVisible(), false);

  const mobile = await context.newPage({
    viewport: { width: 390, height: 844 },
  });
  // Page viewport is set explicitly because a page inherits its context viewport.
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(base);
  await mobile.getByRole("button", { name: "Analyze email" }).click();
  await mobile.locator("#analysis-result").waitFor();
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await mobile.screenshot({ path: "test-results/mobile.png", fullPage: true });

  const accessibility = await new AxeBuilder({ page: mobile })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    accessibility.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target),
    })),
    [],
  );

  // Simulate a configured provider that rejects the request, then exercise the explicit demo fallback.
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: { status: "ok", mode: "live", model: "test-model" },
    }),
  );
  await page.route("**/api/analyze", async (route) => {
    if (route.request().postDataJSON().mode === "demo") return route.continue();
    return route.fulfill({
      status: 502,
      json: { error: "The AI key was rejected. Check server settings." },
    });
  });
  await page.reload();
  await page.getByText("Live AI configured", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Analyze email" }).click();
  await page.getByRole("button", { name: "Try offline demo instead" }).click();
  await page.locator("#analysis-result").waitFor();
  assert.equal(
    await page.locator("#result-mode").innerText(),
    "DEMO SUGGESTION",
  );
  assert.deepEqual(errors, []);

  // Test the Gmail UI using simulated API responses; no real account is accessed.
  const gmailPage = await context.newPage();
  let gmailConnected = true;
  await gmailPage.route("**/api/gmail/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/gmail/status")
      return route.fulfill({
        json: {
          configured: true,
          connected: gmailConnected,
          email: gmailConnected ? "owner@example.com" : null,
        },
      });
    if (url.pathname === "/api/gmail/disconnect") {
      gmailConnected = false;
      return route.fulfill({ json: { connected: false } });
    }
    if (url.pathname === "/api/gmail/messages")
      return route.fulfill({
        json: {
          messages: [
            {
              id: "test123",
              from: "Taylor <taylor@example.com>",
              subject: "Please review our project",
            },
          ],
        },
      });
    return route.fulfill({
      json: {
        id: "test123",
        from: "Taylor <taylor@example.com>",
        subject: "Please review our project",
        body: "Please review the project by Monday.",
        truncated: false,
        unsupported: false,
      },
    });
  });
  await gmailPage.goto(base);
  await gmailPage.getByText(/Connected as owner@example.com/).waitFor();
  await gmailPage.getByRole("tab", { name: "My Gmail" }).click();
  await gmailPage
    .getByRole("button", { name: /Please review our project/ })
    .click();
  await gmailPage
    .getByText("Email loaded. Click Analyze when you’re ready.")
    .waitFor();
  await gmailPage.getByRole("button", { name: "Analyze email" }).click();
  await gmailPage.locator("#analysis-result").waitFor();
  assert.match(
    await gmailPage.locator("#reply-body").inputValue(),
    /Hi Taylor/,
  );
  assert.match(await gmailPage.locator("#deadline").innerText(), /Monday/);
  await gmailPage
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await gmailPage
    .getByRole("button", { name: "Connect Gmail", exact: true })
    .waitFor();
  assert.equal(await gmailPage.locator("#gmail-preview-body").innerText(), "");
  assert.equal(await gmailPage.locator("#reply-body").inputValue(), "");
  assert.equal(await gmailPage.locator("#analysis-result").isVisible(), false);
  await gmailPage.close();

  // Render the complete downloadable HTML with the network disabled.
  // The cloud browser's administrator policy blocks navigation to file:// URLs.
  const previewFile = await buildPreview();
  const offlineContext = await browser.newContext({
    viewport: { width: 1360, height: 1000 },
    offline: true,
  });
  const offlinePage = await offlineContext.newPage();
  const externalRequests = [];
  offlinePage.on("pageerror", (error) => errors.push(error.message));
  offlinePage.on("request", (request) => {
    if (/^https?:/.test(request.url())) externalRequests.push(request.url());
  });
  await offlinePage.setContent(await readFile(previewFile, "utf8"));
  await offlinePage
    .getByText("Standalone offline demo", { exact: true })
    .waitFor();
  await offlinePage.getByRole("button", { name: "Analyze email" }).click();
  await offlinePage.locator("#analysis-result").waitFor();
  assert.match(
    await offlinePage.locator("#reply-body").inputValue(),
    /Hi Jamie/,
  );
  await offlinePage.screenshot({
    path: "test-results/standalone-demo.png",
    fullPage: true,
  });
  await offlinePage.getByRole("tab", { name: "Paste your own" }).click();
  await offlinePage
    .locator("#email-body")
    .fill("Please confirm the meeting by Monday.");
  await offlinePage.getByRole("button", { name: "Analyze email" }).click();
  await offlinePage.locator("#analysis-result").waitFor();
  assert.match(await offlinePage.locator("#deadline").innerText(), /by Monday/);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  await offlineContext.close();
  console.log(
    "Browser checks passed: sample analysis, tone, clipboard, download, draft protection, pasted email, validation, safe rendering, help, mobile layout, accessibility, provider-error fallback, simulated Gmail import/disconnect, and standalone HTML contents rendered offline without network requests.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
