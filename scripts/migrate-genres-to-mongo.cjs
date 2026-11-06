const Database = require("better-sqlite3");
const { MongoClient } = require("mongodb");
const path = require("node:path");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI in .env.local before running the SQLite-to-MongoDB migration. Local mode already stores genres in SQLite.");

  const sqlitePath = path.resolve(process.cwd(), "data", "genres.sqlite");
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const client = new MongoClient(uri, { appName: "SonicSortMigration" });

  try {
    await client.connect();
    const collection = client.db(process.env.MONGODB_DB ?? "sonic_sort").collection("track_genres");
    const rows = sqlite.prepare("SELECT spotify_track_id, isrc, genres_json, source, looked_up_at FROM track_genres").all();
    let migrated = 0;

    for (let offset = 0; offset < rows.length; offset += 500) {
      const operations = rows.slice(offset, offset + 500).map((row) => {
        let genres;
        try {
          genres = JSON.parse(row.genres_json);
        } catch {
          genres = [];
        }
        return {
          updateOne: {
            filter: { _id: row.spotify_track_id },
            update: {
              $set: {
                isrc: row.isrc,
                source: row.source || "musicbrainz",
                lookedUpAt: row.looked_up_at,
              },
              $addToSet: { genres: { $each: Array.isArray(genres) ? genres : [] } },
            },
            upsert: true,
          },
        };
      });
      if (operations.length) {
        await collection.bulkWrite(operations, { ordered: false });
        migrated += operations.length;
        console.log(`Migrated ${migrated}/${rows.length} genre mappings`);
      }
    }

    console.log(`Migration complete. ${migrated} mappings copied to MongoDB database "${process.env.MONGODB_DB ?? "sonic_sort"}".`);
    console.log("The original SQLite database was left untouched as a backup.");
  } finally {
    sqlite.close();
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
