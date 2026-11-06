import type { Metadata } from "next";
import "./globals.css";
import "./minimal.css";

export const metadata: Metadata = {
  title: "Sonic Sort — Your liked songs, in their place",
  description: "Organize your Spotify liked songs into real playlists with rules you control.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
