import { test, expect } from "@playwright/test";

// US-002: Remember me on return. Playwright gives each test an isolated browser
// context, so localStorage starts empty per test; reload() within a test keeps it.
test.describe("remember me on return", () => {
  test("persists the name and auto-greets on reload (AC1, AC2)", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByLabel("Your name").fill("Ada Lovelace");
    await page.getByRole("button", { name: "Say hello" }).click();
    await expect(page.getByTestId("greeting")).toHaveText(
      "Hello, Ada Lovelace! Welcome aboard.",
    );

    await page.reload();

    // Input is pre-filled and the greeting is shown automatically.
    await expect(page.getByLabel("Your name")).toHaveValue("Ada Lovelace");
    await expect(page.getByTestId("greeting")).toHaveText(
      "Hello, Ada Lovelace! Welcome aboard.",
    );
    await expect(page.getByTestId("clear-remembered")).toBeVisible();
  });

  test("clear removes the remembered name and resets the form (AC3)", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByLabel("Your name").fill("Grace");
    await page.getByRole("button", { name: "Say hello" }).click();
    await expect(page.getByTestId("greeting")).toBeVisible();

    await page.getByTestId("clear-remembered").click();

    await expect(page.getByLabel("Your name")).toHaveValue("");
    await expect(page.getByTestId("greeting")).toHaveCount(0);
    await expect(page.getByTestId("clear-remembered")).toHaveCount(0);

    // Stays cleared across a reload.
    await page.reload();
    await expect(page.getByLabel("Your name")).toHaveValue("");
    await expect(page.getByTestId("greeting")).toHaveCount(0);
  });

  test("does not persist anything when validation fails (AC4)", async ({
    page,
  }) => {
    await page.goto("/");

    // Submit an invalid (empty) name.
    await page.getByRole("button", { name: "Say hello" }).click();
    await expect(page.locator("#name-error")).toBeVisible();

    await page.reload();

    // Nothing was remembered: empty input, no greeting, no clear control.
    await expect(page.getByLabel("Your name")).toHaveValue("");
    await expect(page.getByTestId("greeting")).toHaveCount(0);
    await expect(page.getByTestId("clear-remembered")).toHaveCount(0);
  });

  test("does not call the network when greeting (AC5)", async ({ page }) => {
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      // Allow same-origin app/asset traffic; flag anything else.
      if (!url.startsWith("http://localhost:3000")) {
        externalRequests.push(url);
      }
    });

    await page.goto("/");
    await page.getByLabel("Your name").fill("Ada");
    await page.getByRole("button", { name: "Say hello" }).click();
    await expect(page.getByTestId("greeting")).toBeVisible();

    expect(externalRequests).toEqual([]);
  });
});
