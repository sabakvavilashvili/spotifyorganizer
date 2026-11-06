import { NextResponse } from "next/server";
import { getCachedTrackGenres, saveTrackGenres } from "@/lib/genre-database";
import { readSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "Connect Spotify before loading your genre cache." }, { status: 401 });
  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
  if (origin && origin !== expectedOrigin) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });

  try {
    const body = await request.json();
    if (!Array.isArray(body.tracks) || body.tracks.length > 2000) {
      return NextResponse.json({ error: "Track list is invalid." }, { status: 400 });
    }
    const tracks = body.tracks.filter((track: unknown) => Boolean(
      track && typeof track === "object" &&
      typeof (track as { id?: unknown }).id === "string" &&
      typeof (track as { name?: unknown }).name === "string" &&
      Array.isArray((track as { artists?: unknown }).artists)
    )) as Array<{ id: string; name: string; artists: Array<{ name: string }>; album: { name?: string; images?: Array<{ url: string }> }; isrc?: string | null }>;
    if (tracks.some((track) => !/^[A-Za-z0-9]{10,64}$/.test(track.id))) return NextResponse.json({ error: "Track ID list is invalid." }, { status: 400 });
    const cached = await getCachedTrackGenres(tracks.map((track) => track.id));
    const lookedUpAt = new Date().toISOString();
    await saveTrackGenres(tracks.flatMap((track) => {
      const row = cached.get(track.id);
      if (!row) return [];
      return [{
        ...row,
        isrc: track.isrc ?? row.isrc,
        trackName: track.name,
        artistNames: track.artists.map((artist) => artist.name),
        albumName: track.album?.name ?? null,
        albumImageUrl: track.album?.images?.[0]?.url ?? null,
        lookedUpAt: row.lookedUpAt || lookedUpAt,
      }];
    }));
    return NextResponse.json({ rows: [...cached.values()] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read the genre cache." }, { status: 500 });
  }
}
