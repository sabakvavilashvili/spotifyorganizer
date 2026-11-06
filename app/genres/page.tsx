"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowLeftRight, ArrowRight, Database, ExternalLink, LoaderCircle, RefreshCw, Search, Tag, X } from "lucide-react";

type GenreRow = {
  spotifyTrackId: string;
  isrc: string | null;
  genres: string[];
  source: string;
  lookedUpAt: string;
  trackName?: string | null;
  artistNames?: string[];
  albumName?: string | null;
  albumImageUrl?: string | null;
};

type CatalogResponse = {
  rows: GenreRow[];
  total: number;
  page: number;
  pageSize: number;
  genreOptions: string[];
  totalGenres: number;
  storage?: "local" | "mongodb";
};

export default function GenreCatalogPage() {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [search, setSearch] = useState("");
  const [genre, setGenre] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshingMetadata, setRefreshingMetadata] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadCatalog = useCallback(async (nextPage: number, query: string, selectedGenre: string) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ page: String(nextPage), pageSize: "50" });
    if (query.trim()) params.set("q", query.trim());
    if (selectedGenre) params.set("genre", selectedGenre);
    try {
      const response = await fetch(`/api/genre/catalog?${params}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not load the genre database.");
      setData(payload as CatalogResponse);
    } catch (caught) {
      setData(null);
      setError(caught instanceof Error ? caught.message : "Could not load the genre database.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => loadCatalog(page, search, genre), search ? 300 : 0);
    return () => window.clearTimeout(timeout);
  }, [loadCatalog, page, search, genre]);

  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const firstItem = data?.total ? (page - 1) * (data?.pageSize ?? 50) + 1 : 0;
  const lastItem = Math.min(page * (data?.pageSize ?? 50), data?.total ?? 0);
  const activeFilters = useMemo(() => Number(Boolean(search.trim())) + Number(Boolean(genre)), [search, genre]);

  function updateSearch(value: string) {
    setPage(1);
    setSearch(value);
  }

  function updateGenre(value: string) {
    setPage(1);
    setGenre(value);
  }

  async function refreshSpotifyMetadata() {
    setRefreshingMetadata(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/genre/catalog/refresh-metadata", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not refresh Spotify track metadata.");
      setNotice(`Updated names and cover art for ${payload.updated} catalog tracks from ${payload.libraryTracks} Liked Songs.`);
      await loadCatalog(page, search, genre);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not refresh Spotify track metadata.");
    } finally {
      setRefreshingMetadata(false);
    }
  }

  return (
    <main className="catalog-shell">
      <header className="catalog-topbar">
        <Link href="/" className="catalog-back"><ArrowLeft size={16} /> Organizer</Link>
        <span className="catalog-brand"><span className="brand-mark"><Database size={17} /></span> GENRE CATALOG</span>
      </header>
      <section className="catalog-content">
        <div className="catalog-eyebrow"><span /> {data?.storage === "mongodb" ? "MONGODB MUSICBRAINZ MAPPING CATALOG" : "LOCAL MUSICBRAINZ MAPPING CATALOG"}</div>
        <div className="catalog-title-row">
          <div>
            <h1>Genre database<span>.</span></h1>
            <p>Browse Spotify track IDs and the MusicBrainz genre tags already looked up.</p>
          </div>
          <div className="catalog-count-card"><Database size={17} /><strong>{data?.total.toLocaleString() ?? "—"}</strong><small>TRACK MAPPINGS</small></div>
        </div>

        <div className="catalog-stats">
          <div><span className="catalog-stat-icon"><Tag size={15} /></span><span><strong>{data?.totalGenres.toLocaleString() ?? "—"}</strong><small>DISTINCT TAGS</small></span></div>
          <div><span className="catalog-stat-icon catalog-stat-violet"><ArrowLeftRight size={15} /></span><span><strong>Spotify ID → MusicBrainz tags</strong><small>CATALOG MAPPING</small></span></div>
          <div className="catalog-source-note">Results are cached from completed lookups. Empty tags mean MusicBrainz returned no tags.</div>
        </div>

        <div className="catalog-metadata-toolbar">
          <div><strong>Spotify display details</strong><span>Refresh titles, artists and artwork for tracks already in this catalog.</span></div>
          <button onClick={refreshSpotifyMetadata} disabled={refreshingMetadata || loading}>
            {refreshingMetadata ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            {refreshingMetadata ? "Refreshing…" : "Refresh from Liked Songs"}
          </button>
        </div>
        {notice && <div className="catalog-notice" role="status">{notice}</div>}

        <section className="catalog-panel">
          <div className="catalog-toolbar">
            <label className="catalog-search"><Search size={16} /><input value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="Search Spotify ID, ISRC, or genre" /><span>⌘ F</span></label>
            <select className="catalog-genre-filter" value={genre} onChange={(event) => updateGenre(event.target.value)} aria-label="Filter by genre">
              <option value="">All genres</option>
              {data?.genreOptions.map((option) => <option value={option} key={option}>{option}</option>)}
            </select>
            {activeFilters > 0 && <button className="catalog-clear" onClick={() => { setSearch(""); setGenre(""); setPage(1); }}><X size={14} /> Clear</button>}
          </div>

          {error ? (
            <div className="catalog-state catalog-error" role="alert">
              <span className="catalog-state-icon"><Database size={21} /></span>
              <h2>Couldn’t load the catalog</h2>
              <p>{error}</p>
              {error.includes("MONGODB_URI") && <p className="catalog-setup-hint">Configure MONGODB_URI in .env.local, migrate your existing SQLite mappings if desired, then restart the app.</p>}
              <button className="catalog-retry" onClick={() => loadCatalog(page, search, genre)}>Try again <ArrowRight size={14} /></button>
            </div>
          ) : loading && !data ? (
            <div className="catalog-state"><LoaderCircle size={23} className="spin" /><p>Connecting to the genre catalog…</p></div>
          ) : data?.rows.length ? (
            <>
              <div className="catalog-table-wrap">
                <table className="catalog-table">
                  <thead><tr><th>TRACK NAME</th><th>SPOTIFY TRACK ID</th><th>ISRC</th><th>MUSICBRAINZ GENRES</th><th>LOOKED UP</th><th /></tr></thead>
                  <tbody>
                    {data.rows.map((row) => <tr key={row.spotifyTrackId}>
                      <td><a className="catalog-track-link" href={`https://open.spotify.com/track/${row.spotifyTrackId}`} target="_blank" rel="noreferrer">{row.albumImageUrl ? <img className="catalog-artwork" src={row.albumImageUrl} alt="" loading="lazy" /> : <span className="catalog-track-disc"><Database size={15} /></span>}<span className="catalog-track-copy"><strong>{row.trackName || "Spotify title not cached"}</strong><small>{row.artistNames?.length ? row.artistNames.join(", ") : `ID ${row.spotifyTrackId}`}{row.albumName ? ` · ${row.albumName}` : ""}</small></span></a></td>
                      <td><a className="catalog-isrc catalog-spotify-id" href={`https://open.spotify.com/track/${row.spotifyTrackId}`} target="_blank" rel="noreferrer">{row.spotifyTrackId}</a></td>
                      <td><span className="catalog-isrc">{row.isrc ?? "—"}</span></td>
                      <td>{row.genres.length ? <div className="catalog-tags">{row.genres.map((tag) => <span className="catalog-tag" key={tag}>{tag}</span>)}</div> : <span className="catalog-no-tags">No tags returned</span>}</td>
                      <td><span className="catalog-date">{new Date(row.lookedUpAt).toLocaleDateString()}<small>{new Date(row.lookedUpAt).toLocaleTimeString()}</small></span></td>
                      <td><a className="catalog-open" href={`https://open.spotify.com/track/${row.spotifyTrackId}`} target="_blank" rel="noreferrer" aria-label="Open track in Spotify"><ExternalLink size={15} /></a></td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
              <div className="catalog-pagination">
                <span>Showing <strong>{firstItem}–{lastItem}</strong> of <strong>{data.total.toLocaleString()}</strong> tracks</span>
                <div><button onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || loading}><ArrowLeft size={14} /> Previous</button><span>PAGE {page} / {pageCount}</span><button onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount || loading}>Next <ArrowRight size={14} /></button></div>
              </div>
            </>
          ) : (
            <div className="catalog-state"><span className="catalog-state-icon"><Search size={21} /></span><h2>{data?.total ? "No matching tracks" : "No genre mappings yet"}</h2><p>{data?.total ? "Try a different search or remove the genre filter." : "Run automatic genre sorting to populate this catalog with MusicBrainz tags."}</p></div>
          )}
          {loading && data && <div className="catalog-loading-bar"><span /></div>}
        </section>
        <footer className="catalog-footer"><span>SONIC SORT <span>✳</span> GENRE CATALOG</span><span>Track IDs link to their Spotify pages.</span></footer>
      </section>
    </main>
  );
}
