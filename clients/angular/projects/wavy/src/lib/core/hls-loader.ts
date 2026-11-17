import { InjectionToken } from '@angular/core';
import type Hls from 'hls.js';

/** The hls.js class, or a stand-in with the same API. */
export type HlsConstructor = typeof Hls;

/**
 * Loads hls.js. The default imports it lazily, so pages that only play direct files
 * never download it. Override this token to supply your own build, or a fake in tests.
 */
export const HLS_LOADER = new InjectionToken<() => Promise<HlsConstructor>>('HLS_LOADER', {
  providedIn: 'root',
  factory: () => () => import('hls.js').then((m) => m.default),
});
