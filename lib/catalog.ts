import type { Criterion } from "@/lib/types";

export const REQUIRED_SCOPES = [
  "user-library-read",
  "user-read-private",
  "playlist-read-private",
  "playlist-modify-private",
] as const;

export const STARTER_CRITERIA: Criterion[] = [
  { id: "genre-techno", name: "Techno", category: "genre" },
  { id: "genre-house", name: "House", category: "genre" },
  { id: "genre-dnb", name: "Drum & Bass", category: "genre" },
  { id: "genre-ambient", name: "Ambient", category: "genre" },
  { id: "genre-indie-rock", name: "Indie Rock", category: "genre" },
  { id: "mood-chill", name: "Chill", category: "mood" },
  { id: "mood-euphoric", name: "Euphoric", category: "mood" },
  { id: "mood-melancholic", name: "Melancholic", category: "mood" },
  { id: "activity-driving", name: "Driving", category: "activity" },
  { id: "activity-running", name: "Running", category: "activity" },
  { id: "tempo-fast", name: "Fast tempo", category: "tempo" },
  { id: "tempo-slow", name: "Slow tempo", category: "tempo" },
];

export const CATEGORY_LABELS: Record<Criterion["category"], string> = {
  genre: "Genres",
  mood: "Moods",
  activity: "Activities",
  tempo: "Tempo",
  custom: "Your rules",
};
