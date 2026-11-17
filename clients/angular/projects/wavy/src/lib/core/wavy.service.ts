import { Injectable, inject } from '@angular/core';
import { WAVY_CONFIG } from './config';
import { HLS_LOADER } from './hls-loader';
import { WavyPlayer, WavyPlayerOptions, apiRequest, authHeaders, resolveUrl } from './player';
import type { PeaksResponse, ProbeResponse } from './types';

/**
 * Talks to the playback service with the settings from `provideWavy()`. The components use
 * it; inject it yourself to build a custom player or prefetch waveforms.
 */
@Injectable({ providedIn: 'root' })
export class WavyService {
  readonly config = inject(WAVY_CONFIG);
  private readonly loadHls = inject(HLS_LOADER);

  /** A player for `media` with the app's settings; `overrides` win. Call `destroy()` when done. */
  createPlayer(media: HTMLMediaElement, overrides: Partial<WavyPlayerOptions> = {}): WavyPlayer {
    const c = this.config;
    return new WavyPlayer(media, {
      apiBase: c.apiBase,
      fetch: c.fetch,
      getToken: c.getToken,
      withCredentials: c.withCredentials,
      autoResume: c.autoResume,
      maxResumes: c.maxResumes,
      stopOnPageHide: c.stopOnPageHide,
      hlsConfig: c.hlsConfig,
      loadHls: this.loadHls,
      ...overrides,
    });
  }

  /** GET /api/probe: codecs, duration and the playback mode. */
  async probe(path: string): Promise<ProbeResponse> {
    return this.get<ProbeResponse>(`/api/probe?path=${encodeURIComponent(path)}`, path);
  }

  /**
   * GET /api/peaks: `count` loudness values (0 to 1) across the file's audio, for a waveform.
   * Needs a server with the peaks endpoint; rejects with a PlaybackError otherwise.
   */
  async peaks(path: string, count = 100, audioTrack?: number): Promise<PeaksResponse> {
    let q = `/api/peaks?path=${encodeURIComponent(path)}&count=${count}`;
    if (audioTrack != null) q += `&audioTrack=${audioTrack}`;
    return this.get<PeaksResponse>(q, path);
  }

  /** The absolute URL of an API path. */
  url(path: string): string {
    return resolveUrl((this.config.apiBase ?? '').replace(/\/+$/, ''), path);
  }

  private async get<T>(apiPath: string, filePath: string): Promise<T> {
    const fetchFn = this.config.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    const headers = await authHeaders(this.config.getToken, filePath);
    return apiRequest<T>(fetchFn, this.url(apiPath), 'GET', undefined, headers, this.config.withCredentials ?? false);
  }
}
