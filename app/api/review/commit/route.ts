import { NextResponse } from "next/server";
import { REQUIRED_SCOPES } from "@/lib/catalog";
import { readSession, refreshSpotifySession, spotifyRequest, writeSessionCookie } from "@/lib/session";
import type { Playlist, SpotifySession, SpotifyTrack } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const ADD_LIMIT = 100;
type Page<T> = { items?: T[]; next?: string | null };
type PlaylistItem = { item?: SpotifyTrack | null; track?: SpotifyTrack | null };

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
  if (!session) return NextResponse.json({ error: "Connect Spotify before saving your choices." }, { status: 401 });

  const missingScopes = REQUIRED_SCOPES.filter((scope) => !session.scope.includes(scope));
  if (missingScopes.length) return NextResponse.json({ error: `Reconnect Spotify and approve: ${missingScopes.join(", ")}.` }, { status: 403 });

  let playlistId = "";
  let uris: string[] = [];
  try {
    const body = await request.json();
    playlistId = typeof body.playlistId === "string" ? body.playlistId : "";
    uris = Array.isArray(body.uris) ? body.uris.filter((uri: unknown): uri is string => typeof uri === "string") : [];
  } catch {
    return NextResponse.json({ error: "Could not read your approved tracks." }, { status: 400 });
  }
  if (!/^[A-Za-z0-9]{10,64}$/.test(playlistId)) return NextResponse.json({ error: "Invalid destination playlist." }, { status: 400 });
  if (uris.length > 10000 || uris.some((uri) => !/^spotify:track:[A-Za-z0-9]{10,64}$/.test(uri))) {
    return NextResponse.json({ error: "The approved track list is invalid or too large." }, { status: 400 });
  }

  try {
    if (session.expiresAt < Date.now() + 60_000) await refreshSpotifySession(session);
    const userPlaylists = await getAllPages<Playlist>(session, "/me/playlists?limit=50&offset=0");
    const playlist = userPlaylists.find((item) => item.id === playlistId && item.owner?.id === session.user.id);
    if (!playlist) return NextResponse.json({ error: "That destination playlist is not owned by the connected account." }, { status: 403 });

    const savedItems = await getAllPages<{ track?: SpotifyTrack | null }>(session, "/me/tracks?limit=50&offset=0");
    const likedUris = new Set(savedItems.map((item) => item.track?.uri).filter((uri): uri is string => Boolean(uri)));
    if (uris.some((uri) => !likedUris.has(uri))) {
      return NextResponse.json({ error: "Some approved songs are no longer in Liked Songs. Refresh the review and try again." }, { status: 400 });
    }

    const existingItems = await getAllPages<PlaylistItem>(session, `/playlists/${encodeURIComponent(playlistId)}/items?limit=${PAGE_SIZE}&offset=0`);
    const existingUris = new Set(existingItems.map((item) => (item.item ?? item.track)?.uri).filter((uri): uri is string => Boolean(uri)));
    const uniqueMissing = [...new Set(uris)].filter((uri) => !existingUris.has(uri));
    let added = 0;
    for (let offset = 0; offset < uniqueMissing.length; offset += ADD_LIMIT) {
      const chunk = uniqueMissing.slice(offset, offset + ADD_LIMIT);
      await spotifyRequest(session, `/playlists/${encodeURIComponent(playlistId)}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uris: chunk }),
      });
      added += chunk.length;
    }

    const response = NextResponse.json({ added, playlist: { name: playlist.name, url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlistId}` } }, { headers: { "Cache-Control": "no-store" } });
    writeSessionCookie(response, session);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not add the approved tracks." }, { status: 502 });
  }
}
