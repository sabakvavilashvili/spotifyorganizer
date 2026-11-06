import { NextResponse } from "next/server";
import { getGenreCatalogPage } from "@/lib/genre-database";
import { readSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "Connect Spotify to browse the genre catalog." }, { status: 401 });
  const adminIds = (process.env.GENRE_CATALOG_ADMIN_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!adminIds.includes(session.user.id)) {
    return NextResponse.json({ error: "The genre catalog is restricted to its authorized owners. Add your Spotify user ID to GENRE_CATALOG_ADMIN_IDS in .env.local." }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
  if (origin && origin !== expectedOrigin) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });

  const url = new URL(request.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50));
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const genre = (url.searchParams.get("genre") ?? "").trim().slice(0, 80);

  try {
    const result = await getGenreCatalogPage({ page, pageSize, search, genre });
    return NextResponse.json({ ...result, storage: process.env.MONGODB_URI ? "mongodb" : "local" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the genre database.";
    return NextResponse.json({ error: message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
