import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { REQUIRED_SCOPES } from "@/lib/catalog";
import { spotifyClientId } from "@/lib/session";

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 600,
};

export async function GET(request: Request) {
  try {
    const clientId = spotifyClientId();
    const state = randomBytes(24).toString("hex");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = new URL("/api/auth/callback", process.env.APP_URL ?? new URL(request.url).origin).toString();
    const authorize = new URL("https://accounts.spotify.com/authorize");
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: REQUIRED_SCOPES.join(" "),
      state,
      code_challenge_method: "S256",
      code_challenge: challenge,
    }).toString();
    const response = NextResponse.redirect(authorize);
    response.cookies.set("spotify_oauth_state", state, cookieOptions);
    response.cookies.set("spotify_pkce_verifier", verifier, cookieOptions);
    return response;
  } catch (error) {
    const url = new URL("/", request.url);
    url.searchParams.set("error", error instanceof Error ? error.message : "Spotify configuration is missing.");
    return NextResponse.redirect(url);
  }
}
