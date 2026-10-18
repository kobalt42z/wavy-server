// Small, framework-free client for the wavy playback API.
//
// Copy this file into the web app. It needs a <video> (or <audio>) element and
// hls.js, which is passed in so the app can load it however it likes:
//
//   import Hls from "hls.js";
//   import { WavyPlayer, describeError } from "./wavy-player.js";
//
//   const player = new WavyPlayer(videoElement, { Hls });
//   try {
//     await player.load("cctv/2026-10-01/cam3.dav");
//   } catch (err) {
//     showMessage(describeError(err)); // e.g. the API's "unsupported" reason
//   }
//
// Flow (see the dev spec, "Frontend player"):
//   1. GET  /api/probe?path=…        codecs, duration and the chosen mode
//   2. POST /api/sessions            { sessionId, mode, url }
//   3. direct mode: media.src = url (Chrome streams it with Range requests)
//      other modes: url is an HLS playlist, played with hls.js
//   4. Seeking past what FFmpeg has produced: POST /api/sessions/{id}/seek,
//      then load the new playlist. Its timestamps restart at 0, so the player
//      keeps an offset (the server's `start`) and reports absolute times
//      through currentTime.
//   5. DELETE /api/sessions/{id} on stop and file change; on page close,
//      navigator.sendBeacon to POST /api/sessions/{id}/stop.

/** Playback modes returned by the API (src/decide.ts). */
export const MODES = ["direct", "remux", "transcode-audio", "transcode", "unsupported"];

/** Short human labels for each mode. */
export const MODE_LABELS = {
  direct: "Direct (original file)",
  remux: "Remux (no re-encode)",
  "transcode-audio": "Audio transcode",
  transcode: "Full transcode",
  unsupported: "Unsupported",
};

/** An error the user should see, carrying the API's { error, reason }. */
export class PlaybackError extends Error {
  /**
   * @param {string} code      API error code ("unsupported", "busy", …) or a client code
   * @param {string} reason    Human-readable reason, safe to show to the user
   * @param {{ status?: number, retryAfter?: number, cause?: unknown }} [extra]
   */
  constructor(code, reason, extra = {}) {
    super(reason);
    this.name = "PlaybackError";
    this.code = code;
    this.reason = reason;
    this.status = extra.status;
    this.retryAfter = extra.retryAfter;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/** Turns any error from the player into one sentence for the user. */
export function describeError(err) {
  if (err instanceof PlaybackError) {
    if (err.code === "busy" || err.status === 503) {
      const wait = err.retryAfter ? ` Try again in ${err.retryAfter} seconds.` : " Try again shortly.";
      return `The playback server is busy.${wait}`;
    }
    return err.reason;
  }
  return "Playback failed for an unexpected reason.";
}

/** Formats seconds as h:mm:ss or m:ss. */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// How long to keep retrying a playlist that is not there yet (FFmpeg starting up).
const MANIFEST_RETRIES = 20;
const MANIFEST_RETRY_MS = 500;

/**
 * Events (all CustomEvent, read event.detail):
 * - "statechange": { state } — idle | probing | starting | playing | seeking | error
 * - "session":     { path, sessionId, mode, url, probe }
 * - "error":       PlaybackError — a fatal error after load() resolved (e.g. hls.js gave up)
 */
export class WavyPlayer extends EventTarget {
  /**
   * @param {HTMLMediaElement} media
   * @param {{
   *   Hls?: any,                    hls.js constructor (required for every mode but direct)
   *   apiBase?: string,             e.g. "https://media.example.com"; default same origin
   *   fetch?: typeof fetch,
   *   hlsConfig?: object,           extra hls.js config, merged over the defaults
   *   stopOnPageHide?: boolean,     end the session when the tab closes (default true)
   * }} [options]
   */
  constructor(media, options = {}) {
    super();
    this.media = media;
    this.Hls = options.Hls;
    this.apiBase = (options.apiBase ?? "").replace(/\/+$/, "");
    this._fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.hlsConfig = options.hlsConfig ?? {};

    this.state = "idle";
    this.path = null;
    this.sessionId = null;
    this.mode = null;
    this.url = null;
    this.probeResult = null;
    /** Absolute position (seconds) where the current HLS playlist starts. */
    this.offset = 0;

    this._hls = null;
    this._loadToken = 0;
    this._mediaRecoveries = 0;

    this._onPageHide = () => this._stopOnUnload();
    if ((options.stopOnPageHide ?? true) && typeof window !== "undefined") {
      window.addEventListener("pagehide", this._onPageHide);
    }
  }

  /** Absolute playback position in the file, in seconds. */
  get currentTime() {
    return this.offset + (this.media.currentTime || 0);
  }

  /** Full file duration in seconds (from the probe or session), or NaN when unknown. */
  get duration() {
    for (const value of [this.probeResult?.duration, this._sessionDuration]) {
      const d = Number(value);
      if (Number.isFinite(d) && d > 0) return d;
    }
    return this.mode === "direct" ? this.media.duration : NaN;
  }

  /**
   * Absolute end (seconds) of what can be played without asking the server
   * for a restart: the transcoded part for HLS, the whole file for direct.
   */
  get availableEnd() {
    if (this.mode === "direct") return this.duration;
    const r = this.media.seekable;
    if (!r || r.length === 0) return this.offset;
    return this.offset + r.end(r.length - 1);
  }

  /** GET /api/probe. Resolves with the probe JSON, rejects with PlaybackError. */
  probe(path) {
    return this._request("GET", `/api/probe?path=${encodeURIComponent(path)}`);
  }

  /**
   * Plays a file. Stops the previous session first. Rejects with a PlaybackError
   * (for example code "unsupported" with the API's reason) instead of leaving a
   * broken player behind.
   * @param {string} path   Path relative to the media root
   * @param {{ start?: number, audioTrack?: number }} [opts]
   *   start: position in seconds; audioTrack: an `audio[].track` value from the probe
   */
  async load(path, opts = {}) {
    const token = ++this._loadToken;
    const start = Math.max(0, Number(opts.start) || 0);
    await this.stop();
    if (token !== this._loadToken) return;

    this.path = path;
    try {
      this._setState("probing");
      const probe = await this.probe(path);
      if (token !== this._loadToken) return;
      this.probeResult = probe;
      if (probe.mode === "unsupported") {
        throw new PlaybackError("unsupported", probe.reason || "This file can't be played in the browser.");
      }

      this._setState("starting");
      const body = { path };
      if (start > 0) body.start = start;
      if (opts.audioTrack !== undefined && opts.audioTrack !== null) body.audioTrack = opts.audioTrack;
      const session = await this._request("POST", "/api/sessions", body);
      if (token !== this._loadToken) {
        // A newer load() started while we waited: drop this session.
        this._deleteSession(session.sessionId);
        return;
      }

      this.sessionId = session.sessionId;
      this.mode = session.mode;
      this.url = session.url;
      this._sessionDuration = session.duration;
      if (this.mode === "unsupported") {
        throw new PlaybackError("unsupported", session.reason || probe.reason || "This file can't be played in the browser.");
      }
      this._emit("session", { path, sessionId: this.sessionId, mode: this.mode, url: this.url, probe });

      if (this.mode === "direct") {
        this.offset = 0;
        this._attachDirect(this.url, start);
      } else {
        // The server may start slightly earlier than asked (keyframe); trust its `start`.
        this.offset = finiteOr(session.start, start);
        this._attachHls(this.url);
      }
      this._setState("playing");
      this._play();
    } catch (err) {
      if (token !== this._loadToken) return;
      const error = toPlaybackError(err);
      // Don't leave an FFmpeg process running behind an error message.
      const id = this.sessionId;
      this._detach();
      this.sessionId = null;
      if (id) this._deleteSession(id);
      this._setState("error");
      throw error;
    }
  }

  /**
   * Seeks to an absolute position (seconds). Inside the transcoded part this is a
   * plain media seek; beyond it (or before the current playlist's start) the
   * server restarts FFmpeg at that position.
   */
  async seek(position) {
    if (!this.sessionId) return;
    const d = this.duration;
    let target = Math.max(0, Number(position) || 0);
    if (Number.isFinite(d)) target = Math.min(target, Math.max(0, d - 0.5));

    if (this.mode === "direct") {
      this.media.currentTime = target;
      return;
    }

    const rel = target - this.offset;
    if (rel >= 0 && this._isSeekable(rel)) {
      this.media.currentTime = rel;
      return;
    }

    const token = this._loadToken;
    const sessionId = this.sessionId;
    this._setState("seeking");
    try {
      const res = await this._request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/seek`, {
        position: target,
      });
      if (token !== this._loadToken || sessionId !== this.sessionId) return;
      this.offset = finiteOr(res.start, target);
      this.url = res.url || this.url;
      this._attachHls(this.url);
      this._setState("playing");
      this._play();
    } catch (err) {
      if (token !== this._loadToken) return;
      const error = toPlaybackError(err);
      this._setState("error");
      throw error;
    }
  }

  /** Stops playback and ends the server session (kills FFmpeg, deletes segments). */
  async stop() {
    const id = this.sessionId;
    this._detach();
    this.sessionId = null;
    this.mode = null;
    this.url = null;
    this.probeResult = null;
    this._sessionDuration = undefined;
    this.offset = 0;
    this.path = null;
    if (this.state !== "idle") this._setState("idle");
    if (id) await this._deleteSession(id);
  }

  /** Stops, ends the session and removes listeners. */
  async destroy() {
    this._loadToken++;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this._onPageHide);
    await this.stop();
  }

  // --- internals ---------------------------------------------------------

  _attachDirect(url, start) {
    this._destroyHls();
    this.media.src = this._resolve(url);
    if (start > 0) {
      const jump = () => {
        this.media.currentTime = start;
      };
      this.media.addEventListener("loadedmetadata", jump, { once: true });
    }
  }

  _attachHls(url) {
    const Hls = this.Hls;
    if (!Hls) {
      throw new PlaybackError("no-hls", "hls.js is not loaded, so this file can't be played.");
    }
    if (typeof Hls.isSupported === "function" && !Hls.isSupported()) {
      throw new PlaybackError("no-mse", "This browser can't play HLS streams. Use Google Chrome.");
    }

    this._destroyHls();
    this.media.removeAttribute("src");
    this._mediaRecoveries = 0;

    const hls = new Hls({
      // The playlist grows while FFmpeg works (EVENT type, no ENDLIST yet).
      // hls.js treats that as live and would jump to the newest segment;
      // start at the beginning of the playlist instead.
      startPosition: 0,
      // The playlist may not exist for a moment after the session starts.
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: Infinity,
          maxLoadTimeMs: 20000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: {
            maxNumRetry: MANIFEST_RETRIES,
            retryDelayMs: MANIFEST_RETRY_MS,
            maxRetryDelayMs: MANIFEST_RETRY_MS,
            backoff: "linear",
            shouldRetry: (config, retryCount, isTimeout, response, retry) => {
              const code = response?.code;
              return retry || (retryCount < (config?.maxNumRetry ?? 0) && (code === 404 || code === 425));
            },
          },
        },
      },
      ...this.hlsConfig,
    });

    const events = Hls.Events ?? { ERROR: "hlsError" };
    const types = Hls.ErrorTypes ?? { MEDIA_ERROR: "mediaError", NETWORK_ERROR: "networkError" };
    hls.on(events.ERROR, (_event, data) => {
      if (!data?.fatal || hls !== this._hls) return;
      if (data.type === types.MEDIA_ERROR && this._mediaRecoveries < 1) {
        this._mediaRecoveries++;
        hls.recoverMediaError();
        return;
      }
      const status = data.response?.code;
      let reason;
      if (data.type === types.NETWORK_ERROR) {
        reason = status
          ? `The stream stopped loading (HTTP ${status}). The session may have ended; press Play to restart.`
          : "The stream stopped loading. Check the connection and press Play to restart.";
      } else {
        reason = "The browser couldn't decode this stream.";
      }
      this._destroyHls();
      this._setState("error");
      this._emit("error", new PlaybackError("stream", reason, { status, cause: data }));
    });

    hls.loadSource(this._resolve(url));
    hls.attachMedia(this.media);
    this._hls = hls;
  }

  _isSeekable(rel) {
    const r = this.media.seekable;
    if (!r) return false;
    for (let i = 0; i < r.length; i++) {
      // Keep a small margin at the end: the last segment may still be growing.
      if (rel >= r.start(i) && rel <= r.end(i) - 1) return true;
    }
    return false;
  }

  _detach() {
    this._destroyHls();
    if (this.media.getAttribute?.("src") || this.media.src) {
      this.media.removeAttribute("src");
      this.media.load?.();
    }
  }

  _destroyHls() {
    if (this._hls) {
      const hls = this._hls;
      this._hls = null;
      hls.destroy();
    }
  }

  _play() {
    const p = this.media.play?.();
    // Autoplay can be refused (no user gesture); the user can press play.
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  async _deleteSession(id) {
    if (!id) return;
    try {
      await this._fetch(this._resolve(`/api/sessions/${encodeURIComponent(id)}`), { method: "DELETE" });
    } catch {
      // The server also ends sessions after 60 s without segment requests.
    }
  }

  _stopOnUnload() {
    const id = this.sessionId;
    if (!id) return;
    this.sessionId = null;
    const encoded = encodeURIComponent(id);
    // sendBeacon is the most reliable request during page close, but it can only
    // POST, so it goes to the /stop alias of DELETE.
    try {
      const nav = typeof navigator !== "undefined" ? navigator : undefined;
      if (nav?.sendBeacon?.(this._resolve(`/api/sessions/${encoded}/stop`))) return;
    } catch {
      // fall through to fetch
    }
    try {
      this._fetch(this._resolve(`/api/sessions/${encodeURIComponent(id)}`), {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    } catch {
      // ignore
    }
  }

  async _request(method, path, body) {
    let res;
    try {
      res = await this._fetch(this._resolve(path), {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new PlaybackError("network", "Could not reach the playback service.", { cause: err });
    }

    let data = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      const retryAfter = parseRetryAfter(res.headers?.get?.("retry-after"));
      const code = data?.error || (res.status === 503 ? "busy" : res.status === 404 ? "not-found" : "http");
      const reason =
        data?.reason ||
        (res.status === 404
          ? "The file was not found."
          : res.status === 503
            ? "The playback server is busy."
            : `The playback service returned HTTP ${res.status}.`);
      throw new PlaybackError(code, reason, { status: res.status, retryAfter });
    }
    if (data === null) {
      throw new PlaybackError("bad-response", "The playback service sent an unreadable response.", { status: res.status });
    }
    return data;
  }

  _resolve(url) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    return this.apiBase + (url.startsWith("/") ? url : `/${url}`);
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit("statechange", { state });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? n : fallback;
}

function toPlaybackError(err) {
  if (err instanceof PlaybackError) return err;
  return new PlaybackError("client", "Playback failed for an unexpected reason.", { cause: err });
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}
