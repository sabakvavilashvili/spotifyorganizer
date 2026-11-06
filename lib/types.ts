export type Criterion = {
  id: string;
  name: string;
  category: "genre" | "mood" | "activity" | "tempo" | "custom";
};

export type SpotifySession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string[];
  user: { id: string; displayName: string; image?: string };
};

export type SpotifyTrack = {
  id: string;
  uri: string;
  name: string;
  artists: Array<{ id?: string; name: string }>;
  album: { name: string; images?: Array<{ url: string }> };
  external_urls?: { spotify?: string };
  external_ids?: { isrc?: string };
  is_local?: boolean;
};

export type Playlist = {
  id: string;
  name: string;
  description?: string | null;
  owner?: { id?: string };
  external_urls?: { spotify?: string };
  tracks?: { total?: number };
  items?: { total?: number };
};
