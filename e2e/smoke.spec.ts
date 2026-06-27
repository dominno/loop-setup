import { test, expect } from "@playwright/test";

test.describe("smoke", () => {
  test("home page renders the hero and form", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Loop Setup Starter" }),
    ).toBeVisible();
    await expect(page.getByLabel("Your name")).toBeVisible();
    await expect(page.getByRole("button", { name: "Say hello" })).toBeVisible();
  });

  test("health endpoint responds ok", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
