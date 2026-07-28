import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Accessibility gate — the objective half of the quality bar
 * (.claude/memory/topics/quality-bar.md): zero `serious`/`critical` axe
 * violations against WCAG 2.1 A/AA across the main flow's key states.
 */

const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function scan(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

// Compact, actionable failure message: rule id + the offending selectors.
function summarize(violations: Awaited<ReturnType<typeof scan>>) {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
    .join("\n");
}

test.describe("accessibility (WCAG 2.1 AA, no serious/critical)", () => {
  test("initial load", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Your name")).toBeVisible();
    const v = await scan(page);
    expect(v, `axe violations:\n${summarize(v)}`).toEqual([]);
  });

  test("validation-error state", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Say hello" }).click();
    await expect(page.locator("#name-error")).toBeVisible();
    const v = await scan(page);
    expect(v, `axe violations:\n${summarize(v)}`).toEqual([]);
  });

  test("greeting state", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Your name").fill("Ada Lovelace");
    await page.getByRole("button", { name: "Say hello" }).click();
    await expect(page.getByTestId("greeting")).toBeVisible();
    const v = await scan(page);
    expect(v, `axe violations:\n${summarize(v)}`).toEqual([]);
  });
});
