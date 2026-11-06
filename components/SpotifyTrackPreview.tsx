"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Play, Volume2 } from "lucide-react";

type SpotifyEmbedController = {
  loadEntity: (uri: string, preferVideo?: boolean, startAt?: number) => void;
  play: () => void;
  addListener?: (event: "playback_started", callback: () => void) => void;
  destroy?: () => void;
};

type SpotifyIframeAPI = {
  createController: (
    element: HTMLElement,
    options: { uri: string; width: string; height: string },
    callback: (controller: SpotifyEmbedController) => void,
  ) => void;
};

declare global {
  interface Window {
    onSpotifyIframeApiReady?: (api: SpotifyIframeAPI) => void;
    __sonicSortSpotifyIframeAPI?: SpotifyIframeAPI;
    __sonicSortSpotifyIframeApiPromise?: Promise<SpotifyIframeAPI>;
  }
}

function getSpotifyIframeAPI() {
  if (window.__sonicSortSpotifyIframeAPI) return Promise.resolve(window.__sonicSortSpotifyIframeAPI);
  if (window.__sonicSortSpotifyIframeApiPromise) return window.__sonicSortSpotifyIframeApiPromise;

  window.__sonicSortSpotifyIframeApiPromise = new Promise<SpotifyIframeAPI>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Spotify player took too long to load.")), 15000);
    window.onSpotifyIframeApiReady = (api) => {
      window.clearTimeout(timeout);
      window.__sonicSortSpotifyIframeAPI = api;
      resolve(api);
    };
    let script = document.querySelector<HTMLScriptElement>('script[src="https://open.spotify.com/embed/iframe-api/v1"]');
    if (!script) {
      script = document.createElement("script");
      script.src = "https://open.spotify.com/embed/iframe-api/v1";
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Spotify's embedded player could not be loaded."));
      };
      document.body.appendChild(script);
    }
  });

  return window.__sonicSortSpotifyIframeApiPromise;
}

export default function SpotifyTrackPreview({ uri }: { uri: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SpotifyEmbedController | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  useEffect(() => {
    let active = true;
    setReady(false);
    setError("");
    setPlaybackStarted(false);
    setAutoplayBlocked(false);
    controllerRef.current = null;
    let autoplayTimer: number | undefined;
    let playbackDetected = false;

    getSpotifyIframeAPI()
      .then((api) => {
        if (!active || !mountRef.current) return;
        api.createController(mountRef.current, { uri, width: "100%", height: "152" }, (controller) => {
          if (!active) {
            controller.destroy?.();
            return;
          }
          controllerRef.current = controller;
          setReady(true);
          controller.addListener?.("playback_started", () => {
            if (!active) return;
            playbackDetected = true;
            window.clearTimeout(autoplayTimer);
            setPlaybackStarted(true);
            setAutoplayBlocked(false);
          });
          try {
            controller.loadEntity(uri, false, 30);
            controller.play();
            if (!playbackDetected) {
              autoplayTimer = window.setTimeout(() => {
                if (active) setAutoplayBlocked(true);
              }, 8000);
            }
          } catch {
            setAutoplayBlocked(true);
          }
        });
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Spotify's embedded player could not be loaded.");
      });

    return () => {
      active = false;
      window.clearTimeout(autoplayTimer);
      controllerRef.current?.destroy?.();
      controllerRef.current = null;
    };
  }, [uri]);

  function retryPlayback() {
    const controller = controllerRef.current;
    if (!controller) return;
    setError("");
    setAutoplayBlocked(false);
    try {
      controller.loadEntity(uri, false, 30);
      controller.play();
    } catch {
      setError("Spotify could not start playback here. Try opening the song in Spotify.");
    }
  }

  return (
    <div className="spotify-preview">
      <div className="spotify-preview-topline"><span><Volume2 size={13} /> SPOTIFY PREVIEW</span><span>{playbackStarted ? "PLAYING FROM 0:30" : ready ? "STARTING AT 0:30" : "LOADING PLAYER"}</span></div>
      <div className="spotify-embed-frame">
        {!ready && !error && <div className="spotify-embed-loading"><LoaderCircle size={16} className="spin" /> Loading Spotify player…</div>}
        <div ref={mountRef} className="spotify-embed-mount" />
        {error && <div className="spotify-embed-error">{error}</div>}
      </div>
      <div className="preview-offsets"><span>{playbackStarted ? "Preview is playing from the middle." : "Automatically starts around 0:30."}</span>{autoplayBlocked && ready && <button type="button" className="offset-button" onClick={retryPlayback}><Play size={12} fill="currentColor" /> Play from 0:30</button>}<span className="preview-offset-note">If autoplay is blocked, use the play button or open in Spotify.</span></div>
    </div>
  );
}
