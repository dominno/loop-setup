import { describe, it, expect } from "vitest";
import { buildGreeting, normalizeName, MAX_NAME_LENGTH } from "./greeting";

describe("normalizeName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeName("  Ada  ")).toBe("Ada");
  });

  it("collapses repeated internal whitespace", () => {
    expect(normalizeName("Ada   Lovelace")).toBe("Ada Lovelace");
  });
});

describe("buildGreeting", () => {
  it("rejects an empty name", () => {
    const result = buildGreeting("");
    expect(result).toEqual({ ok: false, error: "Please enter your name." });
  });

  it("rejects a whitespace-only name", () => {
    const result = buildGreeting("    ");
    expect(result.ok).toBe(false);
  });

  it("rejects a name longer than the max length", () => {
    const result = buildGreeting("a".repeat(MAX_NAME_LENGTH + 1));
    expect(result).toEqual({
      ok: false,
      error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
    });
  });

  it("accepts a name at exactly the max length", () => {
    const result = buildGreeting("a".repeat(MAX_NAME_LENGTH));
    expect(result.ok).toBe(true);
  });

  it("greets a valid, normalized name", () => {
    const result = buildGreeting("  Ada  ");
    expect(result).toEqual({ ok: true, message: "Hello, Ada! Welcome aboard." });
  });
});
