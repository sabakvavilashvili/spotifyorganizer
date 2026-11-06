import { NextResponse } from "next/server";
import { saveTrackGenres } from "@/lib/genre-database";
import { readSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const MIN_REQUEST_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 5;
const MAX_LOOKUP_COUNT = 1_000;
let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

type MusicBrainzGenre = { name?: string; count?: number };
type MusicBrainzRecording = { id?: string; genres?: MusicBrainzGenre[]; tags?: MusicBrainzGenre[] };

type LookupResult = { isrc: string; genres: string[]; found: boolean };
type LookupTrack = {
  id: string;
  name: string;
  artists: string[];
  albumName: string;
  albumImageUrl: string | null;
};
type LookupJob = { isrc: string; tracks: LookupTrack[] };

async function waitForSlot() {
  const task = requestQueue.then(async () => {
    const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  requestQueue = task.catch(() => undefined);
  await task;
}

function retryDelayMs(header: string | null, fallbackMs: number) {
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    // Retry-After: 0 is not a useful backoff signal for 429/503. Keep the
    // caller's conservative fallback rather than retrying immediately.
    return seconds > 0 ? Math.min(seconds * 1000, 5 * 60_000) : fallbackMs;
  }
  // Only parse an HTTP-date form here. Date.parse("0"), for example, is
  // valid JavaScript but represents a stale date and would otherwise yield 0.
  if (/^[A-Za-z]{3},/.test(header)) {
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(fallbackMs, Math.min(Math.max(0, date - Date.now()), 5 * 60_000));
  }
  return fallbackMs;
}

async function lookupIsrc(isrc: string, onRetry: (message: string) => void): Promise<LookupResult> {
  // The ISRC lookup resource does not accept genre includes. Search the
  // recording index by its ISRC instead; MusicBrainz returns community tags
  // with the recording search result.
  const url = new URL("https://musicbrainz.org/ws/2/recording");
  url.searchParams.set("query", `isrc:${isrc}`);
  url.searchParams.set("fmt", "json");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await waitForSlot();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "SonicSort/1.0.0 (personal genre prototype)" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      const delay = Math.min(2_000 * (2 ** attempt), 30_000);
      console.warn(`[genre-lookup] MusicBrainz network error; retry ${attempt + 1}/${MAX_RETRIES} in ${Math.ceil(delay / 1000)}s`, error instanceof Error ? error.message : "unknown network error");
      onRetry(`MusicBrainz request timed out or had a network error; retry ${attempt + 1} of ${MAX_RETRIES} in about ${Math.ceil(delay / 1000)} seconds.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (response.status === 404) return { isrc, genres: [], found: false };
    if (response.status === 429 || response.status === 503 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      if (attempt === MAX_RETRIES) throw new Error("MusicBrainz is still unavailable after automatic retries. No tracks were added; restarting the genre sort later is safe.");
      const backoffMs = Math.min(30_000 * (2 ** attempt), 5 * 60_000);
      const waitMs = retryDelayMs(response.headers.get("Retry-After"), backoffMs);
      console.warn(`[genre-lookup] MusicBrainz HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${Math.ceil(waitMs / 1000)}s`);
      onRetry(`MusicBrainz returned ${response.status}; retry ${attempt + 1} of ${MAX_RETRIES} in about ${Math.ceil(waitMs / 1000)} seconds.`);
      await new Promise((resolve) => setTimeout(resolve, waitMs + Math.floor(Math.random() * 750)));
      continue;
    }
    if (!response.ok) {
      const details = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
      console.error(`[genre-lookup] MusicBrainz HTTP ${response.status}`, details || "(no response details)");
      throw new Error(`MusicBrainz returned HTTP ${response.status}${details ? `: ${details}` : "."}`);
    }

    const payload = await response.json() as { recordings?: MusicBrainzRecording[] };
    const names = new Map<string, { name: string; count: number }>();
    for (const recording of payload.recordings ?? []) {
      for (const item of [...(recording.genres ?? []), ...(recording.tags ?? [])]) {
        const name = item.name?.trim();
        if (!name) continue;
        const key = name.toLocaleLowerCase();
        const existing = names.get(key);
        names.set(key, { name: existing?.name ?? name, count: (existing?.count ?? 0) + (item.count ?? 1) });
      }
    }
    const genres = [...names.values()].sort((a, b) => b.count - a.count).map((item) => item.name).slice(0, 30);
    return { isrc, genres, found: Boolean(payload.recordings?.length) };
  }
  throw new Error("MusicBrainz lookup did not complete.");
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "Connect Spotify before looking up genres." }, { status: 401 });
  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
  if (origin && origin !== expectedOrigin) return NextResponse.json({ error: "Request origin could not be verified." }, { status: 403 });

  let isrcs: string[];
  let jobs: LookupJob[] = [];
  try {
    const body = await request.json();
      if (!Array.isArray(body.isrcs) && !Array.isArray(body.jobs)) throw new Error("ISRC list is invalid.");
    const rawJobs = Array.isArray(body.jobs) ? body.jobs : [];
    jobs = rawJobs.map((job: unknown) => {
      if (!job || typeof job !== "object") throw new Error("ISRC lookup job is invalid.");
      const candidate = job as Partial<LookupJob>;
        if (typeof candidate.isrc !== "string" || !Array.isArray(candidate.tracks)) throw new Error("ISRC lookup job is invalid.");
        const tracks = candidate.tracks.filter((track): track is LookupTrack => Boolean(
          track && typeof track === "object" &&
          typeof track.id === "string" && typeof track.name === "string" &&
          Array.isArray(track.artists) && track.artists.every((artist) => typeof artist === "string") &&
          typeof track.albumName === "string" &&
          (track.albumImageUrl === null || typeof track.albumImageUrl === "string")
        ));
        if (tracks.length > 100 || tracks.some((track) => !/^[A-Za-z0-9]{10,64}$/.test(track.id))) throw new Error("Spotify track metadata in an ISRC lookup job is invalid.");
        return { isrc: candidate.isrc.trim().toUpperCase(), tracks };
    });
      const inputIsrcs: unknown[] = Array.isArray(body.isrcs) ? body.isrcs : jobs.map((job) => job.isrc);
    const stringIsrcs: string[] = inputIsrcs.filter((item): item is string => typeof item === "string");
    isrcs = [...new Set(stringIsrcs.map((item: string) => item.trim().toUpperCase()))];
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "ISRC list is invalid." }, { status: 400 });
  }
  if (!isrcs.length || isrcs.length > MAX_LOOKUP_COUNT || isrcs.some((isrc) => !ISRC_PATTERN.test(isrc))) {
    return NextResponse.json({ error: `Send 1–${MAX_LOOKUP_COUNT} valid ISRC codes per lookup run.` }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let isClosed = false;
      const send = (event: string, payload: unknown) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          isClosed = true;
        }
      };
      const heartbeat = setInterval(() => send("heartbeat", { at: Date.now() }), 10_000);
      console.info(`[genre-lookup] Started ${isrcs.length} recording lookups`);
      try {
        for (let index = 0; index < isrcs.length; index += 1) {
          // A phone can suspend Chrome and close the progress stream. Continue
          // the server-side loop anyway: each result is saved to Mongo before
          // an event is sent, and a later run will reuse the completed cache.
          const job = jobs.find((entry) => entry.isrc.toUpperCase() === isrcs[index]) ?? { isrc: isrcs[index], tracks: [] };
          const result = await lookupIsrc(isrcs[index], (message) => send("progress", {
            current: index,
            total: isrcs.length,
            message,
          }));
          if (job.tracks.length) {
            const lookedUpAt = new Date().toISOString();
            await saveTrackGenres(job.tracks.map((track) => ({
              spotifyTrackId: track.id,
              isrc: result.isrc,
              genres: result.genres,
              source: "musicbrainz" as const,
              lookedUpAt,
              trackName: track.name,
              artistNames: track.artists,
              albumName: track.albumName,
              albumImageUrl: track.albumImageUrl,
            })));
          }
          send("result", result);
          send("progress", {
            current: index + 1,
            total: isrcs.length,
            message: `Looked up ${index + 1} of ${isrcs.length} recordings…`,
          });
          if ((index + 1) % 25 === 0 || index + 1 === isrcs.length) {
            console.info(`[genre-lookup] Completed ${index + 1}/${isrcs.length} recording lookups`);
          }
        }
        send("complete", { total: isrcs.length });
      } catch (error) {
        console.error("[genre-lookup] Lookup run failed", error instanceof Error ? error.message : "unknown error");
        send("failure", { error: error instanceof Error ? error.message : "MusicBrainz lookup failed." });
      } finally {
        clearInterval(heartbeat);
        if (!isClosed) {
          try { controller.close(); } catch { /* client may have closed the stream */ }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
