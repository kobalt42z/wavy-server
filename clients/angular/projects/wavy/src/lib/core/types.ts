/**
 * How the playback service plays a file. Mirrors `PlaybackMode` in the server's src/decide.ts.
 * - direct: the original file, played by the browser as-is.
 * - remux / transcode-audio / transcode: an HLS playlist.
 * - unsupported: nothing to play; `reason` says why.
 */
export type StreamMode = 'direct' | 'remux' | 'transcode-audio' | 'transcode' | 'unsupported';

/**
 * What the directive plays. This is the playback service's session response
 * (`POST /api/sessions`), or a subset of it. Every field except `mode` is optional
 * so the 422 `{ error: "unsupported", reason }` body can be passed as
 * `{ mode: 'unsupported', reason }`.
 */
export interface PlaybackStream {
  mode: StreamMode;
  /** File URL for direct mode, HLS playlist URL otherwise. */
  url?: string;
  sessionId?: string;
  /** Position in the source file, in seconds, where this stream starts (HLS restarts at 0 after a seek). */
  start?: number;
  /** Full length of the source file in seconds. */
  duration?: number;
  /** Why the file can't be played, for unsupported mode. */
  reason?: string;
}

/** Anything `[streamSupport]` accepts. A bare string is a URL; `.m3u8` URLs are treated as HLS. */
export type StreamInput = PlaybackStream | string | null | undefined;

/** Which player is attached to the element. */
export type StreamEngine = 'native' | 'native-hls' | 'hls.js';

export type StreamErrorKind =
  /** The service said the file can't be played. */
  | 'unsupported'
  /** The stream has no URL. */
  | 'invalid-stream'
  /** HLS is needed but neither the browser nor hls.js (no MediaSource) can play it. */
  | 'hls-unsupported'
  /** hls.js failed to load. */
  | 'hls-load-failed'
  /** Fetching the playlist or segments failed. */
  | 'network'
  /** The browser couldn't decode or play the media. */
  | 'media';

export interface StreamError {
  kind: StreamErrorKind;
  /** A message that can be shown to the user. */
  message: string;
  /** The underlying error or hls.js error data, when there is one. */
  cause?: unknown;
}

/** `GET /api/probe` response. Mirrors `ProbeResponse` in the server's src/playback.ts. */
export interface ProbeResponse {
  path: string;
  mode: StreamMode;
  reason: string;
  duration: number | null;
  container: string | null;
  size: number;
  video: { codec: string; width: number | null; height: number | null; fps: number | null; pixFmt: string | null } | null;
  /** Audio tracks; `track` is the `audioTrack` to pass when starting a session. */
  audio: { track: number; codec: string; channels: number | null; lang: string | null }[];
  subtitles: { codec: string; lang: string | null }[];
  plan: { video: string; audio: string };
}

/** `POST /api/sessions` response. */
export interface SessionResponse {
  sessionId: string;
  mode: StreamMode;
  /** Direct file URL, or HLS playlist URL. Relative to the service. */
  url: string;
  start: number;
  duration: number | null;
  reason: string;
}

/** `GET /api/peaks` response: `count` values from 0 to 1. */
export interface PeaksResponse {
  path: string;
  duration: number | null;
  count: number;
  peaks: number[];
}

/** What a WavyPlayer is doing. */
export type PlayerState = 'idle' | 'probing' | 'starting' | 'playing' | 'seeking' | 'error';
