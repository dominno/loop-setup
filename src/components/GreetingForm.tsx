"use client";

import { useState, useSyncExternalStore } from "react";
import { buildGreeting, normalizeName } from "@/lib/greeting";
import {
  loadRememberedName,
  saveRememberedName,
  clearRememberedName,
  subscribeRememberedName,
} from "@/lib/rememberedName";

export function GreetingForm() {
  // Read the remembered name from localStorage as an external store. The server
  // snapshot is null, so SSR/first hydration render empty and React re-renders
  // with the stored value on the client — no hydration mismatch, no effect.
  const persisted = useSyncExternalStore(
    subscribeRememberedName,
    loadRememberedName,
    () => null,
  );

  // `draft` is null while the field follows the remembered name, or a string
  // once the visitor starts editing.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const name = draft ?? persisted ?? "";
  const showingRemembered = draft === null && persisted !== null;
  const greeting = showingRemembered ? buildGreeting(persisted) : null;
  const message = greeting && greeting.ok ? greeting.message : null;

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    setDraft(event.target.value);
    setError(null);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = buildGreeting(name);
    if (result.ok) {
      // Persist the normalized name and let the field follow it again.
      saveRememberedName(normalizeName(name));
      setDraft(null);
      setError(null);
    } else {
      // Validation failed: surface the error and persist nothing (AC4).
      setError(result.error);
    }
  }

  function handleClear() {
    clearRememberedName();
    setDraft(null);
    setError(null);
  }

  return (
    <form className="card" onSubmit={handleSubmit} noValidate>
      <label className="field-label" htmlFor="name">
        Your name
      </label>
      <input
        id="name"
        name="name"
        className="field-input"
        type="text"
        value={name}
        autoComplete="name"
        placeholder="e.g. Ada Lovelace"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "name-error" : undefined}
        onChange={handleChange}
      />

      {error ? (
        <p id="name-error" role="alert" className="message message-error">
          {error}
        </p>
      ) : null}

      <button className="button" type="submit">
        Say hello
      </button>

      {message ? (
        <p role="status" className="message message-success" data-testid="greeting">
          {message}
        </p>
      ) : null}

      {showingRemembered ? (
        <button
          type="button"
          className="button-ghost"
          data-testid="clear-remembered"
          onClick={handleClear}
        >
          Not you? Clear
        </button>
      ) : null}
    </form>
  );
}
