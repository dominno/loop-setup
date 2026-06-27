import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loop Setup Starter",
  description:
    "A minimal Next.js starter wired to the Claude Code multi-agent localhost loop.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
