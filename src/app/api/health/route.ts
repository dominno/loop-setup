import { NextResponse } from "next/server";

/** Liveness endpoint used by smoke tests and uptime checks. */
export function GET() {
  return NextResponse.json({ status: "ok" });
}
