import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
const base = process.env.ROLLOUT_BASE_URL || "http://127.0.0.1:8098";
let password = process.env.ROLLOUT_DEMO_PASSWORD;
if (!password) {
  const content = await readFile(path.join(root, ".env"), "utf8");
  password = content.match(/^ROLLOUT_DEMO_PASSWORD=([^\r\n]+)$/m)?.[1];
}
if (!password)
  throw new Error("Run scripts/Init.ps1 or set ROLLOUT_DEMO_PASSWORD.");
const screenshots = path.join(root, "docs/screenshots");
await mkdir(screenshots, { recursive: true });
await mkdir(path.join(root, ".local"), { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.ROLLOUT_BROWSER_CHANNEL ||
    (process.env.CI ? "chromium" : "msedge"),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const report = {
  layouts: [],
  contrast: [],
  pageErrors: [],
  consoleErrors: [],
  policyViolations: [],
  responseErrors: [],
  keyboard: {},
  expectedTransportFaults: [],
};
let expectingSessionFault = true;
page.on("pageerror", (error) => report.pageErrors.push(error.message));
page.on("console", (message) => {
  if (
    message.type() === "error" &&
    expectingSessionFault &&
    /net::ERR_FAILED/.test(message.text())
  ) {
    report.expectedTransportFaults.push(
      "Initial session request aborted for retry-state verification",
    );
    return;
  }
  if (
    message.type() === "error" &&
    !/Failed to load resource.*401/.test(message.text())
  )
    report.consoleErrors.push(message.text());
});
await page.exposeFunction("recordPolicyViolation", (directive) =>
  report.policyViolations.push(directive),
);
await page.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (event) => {
    void window.recordPolicyViolation(event.violatedDirective);
  });
});
page.on("response", (response) => {
  const pathname = new URL(response.url()).pathname;
  if (
    response.status() >= 400 &&
    !(response.status() === 401 && pathname === "/api/auth/session")
  ) {
    report.responseErrors.push({ path: pathname, status: response.status() });
  }
});

async function visit(route, heading) {
  await page.goto(`${base}/#/${route}`);
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  if (route === "flags")
    await page
      .getByRole("heading", { name: "Checkout redesign", exact: true })
      .waitFor();
  if (route.startsWith("flags/"))
    await page.getByLabel("Rollout percentage", { exact: true }).waitFor();
  if (route === "audit") await page.getByText(/entries · Page/).waitFor();
}

async function inspect(name, width, enlarged = false) {
  await page.setViewportSize({ width, height: 1000 });
  const result = await page.evaluate(() => {
    const visible = (element) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden";
    const colors = [];
    const parse = (value) => (value.match(/[\d.]+/g) || []).map(Number);
    const luminance = (value) =>
      parse(value)
        .slice(0, 3)
        .map((v) => {
          const x = v / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const background = (element) => {
      for (let node = element; node; node = node.parentElement) {
        const value = getComputedStyle(node).backgroundColor;
        const channels = parse(value);
        if (channels.length === 3 || channels[3] === 1) return value;
      }
      return "rgb(255, 255, 255)";
    };
    for (const element of document.querySelectorAll("body *")) {
      if (
        !visible(element) ||
        element.closest(":disabled") ||
        ![...element.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim(),
        )
      )
        continue;
      const style = getComputedStyle(element);
      const bg = background(element);
      const a = luminance(style.color);
      const b = luminance(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (!Number.isFinite(ratio)) continue;
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.667 &&
          parseInt(style.fontWeight, 10) >= 700);
      colors.push({
        foreground: style.color,
        background: bg,
        ratio,
        minimum: large ? 3 : 4.5,
      });
    }
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      contrast: [
        ...new Map(
          colors.map((v) => [
            `${v.foreground}/${v.background}/${v.minimum}`,
            v,
          ]),
        ).values(),
      ],
      landmarks: document.querySelectorAll("main").length,
      h1: document.querySelectorAll("h1").length,
    };
  });
  report.layouts.push({
    name,
    width,
    enlarged,
    clientWidth: result.clientWidth,
    scrollWidth: result.scrollWidth,
    landmarks: result.landmarks,
    h1: result.h1,
  });
  report.contrast.push(...result.contrast);
  if (result.scrollWidth > result.clientWidth + 1)
    throw new Error(`Horizontal overflow: ${name}, ${width}`);
  if (result.landmarks !== 1 || result.h1 !== 1)
    throw new Error(`Page landmarks: ${name}`);
  if (result.contrast.some((v) => v.ratio < v.minimum))
    throw new Error(`Text contrast: ${name}, ${width}`);
}

try {
  await page.route("**/api/auth/session", (route) => route.abort("failed"), {
    times: 1,
  });
  await page.goto(base);
  const retrySession = page.getByRole("button", {
    name: "Retry session check",
    exact: true,
  });
  await expect(retrySession).toBeVisible();
  expectingSessionFault = false;
  await retrySession.click();
  await page
    .getByRole("heading", { name: "Sign in to RolloutDesk", exact: true })
    .waitFor();
  await page.keyboard.press("Tab");
  report.keyboard.firstLoginField = await page.evaluate(
    () => document.activeElement.id,
  );
  if (report.keyboard.firstLoginField !== "login-email")
    throw new Error("Login keyboard order");
  for (const width of [320, 390, 768, 1024, 1440])
    await inspect("login", width);
  await page.screenshot({
    path: path.join(screenshots, "01-login.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Email", { exact: true })
    .fill("operator@rolloutdesk.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Feature flags", exact: true })
    .waitFor();
  await visit("flags/checkout-redesign/staging", "Checkout redesign");
  await page.getByLabel("Enable flag in draft", { exact: true }).check();
  await page.getByLabel("Rollout percentage", { exact: true }).fill("37.50");
  await page
    .getByLabel("Allowlisted subject IDs", { exact: true })
    .fill("demo-alice\ndemo-customer-001");
  const save = page.getByRole("button", { name: "Save draft", exact: true });
  if (await save.isEnabled()) {
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith("/draft"),
    );
    await save.click();
    if ((await saved).status() !== 200)
      throw new Error("Capture draft save failed");
    await expect(
      page.getByText(
        "Draft saved. Client behavior is unchanged until you publish.",
        { exact: true },
      ),
    ).toBeVisible();
  }
  await page
    .getByLabel("Publication note", { exact: true })
    .fill(
      "Synthetic portfolio walkthrough: release a stable 37.50 percent cohort.",
    );
  const publish = page.getByRole("button", {
    name: "Publish saved draft",
    exact: true,
  });
  const alreadyActive = page.getByText(
    "The saved draft already matches the active publication.",
    { exact: true },
  );
  if (!(await alreadyActive.isVisible())) {
    await expect(publish).toBeEnabled();
    const published = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/publish"),
    );
    await publish.click();
    if ((await published).status() !== 200)
      throw new Error("Capture publication failed");
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
    if (name === "registry")
      await page.screenshot({
        path: path.join(screenshots, "02-flags.png"),
        fullPage: true,
      });
    if (name === "detail") {
      await page.screenshot({
        path: path.join(screenshots, "03-flag-detail.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: path.join(screenshots, "04-mobile.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await inspect(name, 1440, true);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
  }
  await visit("flags", "Feature flags");
  await page
    .getByRole("link", { name: "Skip to workspace", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  report.keyboard.skipLinkTarget = await page.evaluate(
    () => document.activeElement.id,
  );
  if (report.keyboard.skipLinkTarget !== "main-content")
    throw new Error("Skip link did not focus the workspace");
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await page.getByLabel("Subject ID", { exact: true }).fill("demo-qa-reader");
  let compared = 0;
  for (const flag of ["checkout-redesign", "bulk-export", "priority-support"]) {
    for (const environment of ["staging", "production"]) {
      await page.getByLabel("Flag", { exact: true }).selectOption(flag);
      await page
        .getByLabel("Environment", { exact: true })
        .selectOption(environment);
      const response = page.waitForResponse(
        (r) => r.url().endsWith("/preview") && r.request().method() === "POST",
      );
      await page
        .getByRole("button", {
          name: "Compare saved configurations",
          exact: true,
        })
        .click();
      if ((await response).status() !== 200)
        throw new Error("Playground comparison failed");
      await expect(page.locator(".decision")).toHaveCount(2);
      compared += 1;
    }
  }
  const responseSummary = page
    .locator("summary")
    .filter({ hasText: "Inspect server response JSON" });
  await responseSummary.press("Enter");
  report.keyboard.responseDetailsOpened = await responseSummary.evaluate(
    (element) => element.parentElement.open,
  );
  if (!report.keyboard.responseDetailsOpened)
    throw new Error("JSON details keyboard activation failed");
  await responseSummary.press("Enter");
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh audit", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh audit", exact: true }),
  ).toBeEnabled();
  const next = page.getByRole("button", { name: "Next page", exact: true });
  report.auditPagination = { nextEnabled: await next.isEnabled() };
  if (report.auditPagination.nextEnabled) {
    await next.click();
    await expect(page.getByText(/entries · Page 2/)).toBeVisible();
    await page
      .getByRole("button", { name: "Previous page", exact: true })
      .click();
  }
  await expect(page.getByText(/entries · Page 1/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Previous page", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("link", { name: "RolloutDesk flags", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Feature flags", exact: true }),
  ).toBeVisible();
  await page
    .locator('.registry a[href="#/flags/checkout-redesign/staging"]')
    .click();
  await page.getByRole("link", { name: "Production", exact: true }).click();
  await expect(page.locator(".environment-label")).toHaveText("production");
  await page.getByRole("link", { name: "Staging", exact: true }).click();
  await expect(
    page.getByLabel("Rollout percentage", { exact: true }),
  ).toHaveValue("37.50");
  const storedSummary = page
    .locator("summary")
    .filter({ hasText: "Inspect stored draft JSON" });
  await storedSummary.press("Enter");
  report.keyboard.storedDetailsOpened = await storedSummary.evaluate(
    (element) => element.parentElement.open,
  );
  if (!report.keyboard.storedDetailsOpened)
    throw new Error("Stored JSON keyboard activation failed");
  await storedSummary.press("Enter");
  await page.getByRole("button", { name: "Refresh flag", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh flag", exact: true }),
  ).toBeEnabled();
  await page.getByRole("link", { name: "All flags", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh flags", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh flags", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to RolloutDesk", exact: true }),
  ).toBeVisible();
  report.extraClickThrough = {
    comparedConfigurations: compared,
    navigation: true,
    environmentLinks: true,
    refreshControls: true,
    signOut: true,
  };
  report.contrast = [
    ...new Map(
      report.contrast.map((v) => [
        `${v.foreground}/${v.background}/${v.minimum}`,
        v,
      ]),
    ).values(),
  ];
  if (
    report.pageErrors.length ||
    report.consoleErrors.length ||
    report.policyViolations.length ||
    report.responseErrors.length
  )
    throw new Error("Unexpected browser/API errors during capture");
  report.result = "PASS";
  console.log(
    `Captured four real application screens; ${report.layouts.length} layout checks passed.`,
  );
} finally {
  await writeFile(
    path.join(root, ".local/ui-checks.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
