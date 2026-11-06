import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import type { SpotifySession } from "@/lib/types";

const COOKIE_NAME = "spotify_organizer_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters. See .env.example.");
  }
  return createHash("sha256").update(secret).digest();
}

function seal(session: SpotifySession) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function unseal(value: string): SpotifySession | null {
  try {
    const data = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as SpotifySession;
  } catch {
    return null;
  }
}

export async function readSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get(COOKIE_NAME)?.value;
  return value ? unseal(value) : null;
}

export function writeSessionCookie(response: NextResponse, session: SpotifySession) {
  response.cookies.set(COOKIE_NAME, seal(session), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function spotifyClientId() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) throw new Error("SPOTIFY_CLIENT_ID is not configured. See .env.example.");
  return clientId;
}

export async function refreshSpotifySession(session: SpotifySession) {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: spotifyClientId(),
    }),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description ?? "Spotify session expired. Please reconnect.");
  session.accessToken = payload.access_token;
  session.expiresAt = Date.now() + payload.expires_in * 1000;
  if (payload.refresh_token) session.refreshToken = payload.refresh_token;
  return session;
}

export async function spotifyRequest<T>(session: SpotifySession, path: string, init?: RequestInit): Promise<T> {
  if (session.expiresAt < Date.now() + 60_000) await refreshSpotifySession(session);
  const url = path.startsWith("https://") ? path : `https://api.spotify.com/v1${path}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${session.accessToken}`, ...init?.headers },
      cache: "no-store",
    });
    if (response.status === 401 && attempt === 0) {
      await refreshSpotifySession(session);
      continue;
    }
    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? 2);
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 30) * 1000));
      continue;
    }
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      const message = details?.error?.message ?? details?.error_description ?? `Spotify returned ${response.status}`;
      throw new Error(message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  throw new Error("Spotify rate limit persisted. Please try again shortly.");
}
