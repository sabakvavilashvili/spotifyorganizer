"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  AudioLines,
  Check,
  CheckCircle2,
  Database,
  Disc3,
  ExternalLink,
  Headphones,
  LoaderCircle,
  LogOut,
  Music2,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Waves,
  X,
} from "lucide-react";
import { CATEGORY_LABELS, STARTER_CRITERIA } from "@/lib/catalog";
import type { Criterion, SpotifyTrack } from "@/lib/types";
import SpotifyTrackPreview from "@/components/SpotifyTrackPreview";

type SessionState = { connected: boolean; user?: { id: string; displayName: string; image?: string }; error?: string };
type Result = { id: string; name: string; playlistName: string; url: string; matched: number; added: number };
type OrganizeResult = { scanned: number; playlistCount: number; added: number; results: Result[] };
type Progress = { stage: string; message: string; current?: number; total?: number };
type ReviewSession = {
  criterion: Criterion;
  playlist: { id: string; name: string; url: string };
  tracks: SpotifyTrack[];
  index: number;
  approvedUris: string[];
  rejected: number;
  phase: "review" | "done";
  saving?: boolean;
};
type DecisionLogEntry = { uri: string; criterion: string; decision: "approved" | "skipped"; reviewedAt: string };
type GenreProgress = { current: number; total: number; message: string; likedSongs?: number; analyzedTracks?: number };

const REVIEW_LOG_KEY = "sonicsort:review-log:v1";

const FILTERS = ["all", "genre", "mood", "activity", "tempo", "custom"] as const;
const CATEGORY_ICONS = { genre: Disc3, mood: Waves, activity: Headphones, tempo: AudioLines, custom: Sparkles };

export default function Home() {
  const [criteria, setCriteria] = useState<Criterion[]>(STARTER_CRITERIA);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [session, setSession] = useState<SessionState>({ connected: false });
  const [loadingSession, setLoadingSession] = useState(true);
  const [running, setRunning] = useState(false);
  const [genreRunning, setGenreRunning] = useState(false);
  const [genreProgress, setGenreProgress] = useState<GenreProgress | null>(null);
  const [selectedGenreIds, setSelectedGenreIds] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<ReviewSession | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<OrganizeResult | null>(null);
  const [decisionLog, setDecisionLog] = useState<DecisionLogEntry[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customCategory, setCustomCategory] = useState<Criterion["category"]>("custom");
  const [search, setSearch] = useState("");
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get("error");
    if (oauthError) {
      setError(oauthError);
      window.history.replaceState({}, "", window.location.pathname);
    }
    fetch("/api/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: SessionState) => setSession(data))
      .catch(() => setSession({ connected: false }))
      .finally(() => setLoadingSession(false));
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REVIEW_LOG_KEY);
      if (saved) setDecisionLog(JSON.parse(saved) as DecisionLogEntry[]);
    } catch {
      try { localStorage.removeItem(REVIEW_LOG_KEY); } catch { /* browser storage may be disabled */ }
    }
  }, []);

  const visibleCriteria = useMemo(() => criteria.filter((item) => {
    const matchesFilter = filter === "all" || item.category === filter;
    const query = search.trim().toLowerCase();
    return matchesFilter && (!query || item.name.toLowerCase().includes(query));
  }), [criteria, filter, search]);

  const selectedGenres = criteria.filter((item) => item.category === "genre" && selectedGenreIds.has(item.id));

  function toggleGenre(id: string) {
    setSelectedGenreIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function normalizeGenre(value: string) {
    return value.normalize("NFKD").toLocaleLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  }

  function genreTagMatches(tag: string, selectedGenre: string) {
    const normalizedTag = normalizeGenre(tag);
    const normalizedGenre = normalizeGenre(selectedGenre);
    return normalizedTag === normalizedGenre || normalizedTag.startsWith(`${normalizedGenre} `) || normalizedTag.endsWith(` ${normalizedGenre}`);
  }

  async function sortSelectedGenres() {
    if (!session.connected || !selectedGenres.length || genreRunning || running || review) return;
    setGenreRunning(true);
    setError("");
    setNotice("");
    setResult(null);
    try {
      setGenreProgress({ current: 0, total: 0, message: "Preparing private genre playlists and loading your Liked Songs…" });
      const startResponse = await fetch("/api/genre/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ genres: selectedGenres.map(({ id, name }) => ({ id, name })) }),
      });
      const startData = await startResponse.json().catch(() => ({}));
      if (!startResponse.ok) throw new Error(startData.error ?? "Could not prepare genre sorting.");

      const tracks = startData.tracks as Array<SpotifyTrack & { isrc?: string | null }>;
      const libraryStats = startData.libraryStats as { savedItems: number; usableTracks: number; localTracks: number; unavailableItems: number; tracksWithoutIsrc: number } | undefined;
      const tagsByIsrc = new Map<string, string[]>();
      const tracksByIsrc = new Map<string, string[]>();
      for (const track of tracks) {
        const isrc = track.isrc?.trim().toUpperCase();
        if (!isrc) continue;
        const ids = tracksByIsrc.get(isrc) ?? [];
        ids.push(track.id);
        tracksByIsrc.set(isrc, ids);
      }

      const cacheResponse = await fetch("/api/genre/cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks }),
      });
      const cacheData = await cacheResponse.json().catch(() => ({}));
      if (!cacheResponse.ok) throw new Error(cacheData.error ?? "Could not read the saved genre database.");
      const cachedRows = cacheData.rows as Array<{ spotifyTrackId: string; isrc: string | null; genres: string[] }>;
      const cachedTrackIds = new Set(cachedRows.map((row) => row.spotifyTrackId));
      for (const row of cachedRows) {
        if (row.isrc && row.genres.length) tagsByIsrc.set(row.isrc.toUpperCase(), row.genres);
      }

      const lookupJobs = [...tracksByIsrc.entries()]
        .map(([isrc, spotifyTrackIds]) => ({
          isrc,
          tracks: tracks.filter((track) => track.isrc?.trim().toUpperCase() === isrc && !cachedTrackIds.has(track.id)).map((track) => ({
            id: track.id,
            name: track.name,
            artists: track.artists?.map((artist) => artist.name) ?? [],
            albumName: track.album?.name ?? "",
            albumImageUrl: track.album?.images?.[0]?.url ?? null,
          })),
        }))
        .filter((job) => job.tracks.length > 0);
      const tracksWithoutIsrc = tracks.filter((track) => !track.isrc?.trim()).length;
      const uniqueIsrcCount = tracksByIsrc.size;
      setGenreProgress({
        current: 0,
        total: lookupJobs.length,
        likedSongs: libraryStats?.savedItems ?? tracks.length,
        analyzedTracks: cachedTrackIds.size,
        message: `Spotify returned ${libraryStats?.savedItems ?? tracks.length} saved items; sorting ${tracks.length} usable tracks${libraryStats?.localTracks ? `, skipped ${libraryStats.localTracks} local` : ""}${libraryStats?.unavailableItems ? ` and ${libraryStats.unavailableItems} unavailable` : ""}. ${cachedRows.length} mappings cached; ${lookupJobs.length} unique ISRCs need lookup${tracksWithoutIsrc ? ` (${tracksWithoutIsrc} tracks have no ISRC)` : ""}.`,
      });

      if (lookupJobs.length) {
        try {
          const response = await fetch("/api/genre/lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobs: lookupJobs }),
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error ?? "MusicBrainz lookup failed.");
          }
          if (!response.body) throw new Error("Genre lookup progress is unavailable in this browser.");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let completed = false;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split("\n\n");
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const eventName = block.match(/^event: (.+)$/m)?.[1];
              const dataLine = block.match(/^data: (.+)$/m)?.[1];
              if (!eventName || !dataLine) continue;
              if (eventName === "heartbeat") continue;
              const payload = JSON.parse(dataLine);
              if (eventName === "result") {
                const lookup = payload as { isrc: string; genres: string[] };
                tagsByIsrc.set(lookup.isrc, lookup.genres);
              } else if (eventName === "progress") {
                const update = payload as GenreProgress;
                setGenreProgress((current) => ({
                  ...current,
                  ...update,
                  total: lookupJobs.length,
                  message: `${update.message} Requests are paced automatically.`,
                }));
              } else if (eventName === "failure") {
                throw new Error((payload as { error?: string }).error ?? "MusicBrainz lookup failed.");
              } else if (eventName === "complete") {
                completed = true;
              }
            }
          }
          if (!completed) throw new Error("The progress connection ended before reporting completion. The server continues saving completed lookups; when it finishes, run genre sorting again to apply cached matches to Spotify playlists.");
        } catch (caught) {
          if (caught instanceof TypeError) {
            throw new Error("Chrome interrupted the lookup progress connection. The server keeps processing and saving results; once it finishes, run genre sorting again to reuse the saved lookups.");
          }
          throw caught;
        }
      }

      const destinations = startData.destinations as Array<{ id: string; name: string; playlistId: string; playlistName: string; url: string }>;
      const existingByPlaylist = startData.existingByPlaylist as Record<string, string[]>;
      const urisByGenre = new Map(destinations.map((destination) => [destination.id, new Set(existingByPlaylist[destination.id] ?? [])]));
      let tracksWithIsrc = 0;
      let genreTaggedTracks = 0;
      let matchedTracks = 0;
      for (const track of tracks) {
        const isrc = track.isrc?.trim().toUpperCase();
        if (!isrc) continue;
        tracksWithIsrc += 1;
        const tags = tagsByIsrc.get(isrc) ?? [];
        if (tags.length) genreTaggedTracks += 1;
        const matched = selectedGenres.filter((criterion) => tags.some((tag) => genreTagMatches(tag, criterion.name)));
        if (matched.length) matchedTracks += 1;
        for (const criterion of matched) urisByGenre.get(criterion.id)?.add(track.uri);
      }

      setGenreProgress({ current: lookupJobs.length, total: lookupJobs.length, message: `Found genre matches for ${matchedTracks} songs. Adding them to your selected playlists…` });
      const commitResponse = await fetch("/api/genre/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinations: destinations.map((destination) => ({
          id: destination.id,
          playlistId: destination.playlistId,
          uris: [...(urisByGenre.get(destination.id) ?? new Set<string>())],
        })) }),
      });
      const commitData = await commitResponse.json().catch(() => ({}));
      if (!commitResponse.ok) throw new Error(commitData.error ?? "Could not add genre matches to Spotify.");

      const totalAdded = commitData.added as number;
      setResult({
        scanned: tracks.length,
        playlistCount: destinations.length,
        added: totalAdded,
        results: (commitData.results as Array<{ id: string; playlistName: string; url: string; matched: number; added: number }>).map((item) => ({
          id: item.id,
          name: selectedGenres.find((genre) => genre.id === item.id)?.name ?? item.playlistName,
          playlistName: item.playlistName,
          url: item.url,
          matched: item.matched,
          added: item.added,
        })),
      });
      setNotice(`Genre sorting complete: ${totalAdded} new tracks added. ${tracks.length - tracksWithIsrc} tracks had no ISRC; ${tracksWithIsrc - genreTaggedTracks} ISRCs had no MusicBrainz genre tags.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Genre sorting failed.");
    } finally {
      setGenreRunning(false);
      setGenreProgress(null);
    }
  }

  function addCustomCriterion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = customName.trim();
    if (!name) return;
    if (criteria.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      setError("A criterion with that name already exists.");
      return;
    }
    const id = `custom-${crypto.randomUUID()}`;
    const newCriterion: Criterion = { id, name, category: customCategory };
    setCriteria((current) => [...current, newCriterion]);
    setCustomName("");
    setCustomOpen(false);
    setFilter("all");
    setNotice(`“${name}” is ready to organize.`);
    setTimeout(() => setNotice(""), 3500);
  }

  async function startReview(criterion: Criterion) {
    if (!session.connected || running || review) return;
    setRunning(true);
    setError("");
    setNotice("");
    setResult(null);
    setProgress({ stage: "start", message: `Preparing “${criterion.name}”…` });
    try {
      const response = await fetch("/api/review/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: criterion.name }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not prepare the review.");
      }
      const data = await response.json();
      setReview({ criterion, playlist: data.playlist, tracks: data.tracks, index: 0, approvedUris: [], rejected: 0, phase: data.tracks.length ? "review" : "done" });
      if (!data.tracks.length) setNotice("No unreviewed tracks found for this criterion. Its playlist is ready in Spotify.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare the review.");
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  function decideTrack(approve: boolean) {
    if (!review || review.phase !== "review" || review.saving) return;
    const track = review.tracks[review.index];
    if (track) {
      const entry: DecisionLogEntry = {
        uri: track.uri,
        criterion: review.criterion.name,
        decision: approve ? "approved" : "skipped",
        reviewedAt: new Date().toISOString(),
      };
      const nextLog = [...decisionLog, entry].slice(-5000);
      setDecisionLog(nextLog);
      try { localStorage.setItem(REVIEW_LOG_KEY, JSON.stringify(nextLog)); } catch { /* browser storage may be disabled */ }
    }
    const nextIndex = review.index + 1;
    setReview({
      ...review,
      index: nextIndex,
      approvedUris: approve && track ? [...review.approvedUris, track.uri] : review.approvedUris,
      rejected: approve ? review.rejected : review.rejected + 1,
      phase: nextIndex >= review.tracks.length ? "done" : "review",
    });
  }

  async function saveReview() {
    if (!review || review.saving) return;
    if (!review.approvedUris.length) {
      setReview(null);
      setNotice("Review finished. No tracks were approved for the playlist.");
      return;
    }
    setReview((current) => current ? { ...current, saving: true } : current);
    setError("");
    try {
      const response = await fetch("/api/review/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: review.playlist.id, uris: review.approvedUris }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not save your approved tracks.");
      setResult({
        scanned: review.tracks.length,
        playlistCount: 1,
        added: data.added,
        results: [{ id: review.criterion.id, name: review.criterion.name, playlistName: data.playlist.name, url: data.playlist.url, matched: review.approvedUris.length, added: data.added }],
      });
      setNotice(`Review complete — ${data.added} approved ${data.added === 1 ? "track was" : "tracks were"} added.`);
      setReview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save your approved tracks.");
      setReview((current) => current ? { ...current, saving: false } : current);
    }
  }

  function cancelReview() {
    setReview(null);
    setNotice("Review closed. Unsubmitted choices were discarded.");
  }

  function clearDecisionLog() {
    setDecisionLog([]);
    try { localStorage.removeItem(REVIEW_LOG_KEY); } catch { /* browser storage may be disabled */ }
    setNotice("Your local review history was cleared.");
  }

  useEffect(() => {
    if (!review || review.phase !== "review") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if ((event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      decideTrack(event.key === "ArrowRight");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [review]);

  function handleTrackTouchEnd(event: React.TouchEvent<HTMLElement>) {
    if (touchStartX.current === null) return;
    const distance = event.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(distance) < 70) return;
    decideTrack(distance > 0);
  }

  async function disconnect() {
    await fetch("/api/auth/logout", { method: "POST" });
    setSession({ connected: false });
    setResult(null);
    setReview(null);
    setNotice("Spotify disconnected.");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Sonic Sort home">
          <span className="brand-mark"><AudioLines size={21} strokeWidth={2.2} /></span>
          <span>sonic<span className="brand-light">sort</span><small>YOUR MUSIC, IN ORDER</small></span>
        </a>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="side-nav-item active" href="#organize"><Settings2 size={18} /><span>Organizer</span><span className="nav-dot" /></a>
          <a className="side-nav-item" href="#rules"><Disc3 size={18} /><span>Criteria</span><span className="side-count">{criteria.length}</span></a>
          <a className="side-nav-item" href="/genres"><Database size={18} /><span>Genre database</span><ArrowRight size={14} className="catalog-nav-arrow" /></a>
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note"><span className="privacy-dot" /><span>Your playlists stay private.</span></div>
        </div>
      </aside>

      <section className="main-area" id="top">
        <header className="topbar">
          <div className="breadcrumb"><strong>Your music</strong></div>
          <div className="topbar-right">
            {session.connected && <span className="secure-label"><span className="secure-dot" /> PRIVATE PLAYLISTS</span>}
            {session.connected ? (
              <div className="account-control">
                {session.user?.image ? <img className="avatar" src={session.user.image} alt="" /> : <span className="avatar avatar-fallback">{session.user?.displayName?.slice(0, 1) ?? "S"}</span>}
                <span className="account-name">{session.user?.displayName}</span>
                <button className="icon-button" onClick={disconnect} title="Disconnect Spotify" aria-label="Disconnect Spotify"><LogOut size={16} /></button>
              </div>
            ) : <a className="top-connect" href="/api/auth/login">Connect Spotify <ArrowRight size={15} /></a>}
          </div>
        </header>

        <div className="content-wrap" id="organize">
          <section className="hero-section">
            <div className="hero-copy">
              <h1>Your music,<br /><span>your way.</span></h1>
              <p>Sort by genre or choose where each song belongs.</p>
              <div className="hero-actions">
                {!session.connected ? (
                  <a className="primary-button connect-button" href="/api/auth/login"><span className="spotify-symbol">●</span> Connect with Spotify <ArrowRight size={17} /></a>
                ) : (
                  <button className="primary-button" onClick={() => document.getElementById("criteria-list")?.scrollIntoView({ behavior: "smooth" })} disabled={running || Boolean(review)}>
                    <Sparkles size={17} /> Choose a criterion to review <ArrowRight size={17} />
                  </button>
                )}
                <span className="hero-microcopy">{session.connected ? "Your liked songs stay untouched" : "Private and secure"}</span>
              </div>
            </div>
            <div className="hero-art" aria-label="Abstract sound wave artwork">
              <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
              <div className="art-disc"><div className="disc-groove groove-one" /><div className="disc-groove groove-two" /><div className="disc-groove groove-three" /><div className="disc-center"><AudioLines size={27} /></div></div>
              <div className="art-label label-one"><span className="label-dot lime" /> YOUR TASTE, SORTED</div>
              <div className="art-label label-two">SIDE A <span>✳</span> SIDE B</div>
              <div className="art-spark spark-one">✳</div><div className="art-spark spark-two">✳</div>
            </div>
          </section>

          <section className="stats-strip" aria-label="Organizer overview">
          </section>

          {error && <div className="message-banner error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={16} /></button></div>}
          {notice && !error && <div className="message-banner success-banner" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss"><X size={16} /></button></div>}

          {running && progress && (
            <div className="progress-panel" role="status">
              <div className="progress-spinner"><LoaderCircle size={19} className="spin" /></div>
              <div className="progress-copy"><strong>{progress.message}</strong><span>REVIEW</span></div>
              {progress.current && progress.total ? <span className="progress-count">{progress.current} / {progress.total}</span> : <span className="progress-pulse" />}
            </div>
          )}

          {genreRunning && genreProgress && (
            <div className="progress-panel genre-progress-panel" role="status">
              <div className="progress-spinner"><LoaderCircle size={19} className="spin" /></div>
              <div className="progress-copy">
                <strong>{genreProgress.message}</strong>
                <span>{genreProgress.likedSongs !== undefined ? `${genreProgress.likedSongs} Liked Songs · ${genreProgress.analyzedTracks ?? 0} already analyzed · ${genreProgress.total} unique ISRC lookups` : "Loading your Liked Songs"}</span>
              </div>
              {genreProgress.total > 0 ? <span className="progress-count">{genreProgress.current} / {genreProgress.total} ISRCs</span> : <span className="progress-pulse" />}
            </div>
          )}

          {!session.connected && !loadingSession && (
            <div className="connect-notice"><div className="connect-notice-icon"><Headphones size={20} /></div><div><strong>Your playlists are waiting.</strong><p>Connect Spotify to scan Liked Songs and create real, private playlists in your account.</p></div><a href="/api/auth/login">Connect account <ArrowRight size={15} /></a></div>
          )}

          <section className="rules-section" id="rules">
            <div className="section-heading">
              <div><h2>Your playlists</h2><p>Choose genres to sort automatically, or review songs one by one.</p></div>
              <button className="outline-button" onClick={() => setCustomOpen((open) => !open)}><Plus size={16} /> New playlist</button>
            </div>

            {customOpen && (
              <form className="custom-form" onSubmit={addCustomCriterion}>
                <div className="custom-form-heading"><div><Sparkles size={17} /><strong>Create a playlist</strong></div><button type="button" className="icon-button" onClick={() => setCustomOpen(false)} aria-label="Close"><X size={17} /></button></div>
                <div className="custom-fields">
                  <label>PLAYLIST NAME<input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="e.g. Ski day" maxLength={60} required /></label>
                  <label>TYPE<select value={customCategory} onChange={(event) => setCustomCategory(event.target.value as Criterion["category"])}><option value="custom">Custom</option><option value="genre">Genre</option><option value="mood">Mood</option><option value="activity">Activity</option><option value="tempo">Tempo</option></select></label>
                </div>
                <div className="custom-form-footer"><span>You’ll review songs one at a time.</span><button className="mini-primary" type="submit">Create playlist <ArrowRight size={14} /></button></div>
              </form>
            )}

            <div className="criteria-toolbar" id="criteria-list">
              <div className="filter-tabs" role="tablist" aria-label="Filter rules">
                {FILTERS.map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? "filter-tab selected" : "filter-tab"} onClick={() => setFilter(item)}>{item === "all" ? "All" : CATEGORY_LABELS[item]}</button>)}
              </div>
              <label className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search playlists" /></label>
            </div>

            {criteria.some((item) => item.category === "genre") && (
              <div className="genre-sort-panel">
                <div className="genre-sort-copy"><span className="genre-sort-icon"><Disc3 size={17} /></span><span><strong>Automatic genre sorting</strong><small>Select one or more genres. A song can match multiple playlists.</small></span></div>
                <button className="primary-button genre-sort-button" onClick={sortSelectedGenres} disabled={!session.connected || !selectedGenres.length || genreRunning || running || Boolean(review)}>
                  {genreRunning ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
                  {genreRunning ? "Sorting genres…" : `Sort ${selectedGenres.length || "selected"} genre${selectedGenres.length === 1 ? "" : "s"}`}
                  {!genreRunning && <ArrowRight size={15} />}
                </button>
              </div>
            )}
            {criteria.some((item) => item.category === "genre") && <div className="genre-attribution">Genre information from <a href="https://musicbrainz.org/" target="_blank" rel="noreferrer">MusicBrainz</a>.</div>}

            <div className="criteria-grid">
              {visibleCriteria.map((criterion, index) => {
                const Icon = CATEGORY_ICONS[criterion.category];
                return <article className="criterion-card" key={criterion.id} style={{ "--card-index": index } as React.CSSProperties}>
                  <div className={`criterion-icon ${criterion.category}`}><Icon size={17} strokeWidth={1.8} /></div>
                  <div className="criterion-info"><span className="criterion-category">{CATEGORY_LABELS[criterion.category]}</span><h3>{criterion.name}</h3><div className="keyword-list">{criterion.category === "genre" ? <span>Automatic</span> : <span>Review songs</span>}</div></div>
                  {criterion.category === "genre" ? <button className={`genre-select-button ${selectedGenreIds.has(criterion.id) ? "selected" : ""}`} type="button" aria-pressed={selectedGenreIds.has(criterion.id)} onClick={() => toggleGenre(criterion.id)}>{selectedGenreIds.has(criterion.id) ? <Check size={14} /> : <Plus size={14} />}{selectedGenreIds.has(criterion.id) ? "Selected" : "Select"}</button> : <button className="review-criterion-button" disabled={!session.connected || running || genreRunning || Boolean(review)} onClick={() => startReview(criterion)}>{running ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />} Review</button>}
                </article>;
              })}
              {visibleCriteria.length === 0 && <div className="empty-results">No rules found. Try another search or add your own.</div>}
            </div>

            <div className="rules-footer"><span><span className="live-dot" /> {criteria.length} playlists</span><span className="rules-hint">Your choices are added when you finish</span></div>
          </section>

          {review && (
            <section className="review-section" aria-labelledby="review-heading">
              <div className="review-heading-row"><div><h2 id="review-heading">Add this song to {review.criterion.name}?</h2><p>Your approved songs are added when you finish.</p></div><button className="icon-button" onClick={cancelReview} aria-label="Close review"><X size={18} /></button></div>
              {review.phase === "review" && review.tracks[review.index] ? (() => {
                const track = review.tracks[review.index];
                const image = track.album.images?.[0]?.url;
                const progressRatio = ((review.index + 1) / review.tracks.length) * 100;
                return <div className="review-card" onTouchStart={(event) => { touchStartX.current = event.touches[0].clientX; }} onTouchEnd={handleTrackTouchEnd}>
                  <div className="review-progress-meta"><span>TRACK {review.index + 1} OF {review.tracks.length}</span><span>{review.approvedUris.length} approved · {review.rejected} skipped</span></div>
                  <div className="review-progress-track"><span style={{ width: `${progressRatio}%` }} /></div>
                  <div className="track-preview">
                    {image ? <img src={image} alt="" className="track-artwork" /> : <div className="track-artwork artwork-placeholder"><Music2 size={29} /></div>}
                    <div className="track-metadata"><h3>{track.name}</h3><p>{track.artists.map((artist) => artist.name).join(", ")}</p><small>{track.album.name}</small></div>
                  </div>
                  <SpotifyTrackPreview key={track.uri} uri={track.uri} />
                  <div className="review-actions"><button className="decision-button reject" onClick={() => decideTrack(false)} aria-label="No, skip this song"><X size={20} /><span>SKIP</span><kbd>←</kbd></button><a className="track-open-link" href={track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`} target="_blank" rel="noreferrer">Open in Spotify <ExternalLink size={13} /></a><button className="decision-button approve" onClick={() => decideTrack(true)} aria-label="Yes, add this song"><Check size={20} /><span>ADD</span><kbd>→</kbd></button></div>
                </div>;
              })() : (
                <div className="review-finished"><span className="review-finished-icon"><CheckCircle2 size={24} /></span><h3>{review.index >= review.tracks.length ? "That’s the whole stack." : "Finish this review?"}</h3><p>{review.approvedUris.length} approved · {review.rejected} skipped · {Math.max(0, review.tracks.length - review.index)} not reviewed.</p><div className="review-finished-actions"><button className="outline-button" onClick={cancelReview}>Discard review</button><button className="primary-button" onClick={saveReview} disabled={review.saving}>{review.saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{review.saving ? "Saving to Spotify…" : `Finish & add ${review.approvedUris.length} songs`}</button></div></div>
              )}
              {review.phase === "review" && <div className="review-session-footer"><span>Destination: <strong>{review.playlist.name}</strong></span><button onClick={() => setReview((current) => current ? { ...current, phase: "done" } : current)}>Finish with reviewed songs</button></div>}
            </section>
          )}

          <section className="results-section">
            <div className="results-heading"><div><h2>Recently sorted</h2></div>{result && <span className="result-status"><span className="live-dot" />Done</span>}</div>
            {result ? <div className="results-list">{result.results.map((item) => <a className="result-row" href={item.url} target="_blank" rel="noreferrer" key={item.id}><span className="result-disc"><Music2 size={16} /></span><span className="result-title"><strong>{item.playlistName}</strong><small>{item.added} new {item.added === 1 ? "song" : "songs"}</small></span><span className="result-added">+{item.added}</span><ExternalLink size={15} className="result-link" /></a>)}</div> : <div className="empty-session"><span>Playlists you sort will appear here.</span></div>}
          </section>

          <details className="decision-log-section">
            <summary><span>Review history</span><span>{decisionLog.length} choices</span></summary>
            <div className="log-controls">{decisionLog.length > 0 && <button className="text-button" onClick={clearDecisionLog}>Clear</button>}</div>
            {decisionLog.length ? <div className="decision-log-list">{[...decisionLog].slice(-6).reverse().map((entry, index) => {
              const trackId = entry.uri.split(":").at(-1);
              return <div className="decision-log-row" key={`${entry.uri}-${entry.reviewedAt}-${index}`}><span className={`decision-log-mark ${entry.decision}`}>{entry.decision === "approved" ? <Check size={13} /> : <X size={13} />}</span><span><strong>{entry.criterion}</strong><small>{entry.decision === "approved" ? "Approved" : "Skipped"} · {new Date(entry.reviewedAt).toLocaleString()}</small></span>{trackId && <a href={`https://open.spotify.com/track/${trackId}`} target="_blank" rel="noreferrer" aria-label="Open reviewed track in Spotify"><ExternalLink size={14} /></a>}</div>;
            })}</div> : <div className="empty-log">Your song choices will appear here.</div>}
          </details>

          <footer className="footer-note"><span>SONIC SORT</span><span>Your playlists stay yours.</span></footer>
        </div>
      </section>
    </main>
  );
}
