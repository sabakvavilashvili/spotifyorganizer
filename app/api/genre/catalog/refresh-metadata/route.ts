import { NextResponse } from "next/server";
import { REQUIRED_SCOPES } from "@/lib/catalog";
import { getCachedTrackGenres, saveTrackGenres } from "@/lib/genre-database";
import { readSession, refreshSpotifySession, spotifyRequest } from "@/lib/session";
import type { SpotifySession, SpotifyTrack } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Page<T> = { items?: T[]; next?: string | null };

async function getAllPages<T>(session: SpotifySession, initialPath: string) {
  const all: T[] = [];
  let next: string | null = initialPath;
  while (next) {
    const page: Page<T> = await spotifyRequest<Page<T>>(session, next);
    all.push(...(page.items ?? []));
    next = page.next ?? null;
  }
  return all;
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "Connect Spotify to refresh catalog metadata." }, { status: 401 });
  const adminIds = (process.env.GENRE_CATALOG_ADMIN_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!adminIds.includes(session.user.id)) return NextResponse.json({ error: "This action is limited to authorized catalog owners." }, { status: 403 });
  const missingScopes = REQUIRED_SCOPES.filter((scope) => !session.scope.includes(scope));
  if (missingScopes.length) return NextResponse.json({ error: `Reconnect Spotify and approve: ${missingScopes.join(", ")}.` }, { status: 403 });
  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
  if (origin && origin !== expectedOrigin) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });

  try {
    if (session.expiresAt < Date.now() + 60_000) await refreshSpotifySession(session);
    const savedItems = await getAllPages<{ track?: SpotifyTrack | null }>(session, "/me/tracks?limit=50&offset=0");
    const tracks = savedItems.map((item) => item.track).filter((track): track is SpotifyTrack => Boolean(track?.id && track.uri && !track.is_local && track.uri.startsWith("spotify:track:")));
    const cached = await getCachedTrackGenres(tracks.map((track) => track.id));
    const now = new Date().toISOString();
    const updates = tracks.flatMap((track) => {
      const existing = cached.get(track.id);
      if (!existing) return [];
      return [{
        ...existing,
        isrc: track.external_ids?.isrc ?? existing.isrc,
        trackName: track.name,
        artistNames: track.artists?.map((artist) => artist.name) ?? [],
        albumName: track.album?.name ?? null,
        albumImageUrl: track.album?.images?.[0]?.url ?? null,
        lookedUpAt: existing.lookedUpAt || now,
      }];
    });
    await saveTrackGenres(updates);
    return NextResponse.json({ updated: updates.length, cached: cached.size, libraryTracks: tracks.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not refresh Spotify track metadata." }, { status: 502 });
  }
}
