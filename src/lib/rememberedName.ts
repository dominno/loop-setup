export const STORAGE_KEY = "loop-setup:remembered-name";
const CHANGE_EVENT = "loop-setup:remembered-name-change";

/**
 * Safe accessor for the browser's localStorage.
 * Returns null during SSR or when storage is unavailable (e.g. disabled cookies,
 * private mode), so callers never throw.
 */
function getStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
  } catch {
    // Accessing localStorage can throw when storage is blocked.
    return null;
  }
}

/**
 * The browser only emits the native `storage` event for changes made in *other*
 * tabs. Dispatch a custom event so same-tab writes also notify subscribers
 * (e.g. useSyncExternalStore consumers in this document).
 */
function notifyChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

/** Read the remembered name, or null if none is stored / storage is unavailable. */
export function loadRememberedName(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    // Reading can throw when storage is blocked.
    return null;
  }
}

/** Persist the remembered name. No-ops if storage is unavailable. */
export function saveRememberedName(name: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, name);
    notifyChange();
  } catch {
    // Ignore write failures (quota exceeded, private mode).
  }
}

/** Remove the remembered name. No-ops if storage is unavailable. */
export function clearRememberedName(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
    notifyChange();
  } catch {
    // Ignore removal failures.
  }
}

/**
 * Subscribe to remembered-name changes from this tab (custom event) and other
 * tabs (native `storage` event). Returns an unsubscribe function.
 */
export function subscribeRememberedName(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}
