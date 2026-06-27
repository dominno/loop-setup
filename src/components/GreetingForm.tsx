"use client";

import { useState } from "react";
import { buildGreeting } from "@/lib/greeting";

export function GreetingForm() {
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = buildGreeting(name);
    if (result.ok) {
      setMessage(result.message);
      setError(null);
    } else {
      setError(result.error);
      setMessage(null);
    }
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
        onChange={(event) => setName(event.target.value)}
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
    </form>
  );
}
