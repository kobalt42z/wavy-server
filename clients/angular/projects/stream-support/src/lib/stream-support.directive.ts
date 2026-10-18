import {
  Directive,
  ElementRef,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type Hls from 'hls.js';
import type { HlsConfig } from 'hls.js';
import { HLS_LOADER } from './hls-loader';
import { PlaybackStream, StreamEngine, StreamError, StreamInput } from './types';

const HLS_MIME = 'application/vnd.apple.mpegurl';

/**
 * Plays a playback-service stream in a native `<video>` (or `<audio>`) element.
 *
 * Direct files go to `src`. HLS streams play natively when the browser can (Safari, iOS),
 * otherwise through hls.js. Changing the input or destroying the element tears the old
 * stream down first. The directive never calls the playback API; pass it the session.
 *
 * ```html
 * <video controls [streamSupport]="session" (streamError)="show($event.message)"></video>
 * ```
 */
@Directive({
  selector: 'video[streamSupport], audio[streamSupport]',
  exportAs: 'streamSupport',
  host: {
    '(timeupdate)': 'onTimeUpdate()',
    '(durationchange)': 'onTimeUpdate()',
    '(emptied)': 'onTimeUpdate()',
  },
})
export class StreamSupportDirective {
  /** The stream to play: a session response, a URL, or null for nothing. */
  readonly streamSupport = input<StreamInput>();
  /** Extra hls.js settings, used only when hls.js plays the stream. */
  readonly hlsConfig = input<Partial<HlsConfig>>({});

  /** Emits when the stream can't be played, including unsupported files. */
  readonly streamError = output<StreamError>();
  /** Emits the service's reason when the file is unsupported (also sent to `streamError`). */
  readonly streamUnsupported = output<string>();
  /** Emits once the media metadata has loaded, with the player in use. */
  readonly streamReady = output<StreamEngine>();

  /** The player attached right now, or null. */
  readonly engine = signal<StreamEngine | null>(null);
  /** The last error for the current stream, or null. */
  readonly error = signal<StreamError | null>(null);

  private readonly media = inject<ElementRef<HTMLMediaElement>>(ElementRef).nativeElement;
  private readonly loadHls = inject(HLS_LOADER);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  // A new object with the same url and mode is the same stream, so parents can rebuild it freely.
  private readonly stream = computed(() => normalize(this.streamSupport()), { equal: sameStream });
  private readonly mediaTime = signal(0);
  private readonly mediaDuration = signal(NaN);

  /** Where playback is in the source file, in seconds (`currentTime` plus the stream's `start`). */
  readonly position = computed(() => this.mediaTime() + (this.stream()?.start ?? 0));
  /** Full length of the source file: the stream's `duration`, or what the element reports. */
  readonly totalDuration = computed(() => {
    const s = this.stream();
    if (s?.duration != null) return s.duration;
    const d = this.mediaDuration();
    return Number.isFinite(d) ? d + (s?.start ?? 0) : NaN;
  });

  constructor() {
    effect((onCleanup) => {
      const stream = this.stream();
      const config = this.hlsConfig();
      if (!this.browser) return;
      const teardown = untracked(() => this.attach(stream, config));
      onCleanup(teardown);
    });
  }

  protected onTimeUpdate(): void {
    this.mediaTime.set(this.media.currentTime || 0);
    this.mediaDuration.set(this.media.duration);
  }

  /** Starts playing `stream` and returns the function that stops it. */
  private attach(stream: PlaybackStream | null, config: Partial<HlsConfig>): () => void {
    this.error.set(null);
    this.engine.set(null);
    if (!stream) return () => {};

    if (stream.mode === 'unsupported') {
      const reason = stream.reason || 'This file cannot be played.';
      this.streamUnsupported.emit(reason);
      this.fail({ kind: 'unsupported', message: reason });
      return () => {};
    }
    if (!stream.url) {
      this.fail({ kind: 'invalid-stream', message: 'The stream has no URL to play.' });
      return () => {};
    }

    const onMetadata = () => {
      const engine = this.engine();
      if (engine) this.streamReady.emit(engine);
    };
    this.media.addEventListener('loadedmetadata', onMetadata);
    const stopMetadata = () => this.media.removeEventListener('loadedmetadata', onMetadata);

    if (stream.mode === 'direct' || this.media.canPlayType(HLS_MIME)) {
      const stop = this.playNative(stream.url, stream.mode === 'direct' ? 'native' : 'native-hls');
      return () => {
        stopMetadata();
        stop();
      };
    }

    let cancelled = false;
    let hls: Hls | null = null;
    this.loadHls().then(
      (HlsClass) => {
        if (cancelled) return;
        if (!HlsClass.isSupported()) {
          this.fail({ kind: 'hls-unsupported', message: 'This browser cannot play HLS streams.' });
          return;
        }
        hls = this.playHlsJs(HlsClass, stream.url!, config);
      },
      (cause) => {
        if (!cancelled) this.fail({ kind: 'hls-load-failed', message: 'The video player failed to load.', cause });
      },
    );
    return () => {
      cancelled = true;
      stopMetadata();
      if (hls) hls.destroy();
      this.clearSource();
    };
  }

  private playNative(url: string, engine: StreamEngine): () => void {
    const onError = () => {
      const err = this.media.error;
      this.fail({ kind: 'media', message: mediaErrorMessage(err), cause: err });
    };
    this.media.addEventListener('error', onError);
    this.engine.set(engine);
    this.media.src = url;
    this.media.load();
    return () => {
      this.media.removeEventListener('error', onError);
      this.clearSource();
    };
  }

  private playHlsJs(HlsClass: typeof Hls, url: string, config: Partial<HlsConfig>): Hls {
    const hls = new HlsClass(config);
    let recovered = false;
    hls.on(HlsClass.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && !recovered) {
        recovered = true;
        hls.recoverMediaError();
        return;
      }
      const network = data.type === HlsClass.ErrorTypes.NETWORK_ERROR;
      this.fail({
        kind: network ? 'network' : 'media',
        message: network ? 'The stream could not be loaded.' : 'The stream could not be played.',
        cause: data,
      });
      hls.destroy();
      this.engine.set(null);
    });
    this.engine.set('hls.js');
    hls.attachMedia(this.media as HTMLVideoElement);
    hls.loadSource(url);
    return hls;
  }

  private clearSource(): void {
    this.engine.set(null);
    if (!this.media.hasAttribute('src') && !this.media.currentSrc) return;
    this.media.removeAttribute('src');
    this.media.load();
  }

  private fail(error: StreamError): void {
    this.error.set(error);
    this.streamError.emit(error);
  }
}

function normalize(value: StreamInput): PlaybackStream | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const hls = /\.m3u8($|[?#])/i.test(value);
    return { url: value, mode: hls ? 'remux' : 'direct' };
  }
  return value;
}

function sameStream(a: PlaybackStream | null, b: PlaybackStream | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.url === b.url && a.mode === b.mode && a.reason === b.reason && a.start === b.start && a.duration === b.duration;
}

function mediaErrorMessage(err: MediaError | null): string {
  switch (err?.code) {
    case 1:
      return 'Playback was aborted.';
    case 2:
      return 'A network error stopped the download.';
    case 3:
      return 'The file could not be decoded.';
    case 4:
      return 'This format is not supported by the browser.';
    default:
      return 'The file could not be played.';
  }
}
