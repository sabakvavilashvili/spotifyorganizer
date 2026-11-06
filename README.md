# Sonic Sort — Spotify Liked Songs Organizer

A full-stack Next.js app that helps a Spotify user review Liked Songs and add the tracks they personally approve to **real, private Spotify playlists**. Create a criterion (a playlist name), then review tracks one at a time with approve/skip buttons, arrow keys, or touch swipes.

## Requirements

- Node.js 20.9 or newer
- A Spotify account. Spotify currently requires the app owner to have Premium for apps in Development Mode.
- A Spotify Developer app with this exact redirect URI registered: `http://127.0.0.1:3000/api/auth/callback`
- In Development Mode, add the Spotify accounts that will test the app to its allowlist. Spotify currently permits up to five authorized users for Development Mode apps.

## Run locally

1. In the Spotify Developer Dashboard, create an app and copy its **Client ID**.
2. Copy `.env.example` to `.env.local`.
3. Set `SPOTIFY_CLIENT_ID`, keep `APP_URL=http://127.0.0.1:3000`, and set `SESSION_SECRET` to a random secret of at least 32 characters (for example, generate one with `openssl rand -hex 32`).
4. The genre catalog uses local SQLite by default; no database setup is needed for local use. Optionally, create a MongoDB database (such as MongoDB Atlas), set its URI in `MONGODB_URI`, and set `MONGODB_DB` if desired (defaults to `sonic_sort`). Give the database user read/write access and allow your server's IP in Atlas Network Access.
5. Add the owner Spotify profile ID(s), comma separated, to `GENRE_CATALOG_ADMIN_IDS`. This allowlist controls who can browse the genre database page. You can get your connected profile ID from the `/api/session` response while signed in.
6. Install dependencies with `npm install`.
7. Start the development server with `npm run dev` and open `http://127.0.0.1:3000`.
8. Choose **Connect with Spotify** and approve the requested permissions.

The `APP_URL` origin and callback URL registered in Spotify must match exactly, including the hostname (`127.0.0.1` and `localhost` are not interchangeable).

## Test from a phone with ngrok

The project can be reached from a phone using the temporary ngrok HTTPS address. Keep both the Next.js dev server and ngrok running while testing. Add the current tunnel callback to the Spotify Developer Dashboard as a Redirect URI, and set `APP_URL` in `.env.local` to the tunnel's HTTPS origin. The exact tunnel hostname can change after restarting ngrok; when it does, update `APP_URL`, the Spotify Redirect URI, and the exact `allowedDevOrigins` hostname in `next.config.ts`, then restart Next.js. The tunnel URL is publicly reachable, so share it only with testers you trust.

## How track review works

1. Create a criterion such as “Ski day” or “Cycling” and choose **Review**.
2. The app finds or creates the matching `Sonic Sort · …` **private Spotify playlist** before retrieving the library.
3. It loads the user's saved tracks, excludes local files and tracks already in that destination, and shuffles the remaining queue.
4. The user decides whether each track fits: green **Add** / right arrow / swipe right approves it; red **Skip** / left arrow / swipe left rejects it. A Spotify link is available to inspect each song.
	- The official Spotify track Embed attempts to autoplay from about 30 seconds into the track. Browser autoplay rules, Spotify availability, and track support can block that attempt; if so, use the fallback play button or the Embed's controls, or open the track in Spotify.
5. No track is added during review. At the end, the user confirms once; the server verifies playlist ownership, deduplicates URIs, and adds approved tracks in batches of no more than 100.
6. Approve/skip decisions are logged in browser `localStorage` on that device only. The log can be cleared; it is not uploaded to a shared database.

A review can be closed before confirmation; already recorded browser-local decisions remain in history, but unsubmitted approvals are not added to Spotify. If adding tracks fails partway, retrying is safe: existing playlist contents are checked first.

### Automatic genre lookup prototype

Genre criteria use an independent MusicBrainz lookup rather than Spotify artist-genre metadata. Select one or more genre criteria and choose **Sort genres**. The app creates or finds each private destination playlist, reads Liked Songs, and looks up each unique ISRC in MusicBrainz. Genre/community tags are matched to the selected genre names; a recording can go into multiple selected genre playlists. Existing destination items are left in place, and only missing matches are added.

Each completed lookup is persisted in the local SQLite database at `data/genres.sqlite` by default, keyed by Spotify track ID and including ISRC, MusicBrainz genre tags, source, lookup timestamp, and—when available from Spotify—the track title, artist names, album title, and album cover URL. Existing genre-cache entries are filled with this display metadata the next time those tracks are scanned. Spotify user ID is not stored, so later runs from any account using this local app can reuse cached mappings. The DB directory and WAL files are gitignored. The catalog UI/API is limited to Spotify accounts in `GENRE_CATALOG_ADMIN_IDS`; set your Spotify profile ID in `.env.local` to browse it. Track rows link back to Spotify.

The Genre Database page also has **Refresh from Liked Songs**. It fetches the connected account's current saved tracks and backfills Spotify display metadata for catalog IDs that appear in that library. It does not call MusicBrainz or change playlist contents. Older catalog rows from tracks no longer in the connected account's Liked Songs remain ID-only.

If `MONGODB_URI` is configured, the app uses MongoDB instead of local SQLite. To copy an existing SQLite catalog into MongoDB, set `MONGODB_URI` and run `npm run migrate:genres`; migration leaves the SQLite file untouched as a backup and can be safely rerun.

Unmatched recordings are not guessed or sent to the AI. Tracks with no ISRC, or with no MusicBrainz recording/tag match, are skipped and counted in the completion message. MusicBrainz coverage and community tags vary, so automatic genre sorting is best-effort, not authoritative. Mood, activity, tempo, and custom criteria still use manual track-by-track review.

**This is a non-commercial prototype.** MusicBrainz documents its genre/tag derived data under CC BY-NC-SA; this app attributes MusicBrainz and must not be used commercially with this source without resolving licensing. The public MusicBrainz API allows at most one request per second. The app spaces calls at 2 seconds and automatically retries rate limits and transient server/network errors, honoring `Retry-After` when provided. Per-recording progress streams to the browser as lookups finish; uncached ISRCs can take at least about 28 minutes per 834 recordings plus network/API pauses. Keep the browser and dev server open.

If mobile Chrome suspends or closes the progress connection, the server continues the lookup loop and saves each completed mapping to MongoDB. The page may report that progress was interrupted; after the server finishes, start genre sorting again. Cached mappings are reused and the second pass applies them to the selected Spotify playlists.

Spotify currently documents artist genres and audio-features endpoints as deprecated. Spotify's Developer Policy also restricts analyzing Spotify content for derived functionality; the genre flow combines user-authorized Liked Songs identifiers with external MusicBrainz tags. This prototype is intended only for the user's own non-commercial testing; confirm the intended integration with Spotify before broader use. See [Spotify Developer Policy](https://developer.spotify.com/policy), [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API), and [MusicBrainz data licenses](https://musicbrainz.org/doc/MusicBrainz_Database/Download).

## Security and privacy

- Uses Spotify's Authorization Code with PKCE flow; no Spotify client secret is needed or stored.
- OAuth state and verifier are short-lived, HTTP-only cookies.
- Access and refresh tokens are encrypted with AES-256-GCM in a signed-in session cookie. Set a strong `SESSION_SECRET`; do not commit `.env.local`.
- Tokens are not exposed to browser JavaScript or saved in local storage. Playlist and library requests are made server-side.
- The app does not persist the Liked Songs library on the server. Review decisions (Spotify track URI, criterion, approve/skip, and timestamp) are saved in browser-local storage on the user's device and can be cleared. MusicBrainz genre mappings are stored in the local SQLite catalog by default (or optional shared MongoDB), keyed by Spotify track ID and without Spotify user IDs. Disconnecting Spotify does not delete shared catalog entries.
- The app requests only the scopes required to read saved tracks, list private playlists, and manage private playlists.

## Spotify API behavior verified for this implementation

- **OAuth:** Authorization Code with PKCE is Spotify's supported flow for apps that cannot safely store a client secret. Requested scopes: `user-library-read`, `user-read-private` (to display the connected account), `playlist-read-private`, and `playlist-modify-private`.
- **Liked Songs:** `GET /me/tracks`, paginated; current maximum page size is 50.
- **Playlists:** `GET /me/playlists`, paginated; current maximum page size is 50. Playlist item reads use `GET /playlists/{id}/items`, paginated with a maximum page size of 50.
- **Creation:** `POST /me/playlists` with `public: false` creates a private playlist; private playlist creation requires `playlist-modify-private`.
- **Adding tracks:** `POST /playlists/{id}/items` accepts up to 100 URIs per request.
- **Playback preview:** Uses Spotify's official track Embed and iFrame API, not extracted or downloaded audio. The Web API's `preview_url` is deprecated and often null. Spotify documents `startAt` for embedded content; actual availability and seeking may vary.
- **Rate limits:** Spotify returns HTTP 429 when an app exceeds its rolling rate limit. Requests honor `Retry-After` and retry with bounded backoff.
- **External genres:** MusicBrainz recording searches use `query=isrc:<ISRC>` and read community tags from matching recordings. The ISRC lookup resource does not support genre includes. Requests use a descriptive User-Agent and are serialized at 1.5-second intervals per server process in accordance with its one-request-per-second limit. Rate limits and transient failures receive automatic retries. Community genre-tag data is CC BY-NC-SA and used only in this non-commercial prototype.
- **Development access:** Development Mode has an allowlist and account-count restrictions; broader access requires Spotify's applicable quota mode and review. The dashboard access policy can change, so check Spotify's current quota-mode guidance before distributing an app.

## Official references

- [Authorization and OAuth flow selection](https://developer.spotify.com/documentation/web-api/concepts/authorization)
- [Authorization Code with PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Spotify scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)
- [Get User's Saved Tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks)
- [Get Current User's Playlists](https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists)
- [Create Playlist](https://developer.spotify.com/documentation/web-api/reference/create-playlist)
- [Get Playlist Items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items)
- [Add Items to Playlist](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist)
- [Artist metadata](https://developer.spotify.com/documentation/web-api/reference/get-an-artist)
- [Audio features](https://developer.spotify.com/documentation/web-api/reference/get-several-audio-features)
- [Spotify Embeds](https://developer.spotify.com/documentation/embeds)
- [Spotify iFrame API](https://developer.spotify.com/documentation/embeds/references/iframe-api)
- [Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)
- [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API)
- [MusicBrainz data licenses](https://musicbrainz.org/doc/MusicBrainz_Database/Download)

## Scripts

- `npm run dev` — local development server
- `npm run lint` — TypeScript type check
- `npm run build` — production build
- `npm start` — serve the production build
