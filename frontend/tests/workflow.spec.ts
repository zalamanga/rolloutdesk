import { test, expect, type Page as BrowserPage } from "@playwright/test";
import type {
  Config,
  FlagDetail,
  Session,
  Environment,
  Decision,
} from "../src/types";
import { sameConfig } from "../src/utils";

const password = process.env.ROLLOUT_DEMO_PASSWORD;
const stagingToken = process.env.ROLLOUT_STAGING_TOKEN;
const productionToken = process.env.ROLLOUT_PRODUCTION_TOKEN;
const origin = process.env.ROLLOUT_BASE_URL || "http://127.0.0.1:8098";
const disabled: Config = {
  enabled: false,
  rolloutBasisPoints: 0,
  allowlist: [],
};

test.beforeEach(() => {
  if (!password || !stagingToken || !productionToken)
    throw new Error(
      "Set the three private ROLLOUT test credentials. Never put them in source.",
    );
});

async function login(page: BrowserPage): Promise<string> {
  await page.goto("/#/flags");
  await expect(
    page.getByRole("heading", { name: "Sign in to RolloutDesk" }),
  ).toBeVisible();
  await page
    .getByLabel("Email", { exact: true })
    .fill("operator@rolloutdesk.test");
  await page.getByLabel("Password", { exact: true }).fill(password!);
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith("/api/auth/login") &&
      item.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const found = await response;
  expect(found.status()).toBe(200);
  const session = (await found.json()) as Session;
  await expect(
    page.getByRole("heading", { name: "Feature flags", exact: true }),
  ).toBeVisible();
  return session.csrfToken;
}

async function detail(
  page: BrowserPage,
  key: string,
  environment: Environment,
): Promise<FlagDetail> {
  const response = await page.request.get(`/api/flags/${key}/${environment}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as FlagDetail;
}

async function write(
  page: BrowserPage,
  csrf: string,
  method: "put" | "post",
  path: string,
  body: unknown,
) {
  const response = await page.request[method](path, {
    headers: { Origin: origin, "X-CSRF-Token": csrf },
    data: body,
  });
  expect(response.status()).toBe(200);
  return response;
}

async function fixture(
  page: BrowserPage,
  csrf: string,
  key: string,
  environment: Environment,
  config: Config,
): Promise<FlagDetail> {
  let found = await detail(page, key, environment);
  const saved = await write(
    page,
    csrf,
    "put",
    `/api/flags/${key}/${environment}/draft`,
    { expectedVersion: found.state.version, config },
  );
  const state = await saved.json();
  if (found.state.active && sameConfig(found.state.active.config, config))
    return await detail(page, key, environment);
  const published = await write(
    page,
    csrf,
    "post",
    `/api/flags/${key}/${environment}/publish`,
    { expectedVersion: state.version, note: "Synthetic browser test baseline" },
  );
  found = await published.json();
  return found;
}

async function openFlag(
  page: BrowserPage,
  key: string,
  environment: Environment,
) {
  await page.goto(`/#/flags/${key}/${environment}`);
  await expect(
    page.getByRole("heading", { name: "Draft configuration" }),
  ).toBeVisible();
}

async function edit(
  page: BrowserPage,
  enabled: boolean,
  percentage: string,
  allowlist = "",
) {
  await page.getByLabel("Enable flag in draft").setChecked(enabled);
  await page.getByLabel("Rollout percentage", { exact: true }).fill(percentage);
  await page.getByLabel("Allowlisted subject IDs").fill(allowlist);
}

async function save(page: BrowserPage) {
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith("/draft") && item.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(
    page.getByText(
      "Draft saved. Client behavior is unchanged until you publish.",
      { exact: true },
    ),
  ).toBeVisible();
}

async function publish(page: BrowserPage, note: string) {
  await page.getByLabel("Publication note").fill(note);
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith("/publish") && item.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Publish saved draft", exact: true })
    .click();
  const found = await response;
  expect(found.status()).toBe(200);
  return (await found.json()) as FlagDetail;
}

async function evaluate(
  page: BrowserPage,
  environment: Environment,
  token: string,
  flagKey: string,
  subjectId: string,
) {
  return await page.request.post(`/client/v1/evaluate/${environment}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { flagKey, subjectId },
  });
}

test("draft edits remain separate from published clients and environment-scoped tokens", async ({
  page,
}) => {
  const csrf = await login(page);
  const baseline = await fixture(
    page,
    csrf,
    "checkout-redesign",
    "staging",
    disabled,
  );
  const productionBefore = await detail(
    page,
    "checkout-redesign",
    "production",
  );
  await openFlag(page, "checkout-redesign", "staging");
  await edit(page, true, "12.34", "VIP-Case\nvip-case");
  await expect(
    page.getByRole("button", { name: "Publish saved draft", exact: true }),
  ).toBeDisabled();
  await save(page);
  await expect(page.getByTestId("active-revision")).toHaveText(
    `Revision ${baseline.state.active!.revision}`,
  );
  const saved = await detail(page, "checkout-redesign", "staging");
  expect(saved.state.draft.rolloutBasisPoints).toBe(1234);
  expect(saved.state.active!.config.enabled).toBe(false);
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await page.getByLabel("Subject ID", { exact: true }).fill("VIP-Case");
  await page
    .getByRole("button", { name: "Compare saved configurations" })
    .click();
  const publishedPanel = page
    .locator(".decision")
    .filter({ has: page.getByRole("heading", { name: "Published behavior" }) });
  const draftPanel = page
    .locator(".decision")
    .filter({
      has: page.getByRole("heading", { name: "Saved draft preview" }),
    });
  await expect(
    publishedPanel.getByText("DISABLED", { exact: true }),
  ).toBeVisible();
  await expect(
    draftPanel.getByText("ALLOWLIST", { exact: true }),
  ).toBeVisible();
  await openFlag(page, "checkout-redesign", "staging");
  const result = await publish(page, "Enable synthetic VIP checkout cohort");
  expect(result.state.active!.config.rolloutBasisPoints).toBe(1234);
  const staging = await evaluate(
    page,
    "staging",
    stagingToken!,
    "checkout-redesign",
    "VIP-Case",
  );
  expect(staging.status()).toBe(200);
  expect(((await staging.json()) as Decision).reason).toBe("ALLOWLIST");
  const wrongScope = await evaluate(
    page,
    "production",
    stagingToken!,
    "checkout-redesign",
    "VIP-Case",
  );
  expect(wrongScope.status()).toBe(401);
  const unknown = await evaluate(
    page,
    "production",
    productionToken!,
    "unknown-demo-flag",
    "VIP-Case",
  );
  expect(unknown.status()).toBe(200);
  expect(await unknown.json()).toMatchObject({
    value: false,
    reason: "FLAG_NOT_FOUND",
    bucket: null,
    revision: null,
  });
  const productionAfter = await detail(page, "checkout-redesign", "production");
  expect(productionAfter).toEqual(productionBefore);
});

test("rollback appends immutable history while keeping the saved draft and notes", async ({
  page,
}) => {
  const csrf = await login(page);
  const baseline = await fixture(
    page,
    csrf,
    "bulk-export",
    "staging",
    disabled,
  );
  await openFlag(page, "bulk-export", "staging");
  await edit(page, true, "100");
  await save(page);
  const first = await publish(page, "Enable full synthetic bulk export");
  await edit(page, true, "42.42", "retained-subject");
  await save(page);
  await page
    .getByLabel("Publication note")
    .fill("Keep this unfinished release explanation");
  await page
    .getByLabel("Historical revision")
    .selectOption(String(baseline.state.active!.revision));
  await page
    .getByLabel("Rollback note")
    .fill("Restore the previous disabled configuration");
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith("/rollback") && item.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Publish rollback revision" }).click();
  const rollbackResponse = await response;
  expect(rollbackResponse.status()).toBe(200);
  const rolled = (await rollbackResponse.json()) as FlagDetail;
  expect(rolled.state.active).toMatchObject({
    kind: "ROLLBACK",
    sourceRevision: baseline.state.active!.revision,
    config: disabled,
  });
  expect(rolled.state.active!.revision).toBeGreaterThan(
    first.state.active!.revision,
  );
  expect(
    rolled.history.find(
      (item) => item.revision === first.state.active!.revision,
    ),
  ).toEqual(first.state.active);
  expect(rolled.state.draft).toMatchObject({
    enabled: true,
    rolloutBasisPoints: 4242,
    allowlist: ["retained-subject"],
  });
  await expect(
    page.getByLabel("Rollout percentage", { exact: true }),
  ).toHaveValue("42.42");
  await expect(page.getByLabel("Publication note")).toHaveValue(
    "Keep this unfinished release explanation",
  );
  await expect(page.getByLabel("Rollback note")).toHaveValue(
    "Restore the previous disabled configuration",
  );
  await expect(
    page.getByText(`Rollback from ${baseline.state.active!.revision}`, {
      exact: true,
    }),
  ).toBeVisible();
});

test("a stale tab locks writes until manual refresh without discarding edited fields", async ({
  page,
}) => {
  const csrf = await login(page);
  await fixture(page, csrf, "priority-support", "staging", disabled);
  await openFlag(page, "priority-support", "staging");
  await edit(page, true, "33.33", "local-edit");
  await page
    .getByLabel("Publication note")
    .fill("Retained note from an older workspace view");
  const other = await detail(page, "priority-support", "staging");
  await write(page, csrf, "put", "/api/flags/priority-support/staging/draft", {
    expectedVersion: other.state.version,
    config: { enabled: true, rolloutBasisPoints: 700, allowlist: [] },
  });
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith("/draft") && item.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(
    page.getByText(/Writes paused\. The last outcome/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Refresh flag", exact: true }).click();
  await expect(page.getByText(/Current server state loaded/)).toBeVisible();
  await expect(
    page.getByLabel("Rollout percentage", { exact: true }),
  ).toHaveValue("33.33");
  await expect(page.getByLabel("Allowlisted subject IDs")).toHaveValue(
    "local-edit",
  );
  await expect(page.getByLabel("Publication note")).toHaveValue(
    "Retained note from an older workspace view",
  );
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeEnabled();
  await save(page);
});

test("an aborted response after a real publication requires reconciliation and is not auto-retried", async ({
  page,
}) => {
  const csrf = await login(page);
  await fixture(page, csrf, "bulk-export", "production", disabled);
  await openFlag(page, "bulk-export", "production");
  await edit(page, true, "18.29", "uncertain-subject");
  await save(page);
  await page
    .getByLabel("Publication note")
    .fill("Synthetic publication with a lost response");
  const before = await detail(page, "bulk-export", "production");
  let writes = 0;
  await page.route(
    "**/api/flags/bulk-export/production/publish",
    async (route) => {
      writes++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    },
  );
  await page
    .getByRole("button", { name: "Publish saved draft", exact: true })
    .click();
  await expect(
    page.getByText(/Writes paused\. The last outcome/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish saved draft", exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(1);
  await page.unroute("**/api/flags/bulk-export/production/publish");
  await page.getByRole("button", { name: "Refresh flag", exact: true }).click();
  await expect(page.getByText(/Current server state loaded/)).toBeVisible();
  const after = await detail(page, "bulk-export", "production");
  expect(after.history.length).toBe(before.history.length + 1);
  await expect(page.getByTestId("active-revision")).toHaveText(
    `Revision ${after.state.active!.revision}`,
  );
  await expect(page.getByLabel("Publication note")).toHaveValue(
    "Synthetic publication with a lost response",
  );
  await expect(
    page.getByRole("button", { name: "Publish saved draft", exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(1);
});

test("mobile keyboard validation, session expiry and audit keep the work reachable", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const csrf = await login(page);
  await fixture(page, csrf, "priority-support", "production", disabled);
  await openFlag(page, "priority-support", "production");
  await edit(page, true, "100.001", "space invalid");
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(/at most two decimal places/, { exact: false }).last(),
  ).toBeVisible();
  await page.getByLabel("Rollout percentage", { exact: true }).fill("29.29");
  await expect(
    page.getByText(/Each subject must use/, { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Allowlisted subject IDs").fill("mobile-subject");
  await page
    .getByLabel("Publication note")
    .fill("Mobile note retained after session expiry");
  await page.getByLabel("Rollout percentage", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Allowlisted subject IDs")).toBeFocused();
  await context.clearCookies();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to RolloutDesk" }),
  ).toBeVisible();
  await page
    .getByLabel("Email", { exact: true })
    .fill("operator@rolloutdesk.test");
  await page.getByLabel("Password", { exact: true }).fill(password!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Draft configuration" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Rollout percentage", { exact: true }),
  ).toHaveValue("29.29");
  await expect(page.getByLabel("Publication note")).toHaveValue(
    "Mobile note retained after session expiry",
  );
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Refresh flag", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeEnabled();
  await save(page);
  for (const route of [
    "#/flags",
    "#/playground",
    "#/audit",
    "#/flags/priority-support/production",
  ]) {
    await page.goto(`/${route}`);
    await expect(page.locator("main h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Audit table", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("draft saved", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to RolloutDesk" }),
  ).toBeVisible();
});
