import { NextResponse } from "next/server";
import { REQUIRED_SCOPES } from "@/lib/catalog";
import { readSession, refreshSpotifySession, spotifyRequest, writeSessionCookie } from "@/lib/session";
import type { Playlist, SpotifySession, SpotifyTrack } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAYLIST_PREFIX = "Sonic Sort · ";
type Page<T> = { items?: T[]; next?: string | null; total?: number };
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

function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
  return !origin || origin === expected;
}

export async function POST(request: Request) {
  if (!checkOrigin(request)) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "Connect Spotify before starting a review." }, { status: 401 });

  const missingScopes = REQUIRED_SCOPES.filter((scope) => !session.scope.includes(scope));
  if (missingScopes.length) return NextResponse.json({ error: `Reconnect Spotify and approve: ${missingScopes.join(", ")}.` }, { status: 403 });

  let name = "";
  try {
    const body = await request.json();
    name = typeof body.name === "string" ? body.name.trim() : "";
  } catch {
    return NextResponse.json({ error: "Could not read the playlist name." }, { status: 400 });
  }
  if (!name || name.length > 60) return NextResponse.json({ error: "Playlist name must be between 1 and 60 characters." }, { status: 400 });

  try {
    if (session.expiresAt < Date.now() + 60_000) await refreshSpotifySession(session);
    const playlists = await getAllPages<Playlist>(session, "/me/playlists?limit=50&offset=0");
    const targetName = `${PLAYLIST_PREFIX}${name}`;
    let playlist = playlists.find((candidate) => candidate.owner?.id === session.user.id && candidate.name.toLocaleLowerCase() === targetName.toLocaleLowerCase());
    if (!playlist) {
      playlist = await spotifyRequest<Playlist>(session, "/me/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: targetName, description: `Tracks manually approved by you with Sonic Sort.`, public: false }),
      });
    }

    const playlistId = encodeURIComponent(playlist.id);
    const existingItems = await getAllPages<PlaylistItem>(session, `/playlists/${playlistId}/items?limit=50&offset=0`);
    const existingUris = new Set(existingItems.map((item) => (item.item ?? item.track)?.uri).filter((uri): uri is string => Boolean(uri)));
    const savedItems = await getAllPages<{ track?: SpotifyTrack | null }>(session, "/me/tracks?limit=50&offset=0");
    const tracks = savedItems
      .map((saved) => saved.track)
      .filter((track): track is SpotifyTrack => Boolean(track?.id && track.uri && !track.is_local && track.uri.startsWith("spotify:track:") && !existingUris.has(track.uri)))
      .map((track) => ({
        id: track.id,
        uri: track.uri,
        name: track.name,
        artists: track.artists?.map((artist) => ({ name: artist.name })) ?? [],
        album: { name: track.album?.name ?? "", images: track.album?.images?.slice(0, 1) ?? [] },
        external_urls: track.external_urls,
      }));

    for (let index = tracks.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [tracks[index], tracks[swapIndex]] = [tracks[swapIndex], tracks[index]];
    }

    const response = NextResponse.json({
      playlist: {
        id: playlist.id,
        name: playlist.name,
        url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`,
      },
      tracks,
      total: tracks.length,
    }, { headers: { "Cache-Control": "no-store" } });
    writeSessionCookie(response, session);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not prepare your review." }, { status: 502 });
  }
}
