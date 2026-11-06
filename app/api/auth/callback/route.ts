import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { REQUIRED_SCOPES } from "@/lib/catalog";
import { spotifyClientId, writeSessionCookie } from "@/lib/session";
import type { SpotifySession } from "@/lib/types";

async function readJsonResponse<T extends Record<string, unknown>>(response: Response, endpoint: string): Promise<T> {
  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (/user is not registered|user is not allowed|not on the.*allow.?list/i.test(text)) {
      throw new Error("This Spotify account is not allowed to use the app yet. Add it to the app's Users Management allowlist in the Spotify Developer Dashboard, then reconnect.");
    }
    const detail = text.replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`${endpoint} returned a non-JSON response (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
  }
  if (!response.ok) {
    const error = payload.error;
    const description = typeof payload.error_description === "string" ? payload.error_description : "";
    const message = typeof error === "string" ? error : "Request failed";
    throw new Error(`${endpoint} returned HTTP ${response.status}: ${description || message}`);
  }
  return payload as T;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("spotify_oauth_state")?.value;
  const verifier = cookieStore.get("spotify_pkce_verifier")?.value;
  const redirectUri = new URL("/api/auth/callback", process.env.APP_URL ?? url.origin).toString();
  const finish = (target: URL) => {
    const response = NextResponse.redirect(target);
    response.cookies.delete("spotify_oauth_state");
    response.cookies.delete("spotify_pkce_verifier");
    return response;
  };

  if (oauthError || !code) return finish(new URL(`/?error=${encodeURIComponent(oauthError ?? "Spotify did not return an authorization code.")}`, url.origin));
  if (!state || !expectedState || state !== expectedState || !verifier) {
    return finish(new URL("/?error=Spotify%20authorization%20could%20not%20be%20verified.%20Please%20try%20again.", url.origin));
  }

  try {
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: spotifyClientId(),
        code_verifier: verifier,
      }),
      cache: "no-store",
    });
    const token = await readJsonResponse<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope?: string;
    }>(tokenResponse, "Spotify token exchange");
    const profileResponse = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      cache: "no-store",
    });
    const profile = await readJsonResponse<{
      id: string;
      display_name?: string | null;
      images?: Array<{ url: string }>;
    }>(profileResponse, "Spotify profile request");

    const missingScopes = REQUIRED_SCOPES.filter((scope) => !String(token.scope ?? "").split(" ").includes(scope));
    if (missingScopes.length) throw new Error(`Spotify did not grant required permissions: ${missingScopes.join(", ")}. Reconnect and approve all requested access.`);

    const session: SpotifySession = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      scope: String(token.scope).split(" "),
      user: {
        id: profile.id,
        displayName: profile.display_name || "Spotify listener",
        image: profile.images?.[0]?.url,
      },
    };
    const response = finish(new URL("/", url.origin));
    writeSessionCookie(response, session);
    return response;
  } catch (error) {
    return finish(new URL(`/?error=${encodeURIComponent(error instanceof Error ? error.message : "Unable to connect Spotify.")}`, url.origin));
  }
}
