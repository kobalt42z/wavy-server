import { Injectable, computed, signal } from '@angular/core';
import { PlaybackError, describeError, toPlaybackError } from './errors';
import type { WavyPlayer } from './player';
import type { PlayerState } from './types';

/**
 * Wraps a WavyPlayer and its media element in signals, and starts the session lazily:
 * nothing is requested from the server (no FFmpeg is started) until the first `play()`.
 * Used by `<wavy-video>` and `<wavy-audio>`; use it to build your own controls.
 */
export class MediaController {
  /** The player's state: idle, probing, starting, playing, seeking or error. */
  readonly state = signal<PlayerState>('idle');
  /** True between `play` and `pause`/`ended`. */
  readonly playing = signal(false);
  /** True while the element waits for data (buffering). */
  readonly waiting = signal(false);
  /** Absolute position in seconds. */
  readonly position = signal(0);
  /** Full length in seconds, NaN while unknown. */
  readonly duration = signal(NaN);
  /** Absolute end of what can be played without a server restart. */
  readonly availableEnd = signal(0);
  readonly error = signal<PlaybackError | null>(null);
  /** A session was started for the current path. */
  readonly started = signal(false);
  readonly volume = signal(1);
  readonly muted = signal(false);
  readonly rate = signal(1);

  /** A spinner should show: the session is starting, seeking, or the element is buffering. */
  readonly busy = computed(() => {
    const s = this.state();
    return s === 'probing' || s === 'starting' || s === 'seeking' || (this.waiting() && this.playing());
  });
  /** The error as one sentence, or ''. */
  readonly message = computed(() => {
    const e = this.error();
    return e ? describeError(e) : '';
  });

  private path: string | null = null;
  private audioTrack: number | undefined;
  /** Where the next session starts (a seek before the first play, or after an error). */
  private pendingStart = 0;
  private readonly off: (() => void)[] = [];

  constructor(readonly player: WavyPlayer) {
    const media = player.media;
    const listen = (type: string, fn: () => void) => {
      media.addEventListener(type, fn);
      this.off.push(() => media.removeEventListener(type, fn));
    };
    const sync = () => this.syncTime();
    listen('timeupdate', sync);
    listen('durationchange', sync);
    listen('progress', sync);
    listen('loadedmetadata', sync);
    listen('play', () => this.playing.set(true));
    listen('playing', () => {
      this.playing.set(true);
      this.waiting.set(false);
    });
    listen('pause', () => this.playing.set(false));
    listen('waiting', () => this.waiting.set(true));
    listen('canplay', () => this.waiting.set(false));
    listen('ended', () => {
      this.playing.set(false);
      this.onEnded?.();
    });
    listen('volumechange', () => {
      this.volume.set(media.volume);
      this.muted.set(media.muted);
    });
    listen('ratechange', () => this.rate.set(media.playbackRate));
    this.off.push(
      player.on('statechange', ({ state }) => {
        this.state.set(state);
        this.syncTime();
      }),
      player.on('error', (err) => this.fail(err)),
      player.on('session', () => {
        // load() resets the element's rate; keep the one the user picked.
        media.defaultPlaybackRate = this.rate();
        media.playbackRate = this.rate();
      }),
    );
  }

  /** Called when playback reaches the end. */
  onEnded?: () => void;

  /** Sets the file. Stops the current session; the next one starts on `play()`. */
  setSource(path: string | null, opts: { audioTrack?: number; start?: number; duration?: number } = {}): void {
    this.path = path;
    this.audioTrack = opts.audioTrack;
    this.pendingStart = Math.max(0, opts.start ?? 0);
    this.started.set(false);
    this.error.set(null);
    this.playing.set(false);
    this.waiting.set(false);
    this.position.set(this.pendingStart);
    this.duration.set(opts.duration ?? NaN);
    this.availableEnd.set(0);
    void this.player.stop();
  }

  /** Sets the duration before a session exists (from a probe or the waveform). */
  knownDuration(seconds: number | null | undefined): void {
    if (seconds != null && Number.isFinite(seconds) && seconds > 0 && !this.started()) this.duration.set(seconds);
  }

  /** Starts the session on first call, then resumes the element. */
  async play(): Promise<void> {
    if (!this.path) return;
    // A session is already starting (a first play or an automatic resume).
    if (this.player.state === 'probing' || this.player.state === 'starting') return;
    this.error.set(null);
    if (!this.started() || this.player.state === 'error' || !this.player.sessionId) {
      this.started.set(true);
      const start = this.pendingStart;
      try {
        await this.player.load(this.path, { start, audioTrack: this.audioTrack });
      } catch (err) {
        this.started.set(false);
        this.fail(toPlaybackError(err));
      }
      return;
    }
    if (this.player.media.ended) await this.seek(0);
    this.player.play();
  }

  pause(): void {
    this.player.media.pause();
  }

  toggle(): Promise<void> {
    if (this.playing()) {
      this.pause();
      return Promise.resolve();
    }
    return this.play();
  }

  /** Seeks to an absolute position. Before the first play it only moves the start point. */
  async seek(seconds: number): Promise<void> {
    const d = this.duration();
    const target = Math.max(0, Number.isFinite(d) ? Math.min(seconds, d) : seconds);
    if (!this.started() || !this.player.sessionId) {
      this.pendingStart = target;
      this.position.set(target);
      return;
    }
    this.position.set(target);
    try {
      await this.player.seek(target);
    } catch (err) {
      this.fail(toPlaybackError(err));
    }
  }

  setVolume(v: number): void {
    const media = this.player.media;
    media.volume = Math.min(1, Math.max(0, v));
    if (media.volume > 0) media.muted = false;
  }

  toggleMute(): void {
    this.player.media.muted = !this.player.media.muted;
  }

  setRate(rate: number): void {
    this.rate.set(rate);
    this.player.media.defaultPlaybackRate = rate;
    this.player.media.playbackRate = rate;
  }

  /** Stops the session and listeners. */
  destroy(): void {
    for (const f of this.off.splice(0)) f();
    void this.player.destroy();
  }

  private syncTime(): void {
    const p = this.player;
    if (!p.sessionId) return;
    if (p.state === 'playing') this.position.set(p.currentTime);
    const d = p.duration;
    if (Number.isFinite(d) && d > 0) this.duration.set(d);
    const end = p.availableEnd;
    this.availableEnd.set(Number.isFinite(end) ? end : 0);
  }

  private fail(err: PlaybackError): void {
    // The next play() starts a new session where this one stopped.
    this.pendingStart = this.position();
    this.started.set(false);
    this.playing.set(false);
    this.waiting.set(false);
    this.error.set(err);
    this.onError?.(err);
  }

  /** Called with every error (also shown through `error`). */
  onError?: (err: PlaybackError) => void;
}

/** Lets only one `<wavy-audio>` (or video) play at a time, like a chat app. */
@Injectable({ providedIn: 'root' })
export class WavyPlaybackFocus {
  private current: MediaController | null = null;

  /** `controller` started playing: pause the one that played before. */
  take(controller: MediaController): void {
    if (this.current && this.current !== controller) this.current.pause();
    this.current = controller;
  }

  release(controller: MediaController): void {
    if (this.current === controller) this.current = null;
  }
}
