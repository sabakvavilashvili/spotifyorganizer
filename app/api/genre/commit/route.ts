import { NextResponse } from "next/server";
import { REQUIRED_SCOPES } from "@/lib/catalog";
import { readSession, refreshSpotifySession, spotifyRequest, writeSessionCookie } from "@/lib/session";
import type { Playlist, SpotifySession, SpotifyTrack } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADD_LIMIT = 100;
type Page<T> = { items?: T[]; next?: string | null };
type PlaylistItem = { item?: SpotifyTrack | null; track?: SpotifyTrack | null };
type Destination = { id: string; playlistId: string; uris: string[] };

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
  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
  if (origin && origin !== expectedOrigin) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "Connect Spotify before adding genre matches." }, { status: 401 });
  const missingScopes = REQUIRED_SCOPES.filter((scope) => !session.scope.includes(scope));
  if (missingScopes.length) return NextResponse.json({ error: `Reconnect Spotify and approve: ${missingScopes.join(", ")}.` }, { status: 403 });

  let destinations: Destination[] = [];
  try {
    const body = await request.json();
    if (!Array.isArray(body.destinations)) throw new Error("Genre destinations are invalid.");
    destinations = body.destinations.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("Genre destination is invalid.");
      const target = item as Partial<Destination>;
      if (typeof target.id !== "string" || target.id.length > 64 || typeof target.playlistId !== "string" || !/^[A-Za-z0-9]{10,64}$/.test(target.playlistId) || !Array.isArray(target.uris)) throw new Error("Genre destination is invalid.");
      const uris = target.uris.filter((uri): uri is string => typeof uri === "string");
      if (uris.length > 10000 || uris.some((uri) => !/^spotify:track:[A-Za-z0-9]{10,64}$/.test(uri))) throw new Error("A genre match contains invalid track references.");
      return { id: target.id, playlistId: target.playlistId, uris };
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read genre matches." }, { status: 400 });
  }
  if (!destinations.length || destinations.length > 12 || new Set(destinations.map((item) => item.id)).size !== destinations.length) {
    return NextResponse.json({ error: "Select between 1 and 12 distinct genres." }, { status: 400 });
  }

  try {
    if (session.expiresAt < Date.now() + 60_000) await refreshSpotifySession(session);
    const playlistMap = new Map((await getAllPages<Playlist>(session, "/me/playlists?limit=50&offset=0"))
      .filter((playlist) => playlist.owner?.id === session.user.id)
      .map((playlist) => [playlist.id, playlist]));
    const savedItems = await getAllPages<{ track?: SpotifyTrack | null }>(session, "/me/tracks?limit=50&offset=0");
    const likedUris = new Set(savedItems.map((item) => item.track?.uri).filter((uri): uri is string => Boolean(uri)));
    let added = 0;
    const results = [];

    for (const destination of destinations) {
      const playlist = playlistMap.get(destination.playlistId);
      if (!playlist || !playlist.name.startsWith("Sonic Sort · ")) {
        return NextResponse.json({ error: "A selected destination is not one of your Sonic Sort playlists." }, { status: 403 });
      }
      const requestedUris = [...new Set(destination.uris)];
      if (requestedUris.some((uri) => !likedUris.has(uri))) {
        return NextResponse.json({ error: "Some genre matches are no longer in Liked Songs. Restart genre sorting and try again." }, { status: 400 });
      }
      const items = await getAllPages<PlaylistItem>(session, `/playlists/${encodeURIComponent(playlist.id)}/items?limit=50&offset=0`);
      const existingUris = new Set(items.map((item) => (item.item ?? item.track)?.uri).filter((uri): uri is string => Boolean(uri)));
      const missing = requestedUris.filter((uri) => !existingUris.has(uri));
      let playlistAdded = 0;
      for (let offset = 0; offset < missing.length; offset += ADD_LIMIT) {
        const chunk = missing.slice(offset, offset + ADD_LIMIT);
        await spotifyRequest(session, `/playlists/${encodeURIComponent(playlist.id)}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uris: chunk }),
        });
        playlistAdded += chunk.length;
      }
      added += playlistAdded;
      results.push({ id: destination.id, playlistName: playlist.name, url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`, matched: requestedUris.length, added: playlistAdded });
    }

    const response = NextResponse.json({ added, results }, { headers: { "Cache-Control": "no-store" } });
    writeSessionCookie(response, session);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not add genre matches." }, { status: 502 });
  }
}
