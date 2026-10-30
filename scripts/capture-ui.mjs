import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const base = process.env.ROLLOUT_BASE_URL || "http://127.0.0.1:8098";
let password = process.env.ROLLOUT_DEMO_PASSWORD;
if (!password) {
  const content = await readFile(path.join(root, ".env"), "utf8");
  password = content.match(/^ROLLOUT_DEMO_PASSWORD=([^\r\n]+)$/m)?.[1];
}
if (!password) throw new Error("Run scripts/Init.ps1 or set ROLLOUT_DEMO_PASSWORD.");
const screenshots = path.join(root, "docs/screenshots");
await mkdir(screenshots, { recursive: true });
await mkdir(path.join(root, ".local"), { recursive: true });
const browser = await chromium.launch({
  channel: process.env.ROLLOUT_BROWSER_CHANNEL || (process.env.CI ? "chromium" : "msedge"),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const report = { layouts: [], contrast: [], pageErrors: [], responseErrors: [], keyboard: {} };
page.on("pageerror", (error) => report.pageErrors.push(error.message));
page.on("response", (response) => {
  const pathname = new URL(response.url()).pathname;
  if (response.status() >= 400 && !(response.status() === 401 && pathname === "/api/auth/session")) {
    report.responseErrors.push({ path: pathname, status: response.status() });
  }
});

async function visit(route, heading) {
  await page.goto(`${base}/#/${route}`);
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  if (route === "flags") await page.getByRole("heading", { name: "Checkout redesign", exact: true }).waitFor();
  if (route.startsWith("flags/")) await page.getByLabel("Rollout percentage", { exact: true }).waitFor();
  if (route === "audit") await page.getByText(/entries · Page/).waitFor();
}

async function inspect(name, width, enlarged = false) {
  await page.setViewportSize({ width, height: 1000 });
  const result = await page.evaluate(() => {
    const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const colors = [];
    const parse = (value) => (value.match(/[\d.]+/g) || []).map(Number);
    const luminance = (value) => parse(value).slice(0, 3).map((v) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0);
    const background = (element) => {
      for (let node = element; node; node = node.parentElement) {
        const value = getComputedStyle(node).backgroundColor;
        const channels = parse(value);
        if (channels.length === 3 || channels[3] === 1) return value;
      }
      return "rgb(255, 255, 255)";
    };
    for (const element of document.querySelectorAll("body *")) {
      if (!visible(element) || element.closest(":disabled") || ![...element.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) continue;
      const style = getComputedStyle(element);
      const bg = background(element);
      const a = luminance(style.color);
      const b = luminance(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (!Number.isFinite(ratio)) continue;
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.667 && parseInt(style.fontWeight, 10) >= 700);
      colors.push({ foreground: style.color, background: bg, ratio, minimum: large ? 3 : 4.5 });
    }
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      contrast: [...new Map(colors.map((v) => [`${v.foreground}/${v.background}/${v.minimum}`, v])).values()],
      landmarks: document.querySelectorAll("main").length,
      h1: document.querySelectorAll("h1").length,
    };
  });
  report.layouts.push({ name, width, enlarged, clientWidth: result.clientWidth, scrollWidth: result.scrollWidth, landmarks: result.landmarks, h1: result.h1 });
  report.contrast.push(...result.contrast);
  if (result.scrollWidth > result.clientWidth + 1) throw new Error(`Horizontal overflow: ${name}, ${width}`);
  if (result.landmarks !== 1 || result.h1 !== 1) throw new Error(`Page landmarks: ${name}`);
  if (result.contrast.some((v) => v.ratio < v.minimum)) throw new Error(`Text contrast: ${name}, ${width}`);
}

try {
  await page.goto(base);
  await page.getByRole("heading", { name: "Sign in to RolloutDesk", exact: true }).waitFor();
  await page.keyboard.press("Tab");
  report.keyboard.firstLoginField = await page.evaluate(() => document.activeElement.id);
  if (report.keyboard.firstLoginField !== "login-email") throw new Error("Login keyboard order");
  for (const width of [320, 390, 768, 1024, 1440]) await inspect("login", width);
  await page.screenshot({ path: path.join(screenshots, "01-login.png"), fullPage: true });
  await page.getByLabel("Email", { exact: true }).fill("operator@rolloutdesk.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Feature flags", exact: true }).waitFor();
  await visit("flags/checkout-redesign/staging", "Checkout redesign");
  await page.getByLabel("Enable flag in draft", { exact: true }).check();
  await page.getByLabel("Rollout percentage", { exact: true }).fill("37.50");
  await page.getByLabel("Allowlisted subject IDs", { exact: true }).fill("demo-alice\ndemo-customer-001");
  const save = page.getByRole("button", { name: "Save draft", exact: true });
  if (await save.isEnabled()) {
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/draft"));
    await save.click();
    if ((await saved).status() !== 200) throw new Error("Capture draft save failed");
    await save.waitFor({ state: "visible" });
  }
  await page.getByLabel("Publication note", { exact: true }).fill("Synthetic portfolio walkthrough: release a stable 37.50 percent cohort.");
  const publish = page.getByRole("button", { name: "Publish saved draft", exact: true });
  if (await publish.isEnabled()) {
    const published = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/publish"));
    await publish.click();
    if ((await published).status() !== 200) throw new Error("Capture publication failed");
  }
  const routes = [
    ["flags", "Feature flags", "registry"],
    ["flags/checkout-redesign/staging", "Checkout redesign", "detail"],
    ["playground", "Evaluation playground", "playground"],
    ["audit", "Audit history", "audit"],
  ];
  for (const [route, heading, name] of routes) {
    await visit(route, heading);
    for (const width of [320, 390, 768, 1024, 1440]) await inspect(name, width);
    if (name === "registry") await page.screenshot({ path: path.join(screenshots, "02-flags.png"), fullPage: true });
    if (name === "detail") {
      await page.screenshot({ path: path.join(screenshots, "03-flag-detail.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(screenshots, "04-mobile.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await inspect(name, 1440, true);
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
  }
  await visit("flags", "Feature flags");
  await page.keyboard.press("Tab");
  report.keyboard.firstAppControl = await page.evaluate(() => document.activeElement.textContent.trim());
  report.contrast = [...new Map(report.contrast.map((v) => [`${v.foreground}/${v.background}/${v.minimum}`, v])).values()];
  if (report.pageErrors.length || report.responseErrors.length) throw new Error("Unexpected browser/API errors during capture");
  report.result = "PASS";
  console.log(`Captured four real application screens; ${report.layouts.length} layout checks passed.`);
} finally {
  await writeFile(path.join(root, ".local/ui-checks.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
