import { NextResponse } from "next/server";
import { REQUIRED_SCOPES } from "@/lib/catalog";
import { ensureGenreDatabase } from "@/lib/genre-database";
import { readSession, refreshSpotifySession, spotifyRequest, writeSessionCookie } from "@/lib/session";
import type { Playlist, SpotifySession, SpotifyTrack } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAYLIST_PREFIX = "Sonic Sort · ";
type Page<T> = { items?: T[]; next?: string | null };
type PlaylistItem = { item?: SpotifyTrack | null; track?: SpotifyTrack | null };
type GenreTarget = { id: string; name: string };

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
  if (!session) return NextResponse.json({ error: "Connect Spotify before sorting genres." }, { status: 401 });
  const missingScopes = REQUIRED_SCOPES.filter((scope) => !session.scope.includes(scope));
  if (missingScopes.length) return NextResponse.json({ error: `Reconnect Spotify and approve: ${missingScopes.join(", ")}.` }, { status: 403 });

  let genres: GenreTarget[] = [];
  try {
    const body = await request.json();
    if (!Array.isArray(body.genres)) throw new Error("Choose at least one genre.");
    genres = body.genres.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("Invalid genre selection.");
      const target = item as Partial<GenreTarget>;
      if (typeof target.name !== "string" || !target.name.trim() || target.name.trim().length > 60 || typeof target.id !== "string" || target.id.length > 64) throw new Error("Invalid genre selection.");
      return { id: target.id, name: target.name.trim() };
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read genre selection." }, { status: 400 });
  }
  if (!genres.length || genres.length > 12 || new Set(genres.map((genre) => genre.id)).size !== genres.length) {
    return NextResponse.json({ error: "Choose between 1 and 12 different genres." }, { status: 400 });
  }

  try {
    await ensureGenreDatabase();
    if (session.expiresAt < Date.now() + 60_000) await refreshSpotifySession(session);
    const userPlaylists = await getAllPages<Playlist>(session, "/me/playlists?limit=50&offset=0");
    const destinations = [];
    for (const genre of genres) {
      const playlistName = `${PLAYLIST_PREFIX}${genre.name}`;
      let playlist = userPlaylists.find((item) => item.owner?.id === session.user.id && item.name.toLocaleLowerCase() === playlistName.toLocaleLowerCase());
      if (!playlist) {
        playlist = await spotifyRequest<Playlist>(session, "/me/playlists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: playlistName, description: `Genre-organized with MusicBrainz community metadata. Non-commercial prototype.`, public: false }),
        });
      }
      destinations.push({ id: genre.id, name: genre.name, playlistId: playlist.id, playlistName: playlist.name, url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}` });
    }

    const existingByPlaylist: Record<string, string[]> = {};
    for (const destination of destinations) {
      const existing = await getAllPages<PlaylistItem>(session, `/playlists/${encodeURIComponent(destination.playlistId)}/items?limit=50&offset=0`);
      existingByPlaylist[destination.id] = existing.map((item) => (item.item ?? item.track)?.uri).filter((uri): uri is string => Boolean(uri));
    }

    const savedItems = await getAllPages<{ track?: SpotifyTrack | null }>(session, "/me/tracks?limit=50&offset=0");
    const localTracks = savedItems.filter((saved) => saved.track?.is_local).length;
    const unavailableItems = savedItems.filter((saved) => !saved.track?.is_local && (!saved.track?.id || !saved.track.uri || !saved.track.uri.startsWith("spotify:track:"))).length;
    const tracks = savedItems
      .map((saved) => saved.track)
      .filter((track): track is SpotifyTrack => Boolean(track?.id && track.uri && !track.is_local && track.uri.startsWith("spotify:track:")))
      .map((track) => ({
        id: track.id,
        uri: track.uri,
        name: track.name,
        artists: track.artists?.map((artist) => ({ name: artist.name })) ?? [],
        album: { name: track.album?.name ?? "", images: track.album?.images?.slice(0, 1) ?? [] },
        external_urls: track.external_urls,
        isrc: track.external_ids?.isrc ?? null,
      }));

    const tracksWithoutIsrc = tracks.filter((track) => !track.isrc?.trim()).length;
    const response = NextResponse.json({
      destinations,
      existingByPlaylist,
      tracks,
      total: tracks.length,
      libraryStats: {
        savedItems: savedItems.length,
        usableTracks: tracks.length,
        localTracks,
        unavailableItems,
        tracksWithoutIsrc,
      },
    }, { headers: { "Cache-Control": "no-store" } });
    writeSessionCookie(response, session);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not prepare genre sorting." }, { status: 502 });
  }
}
