import { NextResponse } from "next/server";
import { readSession, refreshSpotifySession, writeSessionCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await readSession();
    if (!session) return NextResponse.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
    if (session.expiresAt < Date.now() + 60_000) await refreshSpotifySession(session);
    const response = NextResponse.json({
      connected: true,
      user: session.user,
      scopes: session.scope,
    }, { headers: { "Cache-Control": "no-store" } });
    writeSessionCookie(response, session);
    return response;
  } catch (error) {
    return NextResponse.json({ connected: false, error: error instanceof Error ? error.message : "Session unavailable." }, { status: 401 });
  }
}
