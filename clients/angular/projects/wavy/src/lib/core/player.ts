import type Hls from 'hls.js';
import type { HlsConfig } from 'hls.js';
import type { WavyTokenProvider } from './config';
import { PlaybackError, toPlaybackError } from './errors';
import type { HlsConstructor } from './hls-loader';
import type { PlayerState, ProbeResponse, SessionResponse, StreamMode } from './types';

// How long to keep retrying a playlist that is not there yet (FFmpeg starting up).
const MANIFEST_RETRIES = 20;
const MANIFEST_RETRY_MS = 500;
/** Auto-resume allows `maxResumes` restarts within this window. */
const RESUME_WINDOW_MS = 60_000;
/** Retries of one resume whose new session couldn't start (busy or vanishing pod). */
const RESUME_RETRIES = 5;

export interface WavyPlayerOptions {
  /** Loads hls.js; only called for HLS sessions. */
  loadHls?: () => Promise<HlsConstructor>;
  apiBase?: string;
  fetch?: typeof fetch;
  getToken?: WavyTokenProvider;
  hlsConfig?: Partial<HlsConfig>;
  stopOnPageHide?: boolean;
  autoResume?: boolean;
  maxResumes?: number;
  withCredentials?: boolean;
}

export interface LoadOptions {
  /** Position in seconds to start at. */
  start?: number;
  /** An `audio[].track` value from the probe. */
  audioTrack?: number;
  /** Call `media.play()` once the stream is attached (default true). */
  autoplay?: boolean;
}

export interface SessionEventDetail {
  path: string;
  sessionId: string;
  mode: StreamMode;
  url: string;
  probe: ProbeResponse;
}

export interface WavyPlayerEvents {
  statechange: { state: PlayerState };
  session: SessionEventDetail;
  /** A fatal error after load() resolved (hls.js gave up, a resume failed). */
  error: PlaybackError;
  /** The session was lost (pod restarted, request routed to another pod); a new one starts at `position`. */
  resume: { position: number; error: PlaybackError };
}

/**
 * Framework-free client for the wavy playback API, driving one `<video>` or `<audio>`.
 * A TypeScript port of the server repo's player/wavy-player.js; the Angular components use it.
 *
 * 1. `GET /api/probe` for the duration and mode (an unsupported file rejects `load()`).
 * 2. `POST /api/sessions`; `direct` sets `media.src`, every other mode plays HLS with hls.js
 *    (or natively where the browser plays HLS).
 * 3. Seeking past what FFmpeg has produced calls `POST /api/sessions/{id}/seek`. HLS
 *    timestamps restart at 0 then, so `currentTime` adds the server's `start`.
 * 4. `DELETE /api/sessions/{id}` on stop; `sendBeacon` to `/stop` when the tab closes.
 * 5. A lost session (404 from a pod that doesn't hold it, a restarted pod) is restarted at
 *    the same position, with a backoff when the new pod is busy.
 */
export class WavyPlayer extends EventTarget {
  readonly media: HTMLMediaElement;
  readonly apiBase: string;
  autoResume: boolean;
  maxResumes: number;
  withCredentials: boolean;
  hlsConfig: Partial<HlsConfig>;

  state: PlayerState = 'idle';
  path: string | null = null;
  sessionId: string | null = null;
  mode: StreamMode | null = null;
  url: string | null = null;
  probeResult: ProbeResponse | null = null;
  /** Absolute position (seconds) where the current HLS playlist starts. */
  offset = 0;

  private readonly fetchFn: typeof fetch;
  private readonly getToken?: WavyTokenProvider;
  private readonly loadHls?: () => Promise<HlsConstructor>;
  private hlsClass: HlsConstructor | null = null;
  private hls: Hls | null = null;
  private sessionDuration: number | null | undefined;
  private loadToken = 0;
  private mediaRecoveries = 0;
  private resumes: number[] = [];
  private audioTrack: number | undefined;
  private destroyed = false;
  private readonly onMediaError = () => this.onDirectError();
  private readonly onPageHide = () => this.stopOnUnload();
  private readonly stopOnPageHide: boolean;

  constructor(media: HTMLMediaElement, options: WavyPlayerOptions = {}) {
    super();
    this.media = media;
    this.apiBase = (options.apiBase ?? '').replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.getToken = options.getToken;
    this.loadHls = options.loadHls;
    this.hlsConfig = options.hlsConfig ?? {};
    this.autoResume = options.autoResume ?? true;
    this.maxResumes = options.maxResumes ?? 3;
    this.withCredentials = options.withCredentials ?? false;
    this.stopOnPageHide = (options.stopOnPageHide ?? true) && typeof window !== 'undefined';
    if (this.stopOnPageHide) window.addEventListener('pagehide', this.onPageHide);
  }

  /** Listens to a player event; returns the function that stops listening. */
  on<K extends keyof WavyPlayerEvents>(type: K, fn: (detail: WavyPlayerEvents[K]) => void): () => void {
    const listener = (e: Event) => fn((e as CustomEvent<WavyPlayerEvents[K]>).detail);
    this.addEventListener(type, listener);
    return () => this.removeEventListener(type, listener);
  }

  /** Absolute playback position in the file, in seconds. */
  get currentTime(): number {
    return this.offset + (this.media.currentTime || 0);
  }

  /** Full file duration in seconds (from the probe or session), or NaN when unknown. */
  get duration(): number {
    for (const value of [this.probeResult?.duration, this.sessionDuration]) {
      const d = Number(value);
      if (value != null && Number.isFinite(d) && d > 0) return d;
    }
    return this.mode === 'direct' ? this.media.duration : NaN;
  }

  /**
   * Absolute end (seconds) of what can be played without asking the server for a
   * restart: the transcoded part for HLS, the whole file for direct.
   */
  get availableEnd(): number {
    if (this.mode === 'direct') return this.duration;
    const r = this.media.seekable;
    if (!r || r.length === 0) return this.offset;
    return this.offset + r.end(r.length - 1);
  }

  /** GET /api/probe. Resolves with the probe JSON, rejects with PlaybackError. */
  async probe(path: string, headers?: Record<string, string>): Promise<ProbeResponse> {
    return this.request<ProbeResponse>('GET', `/api/probe?path=${encodeURIComponent(path)}`, undefined, headers ?? (await this.authHeaders(path)));
  }

  /**
   * Plays a file, stopping the previous session first. Rejects with a PlaybackError
   * (for example code "unsupported" with the API's reason) instead of leaving a broken
   * player behind.
   */
  load(path: string, opts: LoadOptions = {}): Promise<void> {
    this.resumes = [];
    return this.doLoad(path, opts);
  }

  /**
   * Seeks to an absolute position (seconds). Inside the transcoded part this is a plain
   * media seek; beyond it (or before the current playlist's start) the server restarts
   * FFmpeg at that position.
   */
  async seek(position: number): Promise<void> {
    if (!this.sessionId) return;
    const d = this.duration;
    let target = Math.max(0, Number(position) || 0);
    if (Number.isFinite(d)) target = Math.min(target, Math.max(0, d - 0.5));

    if (this.mode === 'direct') {
      this.media.currentTime = target;
      return;
    }
    const rel = target - this.offset;
    if (rel >= 0 && this.isSeekable(rel)) {
      this.media.currentTime = rel;
      return;
    }

    const token = this.loadToken;
    const sessionId = this.sessionId;
    const wasPaused = this.media.paused;
    this.setState('seeking');
    try {
      const res = await this.request<{ url?: string; start?: number }>(
        'POST',
        `/api/sessions/${encodeURIComponent(sessionId)}/seek`,
        { position: target },
      );
      if (token !== this.loadToken || sessionId !== this.sessionId) return;
      this.offset = finiteOr(res.start, target);
      this.url = res.url || this.url;
      this.attachHls(this.url!);
      this.setState('playing');
      if (!wasPaused) this.play();
    } catch (err) {
      if (token !== this.loadToken) return;
      const error = toPlaybackError(err);
      // The session is gone (another pod answered, or the pod restarted): start a new one there.
      if ((error.status === 404 || error.code === 'network') && this.resume(target, error)) return;
      this.setState('error');
      throw error;
    }
  }

  /** Stops playback and ends the server session (kills FFmpeg, deletes segments). */
  async stop(): Promise<void> {
    const id = this.sessionId;
    this.detach();
    this.sessionId = null;
    this.mode = null;
    this.url = null;
    this.probeResult = null;
    this.sessionDuration = undefined;
    this.offset = 0;
    this.path = null;
    if (this.state !== 'idle') this.setState('idle');
    if (id) await this.deleteSession(id);
  }

  /** Stops, ends the session and removes listeners. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.loadToken++;
    if (this.stopOnPageHide) window.removeEventListener('pagehide', this.onPageHide);
    await this.stop();
  }

  /** Plays the media element, ignoring an autoplay refusal (the user can press play). */
  play(): void {
    const p = this.media.play?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  // --- internals -------------------------------------------------------------

  private async doLoad(path: string, opts: LoadOptions): Promise<void> {
    const token = ++this.loadToken;
    const start = Math.max(0, Number(opts.start) || 0);
    await this.stop();
    if (token !== this.loadToken) return;

    this.path = path;
    this.audioTrack = opts.audioTrack;
    // Report the target position while the new session starts (a resume or a start offset).
    this.offset = start;
    try {
      this.setState('probing');
      // One token covers the probe and the session start.
      const auth = await this.authHeaders(path);
      if (token !== this.loadToken) return;
      const probe = await this.probe(path, auth);
      if (token !== this.loadToken) return;
      this.probeResult = probe;
      if (probe.mode === 'unsupported') {
        throw new PlaybackError('unsupported', probe.reason || "This file can't be played in the browser.");
      }

      this.setState('starting');
      const body: Record<string, unknown> = { path };
      if (start > 0) body['start'] = start;
      if (opts.audioTrack != null) body['audioTrack'] = opts.audioTrack;
      const session = await this.request<SessionResponse>('POST', '/api/sessions', body, auth);
      if (token !== this.loadToken) {
        // A newer load() started while we waited: drop this session.
        void this.deleteSession(session.sessionId);
        return;
      }

      this.sessionId = session.sessionId;
      this.mode = session.mode;
      this.url = session.url;
      this.sessionDuration = session.duration;
      if (this.mode === 'unsupported') {
        throw new PlaybackError('unsupported', session.reason || probe.reason || "This file can't be played in the browser.");
      }
      if (this.mode !== 'direct' && !this.hlsClass && this.loadHls) {
        // hls.js wherever Media Source works: it handles the growing playlist and its retries.
        // Browsers without it (iPhone Safari) play HLS natively.
        let HlsClass: HlsConstructor;
        try {
          HlsClass = await this.loadHls();
        } catch (cause) {
          throw new PlaybackError('hls-load-failed', 'The player failed to load.', { cause });
        }
        if (token !== this.loadToken) return;
        if (typeof HlsClass.isSupported !== 'function' || HlsClass.isSupported() || !this.canPlayHlsNatively()) {
          this.hlsClass = HlsClass;
        }
      }
      if (this.mode !== 'direct' && !this.hlsClass && !this.canPlayHlsNatively()) {
        throw new PlaybackError('no-hls', "hls.js is not loaded, so this file can't be played.");
      }
      this.emit('session', { path, sessionId: session.sessionId, mode: session.mode, url: session.url, probe });

      if (this.mode === 'direct') {
        this.offset = 0;
        this.attachDirect(this.url, start);
      } else {
        // The server may start slightly earlier than asked (keyframe); trust its `start`.
        this.offset = finiteOr(session.start, start);
        this.attachHls(this.url);
      }
      this.setState('playing');
      if (opts.autoplay ?? true) this.play();
    } catch (err) {
      if (token !== this.loadToken) return;
      const error = toPlaybackError(err);
      // Don't leave an FFmpeg process running behind an error message.
      const id = this.sessionId;
      this.detach();
      this.sessionId = null;
      if (id) void this.deleteSession(id);
      this.setState('error');
      throw error;
    }
  }

  private attachDirect(url: string, start: number): void {
    this.destroyHls();
    this.media.addEventListener('error', this.onMediaError);
    if (this.withCredentials) this.media.crossOrigin = 'use-credentials';
    this.media.src = this.resolve(url);
    if (start > 0) {
      const jump = () => {
        this.media.currentTime = start;
      };
      this.media.addEventListener('loadedmetadata', jump, { once: true });
    }
  }

  private attachHls(url: string): void {
    const HlsClass = this.hlsClass;
    this.destroyHls();
    if (!HlsClass) {
      // Safari and iOS play HLS natively.
      this.media.removeEventListener('error', this.onMediaError);
      this.media.addEventListener('error', this.onMediaError);
      if (this.withCredentials) this.media.crossOrigin = 'use-credentials';
      this.media.src = this.resolve(url);
      return;
    }
    if (typeof HlsClass.isSupported === 'function' && !HlsClass.isSupported()) {
      throw new PlaybackError('no-mse', "This browser can't play HLS streams. Use Google Chrome.");
    }
    this.media.removeAttribute('src');
    this.mediaRecoveries = 0;

    const config: Partial<HlsConfig> = {
      // The playlist grows while FFmpeg works (EVENT type, no ENDLIST yet). hls.js treats
      // that as live and would jump to the newest segment; start at the beginning instead.
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
            backoff: 'linear',
            shouldRetry: (retryConfig, retryCount, _isTimeout, response, retry) => {
              const code = response?.code;
              return retry || (retryCount < (retryConfig?.maxNumRetry ?? 0) && (code === 404 || code === 425));
            },
          },
        },
      },
      // Playlist and segment requests carry the sticky-session cookie cross-origin.
      ...(this.withCredentials ? { xhrSetup: (xhr: XMLHttpRequest) => void (xhr.withCredentials = true) } : {}),
      ...this.hlsConfig,
    };
    const hls = new HlsClass(config);
    const events = HlsClass.Events ?? { ERROR: 'hlsError' };
    const types = HlsClass.ErrorTypes ?? { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
    hls.on(events.ERROR, (_event, data) => {
      if (!data?.fatal || hls !== this.hls) return;
      if (data.type === types.MEDIA_ERROR && this.mediaRecoveries < 1) {
        this.mediaRecoveries++;
        hls.recoverMediaError();
        return;
      }
      const status = (data as { response?: { code?: number } }).response?.code;
      const network = data.type === types.NETWORK_ERROR;
      if (network) {
        const position = this.currentTime;
        this.destroyHls();
        if (this.resume(position, new PlaybackError('stream', 'The session was lost.', { status, cause: data }))) return;
      }
      const reason = network
        ? status
          ? `The stream stopped loading (HTTP ${status}). The session may have ended; press Play to restart.`
          : 'The stream stopped loading. Check the connection and press Play to restart.'
        : "The browser couldn't decode this stream.";
      this.destroyHls();
      this.setState('error');
      this.emit('error', new PlaybackError('stream', reason, { status, cause: data }));
    });
    hls.loadSource(this.resolve(url));
    hls.attachMedia(this.media as HTMLVideoElement);
    this.hls = hls;
  }

  private canPlayHlsNatively(): boolean {
    return !!this.media.canPlayType?.('application/vnd.apple.mpegurl');
  }

  private isSeekable(rel: number): boolean {
    const r = this.media.seekable;
    if (!r) return false;
    for (let i = 0; i < r.length; i++) {
      // Keep a small margin at the end: the last segment may still be growing.
      if (rel >= r.start(i) && rel <= r.end(i) - 1) return true;
    }
    return false;
  }

  /**
   * Starts a new session at `position` after the current one was lost. Returns false when
   * auto-resume is off or was used too often in the last minute.
   */
  private resume(position: number, error: PlaybackError, attempt = 0): boolean {
    if (!this.autoResume || !this.path || this.destroyed) return false;
    const start = Math.max(0, Number(position) || 0);
    if (attempt === 0) {
      const now = Date.now();
      this.resumes = this.resumes.filter((t) => now - t < RESUME_WINDOW_MS);
      if (this.resumes.length >= this.maxResumes) return false;
      this.resumes.push(now);
      this.emit('resume', { position: start, error });
    }
    const path = this.path;
    const token = this.loadToken + 1; // the token the doLoad below takes
    this.doLoad(path, { start, audioTrack: this.audioTrack }).catch((err) => {
      const e = toPlaybackError(err);
      // A pod that just went away keeps getting its browsers' requests until the load
      // balancer drops it (a few seconds), and a busy pod answers 503: try again, backing
      // off (2, 4, 8, 8, 8 s: about 30 s in all). These retries don't count as resumes.
      const transient = e.code === 'network' || e.code === 'busy' || e.code === 'capacity' || (e.status ?? 0) >= 500;
      if (transient && token === this.loadToken && attempt < RESUME_RETRIES) {
        const delay = Math.max(1, e.retryAfter ?? Math.min(8, 2 ** (attempt + 1))) * 1000;
        setTimeout(() => {
          if (token === this.loadToken) this.resume(start, e, attempt + 1);
        }, delay);
        return;
      }
      this.emit('error', e);
    });
    return true;
  }

  /** A direct file (or native HLS) stopped loading mid-playback (its session is gone): resume. */
  private onDirectError(): void {
    if (!this.sessionId) return;
    const code = this.media.error?.code;
    // 2 = MEDIA_ERR_NETWORK, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED (what a 404 looks like).
    // A decode error (3) is the file itself and would fail again.
    if (code !== 2 && code !== 4) {
      this.setState('error');
      this.emit('error', new PlaybackError('stream', "The browser couldn't decode this file.", { cause: this.media.error }));
      return;
    }
    if (!(this.media.currentTime > 0)) {
      // Never played: not a lost session, the file itself can't be played here.
      this.setState('error');
      this.emit('error', new PlaybackError('stream', 'The file could not be loaded.', { cause: this.media.error }));
      return;
    }
    const position = this.currentTime;
    if (this.resume(position, new PlaybackError('stream', 'The session was lost.', { cause: this.media.error }))) return;
    this.setState('error');
    this.emit('error', new PlaybackError('stream', 'The file stopped loading. Press Play to restart.'));
  }

  private detach(): void {
    this.media.removeEventListener('error', this.onMediaError);
    this.destroyHls();
    if (this.media.getAttribute?.('src') || this.media.src) {
      this.media.removeAttribute('src');
      this.media.load?.();
    }
  }

  private destroyHls(): void {
    if (this.hls) {
      const hls = this.hls;
      this.hls = null;
      hls.destroy();
    }
  }

  private async deleteSession(id: string): Promise<void> {
    try {
      await this.fetchFn(this.resolve(`/api/sessions/${encodeURIComponent(id)}`), { method: 'DELETE', ...this.credentials() });
    } catch {
      // The server also ends sessions after 60 s without segment requests.
    }
  }

  private stopOnUnload(): void {
    const id = this.sessionId;
    if (!id) return;
    this.sessionId = null;
    const encoded = encodeURIComponent(id);
    // sendBeacon is the most reliable request during page close, but it can only POST,
    // so it goes to the /stop alias of DELETE.
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(this.resolve(`/api/sessions/${encoded}/stop`))) return;
    } catch {
      // fall through to fetch
    }
    try {
      this.fetchFn(this.resolve(`/api/sessions/${encoded}`), { method: 'DELETE', keepalive: true, ...this.credentials() }).catch(() => {});
    } catch {
      // ignore
    }
  }

  private async authHeaders(path: string): Promise<Record<string, string> | undefined> {
    return authHeaders(this.getToken, path);
  }

  private request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    return apiRequest<T>(this.fetchFn, this.resolve(path), method, body, extraHeaders, this.withCredentials);
  }

  private credentials(): RequestInit {
    return this.withCredentials ? { credentials: 'include' } : {};
  }

  private resolve(url: string): string {
    return resolveUrl(this.apiBase, url);
  }

  private setState(state: PlayerState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('statechange', { state });
  }

  private emit<K extends keyof WavyPlayerEvents>(type: K, detail: WavyPlayerEvents[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/** `Authorization: Bearer` headers for `path`, or undefined when there is no token. */
export async function authHeaders(getToken: WavyTokenProvider | undefined, path: string): Promise<Record<string, string> | undefined> {
  if (!getToken) return undefined;
  let t: string | null | undefined;
  try {
    t = await getToken(path);
  } catch (err) {
    if (err instanceof PlaybackError) throw err;
    throw new PlaybackError('unauthorized', "You don't have access to this file.", { cause: err });
  }
  return t ? { authorization: `Bearer ${t}` } : undefined;
}

/** Calls the API and returns its JSON, or throws a PlaybackError built from `{ error, reason }`. */
export async function apiRequest<T>(
  fetchFn: typeof fetch,
  url: string,
  method: string,
  body: unknown,
  extraHeaders: Record<string, string> | undefined,
  withCredentials: boolean,
): Promise<T> {
  const headers: Record<string, string> = { ...(body ? { 'content-type': 'application/json' } : {}), ...(extraHeaders ?? {}) };
  let res: Response;
  try {
    res = await fetchFn(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      ...(withCredentials ? { credentials: 'include' as const } : {}),
    });
  } catch (err) {
    throw new PlaybackError('network', 'Could not reach the playback service.', { cause: err });
  }

  let data: { error?: string; reason?: string } | null = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const retryAfter = parseRetryAfter(res.headers?.get?.('retry-after'));
    const code = data?.error || (res.status === 503 ? 'busy' : res.status === 404 ? 'not-found' : 'http');
    const reason =
      data?.reason ||
      (res.status === 404
        ? 'The file was not found.'
        : res.status === 503
          ? 'The playback server is busy.'
          : `The playback service returned HTTP ${res.status}.`);
    throw new PlaybackError(code, reason, { status: res.status, retryAfter });
  }
  if (data === null) throw new PlaybackError('bad-response', 'The playback service sent an unreadable response.', { status: res.status });
  return data as T;
}

export function resolveUrl(apiBase: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return apiBase + (url.startsWith('/') ? url : `/${url}`);
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? n : fallback;
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}
