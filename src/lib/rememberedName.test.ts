import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadRememberedName,
  saveRememberedName,
  clearRememberedName,
  STORAGE_KEY,
} from "./rememberedName";

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
}

describe("rememberedName (storage available)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when nothing is stored", () => {
    expect(loadRememberedName()).toBeNull();
  });

  it("persists and reads back a name", () => {
    saveRememberedName("Ada");
    expect(loadRememberedName()).toBe("Ada");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("Ada");
  });

  it("clears a stored name", () => {
    saveRememberedName("Ada");
    clearRememberedName();
    expect(loadRememberedName()).toBeNull();
  });

  it("treats an empty stored value as no name", () => {
    saveRememberedName("");
    expect(loadRememberedName()).toBeNull();
  });
});

describe("rememberedName (storage unavailable)", () => {
  beforeEach(() => {
    // Simulate SSR / disabled storage: no localStorage global.
    vi.stubGlobal("localStorage", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads as null without throwing", () => {
    expect(() => loadRememberedName()).not.toThrow();
    expect(loadRememberedName()).toBeNull();
  });

  it("saves and clears without throwing", () => {
    expect(() => saveRememberedName("Ada")).not.toThrow();
    expect(() => clearRememberedName()).not.toThrow();
  });
});
