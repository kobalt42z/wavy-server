import { EnvironmentProviders, InjectionToken, makeEnvironmentProviders } from '@angular/core';
import type { HlsConfig } from 'hls.js';

/**
 * Returns the access token for a file: a JWT the main server signs (see the server's
 * docs/access-tokens.md). Called before each probe, waveform and session start, including
 * every automatic resume, so return a fresh token each time (they expire within minutes).
 * Return null when the service runs without auth. Throwing fails playback with
 * "You don't have access to this file."
 */
export type WavyTokenProvider = (path: string) => string | null | undefined | Promise<string | null | undefined>;

export interface WavyConfig {
  /** Where the playback service is, e.g. "https://media.example.com". Default: the page's origin. */
  apiBase?: string;
  /** Access tokens for AUTH_MODE=jwt. Leave out when the service is open. */
  getToken?: WavyTokenProvider;
  /**
   * Send cookies with every request (fetch `credentials: "include"`, hls.js `withCredentials`,
   * `crossorigin="use-credentials"`), so a load balancer's sticky-session cookie reaches a
   * service on another origin. The service's CORS_ORIGINS must list the page's origin.
   * Same-origin requests send cookies anyway. Default false.
   */
  withCredentials?: boolean;
  /** Start a new session at the same position when the current one is lost (default true). */
  autoResume?: boolean;
  /** Resumes allowed per minute before giving up (default 3). */
  maxResumes?: number;
  /** End the session with sendBeacon when the tab closes (default true). */
  stopOnPageHide?: boolean;
  /** Extra hls.js settings, merged over the player's own. */
  hlsConfig?: Partial<HlsConfig>;
  /** The fetch to use (default: the global fetch). */
  fetch?: typeof fetch;
}

/** The app-wide Wavy settings. Set them with `provideWavy()`. */
export const WAVY_CONFIG = new InjectionToken<WavyConfig>('WAVY_CONFIG', {
  providedIn: 'root',
  factory: () => ({}),
});

/**
 * Configures the Wavy components for the app:
 *
 * ```ts
 * bootstrapApplication(App, {
 *   providers: [provideWavy({ apiBase: 'https://media.example.com', withCredentials: true, getToken })],
 * });
 *
 * // or, when getToken needs services:
 * provideWavy(() => {
 *   const http = inject(HttpClient);
 *   return { getToken: (path) => firstValueFrom(http.post<{ token: string }>('/media/token', { path })).then((r) => r.token) };
 * });
 * ```
 */
export function provideWavy(config: WavyConfig | (() => WavyConfig)): EnvironmentProviders {
  // A function runs in an injection context, so it can inject() what getToken needs.
  return makeEnvironmentProviders([
    { provide: WAVY_CONFIG, useFactory: typeof config === 'function' ? config : () => config },
  ]);
}

/**
 * Wraps a token provider so each path's token is reused for `maxAgeSec` (default 240 s)
 * instead of asking the main server again for the waveform, the probe and the session.
 * Keep `maxAgeSec` well below the token lifetime and the service's JWT_MAX_TOKEN_AGE_SEC.
 * Concurrent requests for the same path share one call; failures are not cached.
 */
export function cacheTokens(getToken: WavyTokenProvider, options: { maxAgeSec?: number; maxEntries?: number } = {}): WavyTokenProvider {
  const maxAgeMs = (options.maxAgeSec ?? 240) * 1000;
  const maxEntries = options.maxEntries ?? 500;
  const cache = new Map<string, { at: number; token: Promise<string | null | undefined> }>();
  return (path) => {
    const now = Date.now();
    const hit = cache.get(path);
    if (hit && now - hit.at < maxAgeMs) return hit.token;
    const token = Promise.resolve().then(() => getToken(path));
    cache.set(path, { at: now, token });
    token.catch(() => {
      if (cache.get(path)?.token === token) cache.delete(path);
    });
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    return token;
  };
}
