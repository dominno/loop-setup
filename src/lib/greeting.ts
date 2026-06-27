export const MAX_NAME_LENGTH = 40;

export type GreetingResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** Collapse surrounding and repeated internal whitespace. */
export function normalizeName(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/**
 * Pure domain rule for the greeting feature.
 * Validation lives here (not in the component) so it can be unit tested
 * and reused on the server if needed.
 */
export function buildGreeting(rawName: string): GreetingResult {
  const name = normalizeName(rawName);

  if (name.length === 0) {
    return { ok: false, error: "Please enter your name." };
  }

  if (name.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
    };
  }

  return { ok: true, message: `Hello, ${name}! Welcome aboard.` };
}
