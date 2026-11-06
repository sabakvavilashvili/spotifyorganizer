import "server-only";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { MongoClient, type Collection, type Document } from "mongodb";

export type GenreCacheRow = {
  spotifyTrackId: string;
  isrc: string | null;
  genres: string[];
  source: "musicbrainz";
  lookedUpAt: string;
  trackName?: string | null;
  artistNames?: string[];
  albumName?: string | null;
  albumImageUrl?: string | null;
};

export type GenreCatalogPage = {
  rows: GenreCacheRow[];
  total: number;
  page: number;
  pageSize: number;
  genreOptions: string[];
  totalGenres: number;
};

type GenreDocument = Document & {
  _id: string;
  isrc: string | null;
  genres: string[];
  source: "musicbrainz";
  lookedUpAt: string;
  trackName?: string | null;
  artistNames?: string[];
  albumName?: string | null;
  albumImageUrl?: string | null;
};
type MongoConnection = { client: MongoClient; collection: Collection<GenreDocument> };
type SqliteGenreRow = {
  spotify_track_id: string;
  isrc: string | null;
  genres_json: string;
  source: string;
  looked_up_at: string;
  track_name?: string | null;
  artist_names_json?: string | null;
  album_name?: string | null;
  album_image_url?: string | null;
};

declare global {
  // Reuse connections while Next.js hot reloads route modules in development.
  var sonicSortMongoConnection: Promise<MongoConnection> | undefined;
  var sonicSortGenreSqlite: Database.Database | undefined;
}

const sqlitePath = path.resolve(process.cwd(), "data", "genres.sqlite");

function getSqlite() {
  if (!globalThis.sonicSortGenreSqlite) {
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const db = new Database(sqlitePath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    globalThis.sonicSortGenreSqlite = db;
  }

  const db = globalThis.sonicSortGenreSqlite;
  db.exec(`
      CREATE TABLE IF NOT EXISTS genre_catalog (
        spotify_track_id TEXT PRIMARY KEY,
        isrc TEXT,
        genres_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'musicbrainz',
        looked_up_at TEXT NOT NULL,
        track_name TEXT,
        artist_names_json TEXT NOT NULL DEFAULT '[]',
        album_name TEXT,
        album_image_url TEXT
      );
      CREATE INDEX IF NOT EXISTS genre_catalog_isrc_idx ON genre_catalog(isrc);
      CREATE INDEX IF NOT EXISTS genre_catalog_looked_up_idx ON genre_catalog(looked_up_at DESC);
      CREATE TABLE IF NOT EXISTS genre_catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Run schema upgrades on every access. In Next.js dev, the global database
  // handle survives module hot reload, so one-time initialization is not enough.
  const existingColumns = new Set((db.prepare("PRAGMA table_info(genre_catalog)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!existingColumns.has("track_name")) db.exec("ALTER TABLE genre_catalog ADD COLUMN track_name TEXT");
  if (!existingColumns.has("artist_names_json")) db.exec("ALTER TABLE genre_catalog ADD COLUMN artist_names_json TEXT NOT NULL DEFAULT '[]'");
  if (!existingColumns.has("album_name")) db.exec("ALTER TABLE genre_catalog ADD COLUMN album_name TEXT");
  if (!existingColumns.has("album_image_url")) db.exec("ALTER TABLE genre_catalog ADD COLUMN album_image_url TEXT");

  // Upgrade the previous per-user SQLite cache into a shared local catalog.
  const oldTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "track_genres");
  const migrationDone = db.prepare("SELECT value FROM genre_catalog_meta WHERE key = ?").get("legacy_track_genres_migrated");
  if (oldTable && !migrationDone) {
      const oldRows = db.prepare("SELECT spotify_track_id, isrc, genres_json, source, looked_up_at FROM track_genres").all() as SqliteGenreRow[];
      const merged = new Map<string, SqliteGenreRow & { genres: Set<string> }>();
      for (const row of oldRows) {
        let parsed: unknown = [];
        try { parsed = JSON.parse(row.genres_json); } catch { /* discard malformed old cache values */ }
        const existing = merged.get(row.spotify_track_id) ?? { ...row, genres: new Set<string>() };
        if (Array.isArray(parsed)) for (const genre of parsed) if (typeof genre === "string" && genre.trim()) existing.genres.add(genre.trim());
        if (row.looked_up_at > existing.looked_up_at) {
          existing.isrc = row.isrc;
          existing.source = row.source;
          existing.looked_up_at = row.looked_up_at;
        }
        merged.set(row.spotify_track_id, existing);
      }
      const save = db.prepare(`
        INSERT INTO genre_catalog (spotify_track_id, isrc, genres_json, source, looked_up_at, track_name, artist_names_json, album_name, album_image_url)
        VALUES (@spotify_track_id, @isrc, @genres_json, @source, @looked_up_at, NULL, '[]', NULL, NULL)
        ON CONFLICT(spotify_track_id) DO UPDATE SET
          isrc = excluded.isrc,
          genres_json = excluded.genres_json,
          source = excluded.source,
          looked_up_at = excluded.looked_up_at
      `);
      const migrate = db.transaction(() => {
        for (const row of merged.values()) save.run({
          spotify_track_id: row.spotify_track_id,
          isrc: row.isrc,
          genres_json: JSON.stringify([...row.genres]),
          source: row.source || "musicbrainz",
          looked_up_at: row.looked_up_at,
        });
        db.prepare("INSERT OR REPLACE INTO genre_catalog_meta (key, value) VALUES (?, ?)").run("legacy_track_genres_migrated", new Date().toISOString());
      });
    migrate();
  }
  return db;
}

async function getMongoCollection() {
  if (!globalThis.sonicSortMongoConnection) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not configured.");
    const client = new MongoClient(uri, { appName: "SonicSort" });
    globalThis.sonicSortMongoConnection = client.connect().then((connected) => ({
      client: connected,
      collection: connected.db(process.env.MONGODB_DB ?? "sonic_sort").collection<GenreDocument>("track_genres"),
    })).catch((error: unknown) => {
      globalThis.sonicSortMongoConnection = undefined;
      throw error;
    });
  }
  return (await globalThis.sonicSortMongoConnection).collection;
}

export function getGenreStorageBackend(): "local" | "mongodb" {
  return process.env.MONGODB_URI ? "mongodb" : "local";
}

export async function ensureGenreDatabase() {
  if (getGenreStorageBackend() === "mongodb") await getMongoCollection();
  else getSqlite();
}

export async function getCachedTrackGenres(trackIds: string[]) {
  const ids = [...new Set(trackIds.filter((id) => /^[A-Za-z0-9]{10,64}$/.test(id)))];
  if (!ids.length) return new Map<string, GenreCacheRow>();

  if (getGenreStorageBackend() === "mongodb") {
    const collection = await getMongoCollection();
    const rows = await collection.find({ _id: { $in: ids } }, {
      projection: { _id: 1, isrc: 1, genres: 1, source: 1, lookedUpAt: 1, trackName: 1, artistNames: 1, albumName: 1, albumImageUrl: 1 },
    }).toArray();
    return new Map(rows.map((row) => [row._id, {
      spotifyTrackId: row._id,
      isrc: row.isrc,
      genres: row.genres ?? [],
      source: row.source,
      lookedUpAt: row.lookedUpAt,
      trackName: row.trackName ?? null,
      artistNames: row.artistNames ?? [],
      albumName: row.albumName ?? null,
      albumImageUrl: row.albumImageUrl ?? null,
    }]));
  }

  const db = getSqlite();
  const rows: SqliteGenreRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...db.prepare(`SELECT spotify_track_id, isrc, genres_json, source, looked_up_at, track_name, artist_names_json, album_name, album_image_url FROM genre_catalog WHERE spotify_track_id IN (${placeholders})`).all(...chunk) as SqliteGenreRow[]);
  }
  return new Map(rows.map((row) => [row.spotify_track_id, {
    spotifyTrackId: row.spotify_track_id,
    isrc: row.isrc,
    genres: JSON.parse(row.genres_json) as string[],
    source: "musicbrainz" as const,
    lookedUpAt: row.looked_up_at,
    trackName: row.track_name ?? null,
    artistNames: JSON.parse(row.artist_names_json ?? "[]") as string[],
    albumName: row.album_name ?? null,
    albumImageUrl: row.album_image_url ?? null,
  }]));
}

export async function saveTrackGenres(rows: GenreCacheRow[]) {
  if (!rows.length) return;
  if (getGenreStorageBackend() === "mongodb") {
    const collection = await getMongoCollection();
    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      await collection.bulkWrite(chunk.map((row) => ({
        updateOne: {
          filter: { _id: row.spotifyTrackId },
          update: { $set: {
            isrc: row.isrc,
            genres: row.genres,
            source: row.source,
            lookedUpAt: row.lookedUpAt,
            ...(row.trackName !== undefined ? { trackName: row.trackName } : {}),
            ...(row.artistNames !== undefined ? { artistNames: row.artistNames } : {}),
            ...(row.albumName !== undefined ? { albumName: row.albumName } : {}),
            ...(row.albumImageUrl !== undefined ? { albumImageUrl: row.albumImageUrl } : {}),
          } },
          upsert: true,
        },
      })), { ordered: false });
    }
    return;
  }

  const db = getSqlite();
  const upsert = db.prepare(`
    INSERT INTO genre_catalog (spotify_track_id, isrc, genres_json, source, looked_up_at, track_name, artist_names_json, album_name, album_image_url)
    VALUES (@spotifyTrackId, @isrc, @genresJson, @source, @lookedUpAt, @trackName, @artistNamesJson, @albumName, @albumImageUrl)
    ON CONFLICT(spotify_track_id) DO UPDATE SET
      isrc = excluded.isrc,
      genres_json = excluded.genres_json,
      source = excluded.source,
      looked_up_at = excluded.looked_up_at,
      track_name = COALESCE(excluded.track_name, genre_catalog.track_name),
      artist_names_json = CASE WHEN excluded.artist_names_json = '[]' THEN genre_catalog.artist_names_json ELSE excluded.artist_names_json END,
      album_name = COALESCE(excluded.album_name, genre_catalog.album_name),
      album_image_url = COALESCE(excluded.album_image_url, genre_catalog.album_image_url)
  `);
  const saveMany = db.transaction((items: GenreCacheRow[]) => {
    for (const row of items) upsert.run({
      spotifyTrackId: row.spotifyTrackId,
      isrc: row.isrc,
      genresJson: JSON.stringify(row.genres),
      source: row.source,
      lookedUpAt: row.lookedUpAt,
      trackName: row.trackName ?? null,
      artistNamesJson: JSON.stringify(row.artistNames ?? []),
      albumName: row.albumName ?? null,
      albumImageUrl: row.albumImageUrl ?? null,
    });
  });
  saveMany(rows);
}

export async function getGenreCatalogPage(options: {
  page: number;
  pageSize: number;
  search: string;
  genre: string;
}): Promise<GenreCatalogPage> {
  if (getGenreStorageBackend() === "mongodb") {
    const collection = await getMongoCollection();
    const escapedSearch = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const query: Document = {};
    if (options.search) query.$or = [
      { _id: { $regex: escapedSearch, $options: "i" } },
      { isrc: { $regex: escapedSearch, $options: "i" } },
      { genres: { $regex: escapedSearch, $options: "i" } },
      { trackName: { $regex: escapedSearch, $options: "i" } },
      { artistNames: { $regex: escapedSearch, $options: "i" } },
      { albumName: { $regex: escapedSearch, $options: "i" } },
    ];
    if (options.genre) query.genres = options.genre;
    const skip = (options.page - 1) * options.pageSize;
    const [total, found, genreOptions] = await Promise.all([
      collection.countDocuments(query),
      collection.find(query, { projection: { _id: 1, isrc: 1, genres: 1, source: 1, lookedUpAt: 1, trackName: 1, artistNames: 1, albumName: 1, albumImageUrl: 1 } }).sort({ lookedUpAt: -1, _id: 1 }).skip(skip).limit(options.pageSize).toArray(),
      collection.distinct("genres"),
    ]);
    const cleanedOptions = genreOptions.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).sort((a, b) => a.localeCompare(b));
    return {
      rows: found.map((row) => ({ spotifyTrackId: row._id, isrc: row.isrc, genres: row.genres ?? [], source: row.source, lookedUpAt: row.lookedUpAt, trackName: row.trackName ?? null, artistNames: row.artistNames ?? [], albumName: row.albumName ?? null, albumImageUrl: row.albumImageUrl ?? null })),
      total,
      page: options.page,
      pageSize: options.pageSize,
      genreOptions: cleanedOptions,
      totalGenres: cleanedOptions.length,
    };
  }

  const db = getSqlite();
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (options.search) {
    conditions.push("(instr(lower(spotify_track_id), lower(?)) > 0 OR instr(lower(COALESCE(isrc, '')), lower(?)) > 0 OR instr(lower(genres_json), lower(?)) > 0 OR instr(lower(COALESCE(track_name, '')), lower(?)) > 0 OR instr(lower(COALESCE(artist_names_json, '')), lower(?)) > 0 OR instr(lower(COALESCE(album_name, '')), lower(?)) > 0)");
    parameters.push(options.search, options.search, options.search, options.search, options.search, options.search);
  }
  if (options.genre) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(genres_json) WHERE value = ?)");
    parameters.push(options.genre);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM genre_catalog ${where}`).get(...parameters) as { count: number }).count;
  const rows = db.prepare(`SELECT spotify_track_id, isrc, genres_json, source, looked_up_at, track_name, artist_names_json, album_name, album_image_url FROM genre_catalog ${where} ORDER BY looked_up_at DESC, spotify_track_id ASC LIMIT ? OFFSET ?`)
    .all(...parameters, options.pageSize, (options.page - 1) * options.pageSize) as SqliteGenreRow[];
  const genreOptions = (db.prepare("SELECT DISTINCT value AS genre FROM genre_catalog, json_each(genre_catalog.genres_json) WHERE TRIM(value) <> '' ORDER BY value COLLATE NOCASE").all() as Array<{ genre: string }>).map((item) => item.genre);
  return {
    rows: rows.map((row) => ({ spotifyTrackId: row.spotify_track_id, isrc: row.isrc, genres: JSON.parse(row.genres_json) as string[], source: "musicbrainz", lookedUpAt: row.looked_up_at, trackName: row.track_name ?? null, artistNames: JSON.parse(row.artist_names_json ?? "[]") as string[], albumName: row.album_name ?? null, albumImageUrl: row.album_image_url ?? null })),
    total,
    page: options.page,
    pageSize: options.pageSize,
    genreOptions,
    totalGenres: genreOptions.length,
  };
}
