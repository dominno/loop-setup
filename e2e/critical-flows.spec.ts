import { test, expect } from "@playwright/test";

test.describe("greeting flow", () => {
  test("happy path: a valid name shows a greeting", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Your name").fill("Ada Lovelace");
    await page.getByRole("button", { name: "Say hello" }).click();

    await expect(page.getByTestId("greeting")).toHaveText(
      "Hello, Ada Lovelace! Welcome aboard.",
    );
  });

  test("failure path: an empty name shows a validation error", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Say hello" }).click();

    const error = page.locator("#name-error");
    await expect(error).toHaveText("Please enter your name.");
    await expect(page.getByTestId("greeting")).toHaveCount(0);
  });

  test("recovery: fixing the input replaces the error with a greeting", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Say hello" }).click();
    await expect(page.locator("#name-error")).toBeVisible();

    await page.getByLabel("Your name").fill("Grace");
    await page.getByRole("button", { name: "Say hello" }).click();

    await expect(page.getByTestId("greeting")).toHaveText(
      "Hello, Grace! Welcome aboard.",
    );
    await expect(page.locator("#name-error")).toHaveCount(0);
  });
});
