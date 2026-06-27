import { GreetingForm } from "@/components/GreetingForm";

export default function HomePage() {
  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Claude Code · multi-agent loop</p>
        <h1 className="title">Loop Setup Starter</h1>
        <p className="subtitle">
          A minimal, end-to-end-tested Next.js app wired to the multi-agent
          critic workflow. Enter your name to verify the happy path and the
          validation path.
        </p>
      </section>

      <GreetingForm />
    </main>
  );
}
