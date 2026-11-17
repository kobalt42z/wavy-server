import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  numberAttribute,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { PlaybackError, formatTime, toPlaybackError } from '../core/errors';
import { MediaController, WavyPlaybackFocus } from '../core/media-controller';
import type { ProbeResponse } from '../core/types';
import { WavyService } from '../core/wavy.service';

const optionalNumber = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : numberAttribute(v));

/**
 * Plays a file from the wavy playback service: probe, session, direct file or HLS, seeking
 * beyond what FFmpeg has produced, and a new session at the same position when the current
 * one is lost (a pod restart, or a 404 from a pod that doesn't hold it).
 *
 * The session starts on the first play (or right away with `autoplay`). The custom controls
 * show the file's real timeline, including after a server-side seek; `controls="native"`
 * uses the browser's controls instead.
 *
 * ```html
 * <wavy-video path="cctv/2026-10-01/cam3.dav" [start]="30" (playbackError)="log($event)" />
 * ```
 */
@Component({
  selector: 'wavy-video',
  exportAs: 'wavyVideo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'wavy-video',
    '[attr.tabindex]': "controls() === 'custom' ? 0 : null",
    '[class.wavy-video--idle]': 'controlsHidden()',
    '(mousemove)': 'poke()',
    '(mouseleave)': 'hideSoon(0)',
    '(keydown)': 'onKey($event)',
  },
  template: `
    <video
      #media
      playsinline
      preload="none"
      [attr.poster]="poster() || null"
      [controls]="controls() === 'native'"
      (click)="controls() === 'custom' && toggle()"
      (dblclick)="controls() === 'custom' && toggleFullscreen()"
    ></video>
    @if (controls() === 'custom') {
      @if (busy()) {
        <div class="wavy-video__spinner" aria-label="Loading" role="status"></div>
      } @else if (!playing() && !message()) {
        <button type="button" class="wavy-video__big-play" aria-label="Play" (click)="toggle()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8c0 .8.9 1.3 1.6.9l10-6.4c.6-.4.6-1.3 0-1.7l-10-6.4C8.9 4.3 8 4.8 8 5.6z" /></svg>
        </button>
      }
      @if (message()) {
        <div class="wavy-video__error" role="alert">
          <p>{{ message() }}</p>
          @if (retryable()) {
            <button type="button" (click)="toggle()">Try again</button>
          }
        </div>
      }
      <div class="wavy-video__bar">
        <button type="button" class="wavy-video__btn" [attr.aria-label]="playing() ? 'Pause' : 'Play'" (click)="toggle()">
          @if (playing()) {
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          } @else {
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8c0 .8.9 1.3 1.6.9l10-6.4c.6-.4.6-1.3 0-1.7l-10-6.4C8.9 4.3 8 4.8 8 5.6z" /></svg>
          }
        </button>
        <span class="wavy-video__time">{{ timeLabel() }}</span>
        <input
          class="wavy-video__seek"
          type="range"
          min="0"
          step="0.1"
          aria-label="Seek"
          [max]="seekMax()"
          [value]="seekValue()"
          [style.background]="seekBackground()"
          [attr.aria-valuetext]="timeLabel()"
          (input)="onScrub($event)"
          (change)="onSeek($event)"
        />
        <button type="button" class="wavy-video__btn" [attr.aria-label]="muted() ? 'Unmute' : 'Mute'" (click)="ctl()?.toggleMute()">
          @if (muted() || volume() === 0) {
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.6 3 2.7-2.7-1.1-1.1-2.7 2.7-2.7-2.7-1.1 1.1 2.7 2.7-2.7 2.7 1.1 1.1 2.7-2.7 2.7 2.7 1.1-1.1z" /></svg>
          } @else {
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm11.5 3A4.5 4.5 0 0 0 13 8v8a4.5 4.5 0 0 0 2.5-4zM13 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" /></svg>
          }
        </button>
        <input
          class="wavy-video__volume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          aria-label="Volume"
          [value]="muted() ? 0 : volume()"
          (input)="onVolume($event)"
        />
        <button type="button" class="wavy-video__btn wavy-video__rate" [attr.aria-label]="'Playback speed ' + rate() + 'x'" (click)="cycleRate()">
          {{ rate() }}×
        </button>
        <button type="button" class="wavy-video__btn" aria-label="Full screen" (click)="toggleFullscreen()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h5v2H7v3H5V5zm9 0h5v5h-2V7h-3V5zM5 14h2v3h3v2H5v-5zm12 3v-3h2v5h-5v-2h3z" /></svg>
        </button>
      </div>
    }
  `,
  styles: `
    :host {
      --_accent: var(--wavy-video-accent, #2f80ed);
      --_fg: var(--wavy-video-fg, #ffffff);
      position: relative;
      display: block;
      overflow: hidden;
      aspect-ratio: var(--wavy-video-aspect-ratio, 16 / 9);
      background: var(--wavy-video-bg, #000);
      color: var(--_fg);
      border-radius: var(--wavy-video-radius, 8px);
      font: 13px/1.3 var(--wavy-video-font, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
      outline: none;
    }
    video { display: block; width: 100%; height: 100%; object-fit: contain; background: transparent; }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
    .wavy-video__big-play {
      position: absolute;
      inset: 0;
      margin: auto;
      width: 68px;
      height: 68px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.55);
    }
    .wavy-video__big-play svg { width: 34px; height: 34px; fill: currentColor; margin-left: 3px; }
    .wavy-video__spinner {
      position: absolute;
      inset: 0;
      margin: auto;
      width: 44px;
      height: 44px;
      border: 4px solid rgba(255, 255, 255, 0.25);
      border-top-color: var(--_fg);
      border-radius: 50%;
      animation: wavy-video-spin 0.8s linear infinite;
      pointer-events: none;
    }
    @keyframes wavy-video-spin { to { transform: rotate(360deg); } }
    .wavy-video__error {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 24px;
      text-align: center;
      background: rgba(0, 0, 0, 0.7);
    }
    .wavy-video__error p { margin: 0; max-width: 46ch; }
    .wavy-video__error button {
      padding: 6px 16px;
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 16px;
      background: transparent;
    }
    .wavy-video__bar {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 24px 10px 8px;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
      transition: opacity 0.2s;
    }
    :host(.wavy-video--idle) .wavy-video__bar { opacity: 0; pointer-events: none; }
    :host(.wavy-video--idle) { cursor: none; }
    .wavy-video__btn {
      flex: none;
      display: grid;
      place-items: center;
      min-width: 32px;
      height: 32px;
      padding: 0 4px;
      border: 0;
      border-radius: 6px;
      background: transparent;
    }
    .wavy-video__btn svg { width: 22px; height: 22px; fill: currentColor; }
    .wavy-video__rate { font-weight: 600; font-variant-numeric: tabular-nums; }
    .wavy-video__time { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
    input[type='range'] {
      -webkit-appearance: none;
      appearance: none;
      height: 4px;
      margin: 0;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.3);
      cursor: pointer;
    }
    input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      border: 0;
      border-radius: 50%;
      background: var(--_fg);
    }
    input[type='range']::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: var(--_fg); }
    .wavy-video__seek { flex: 1; min-width: 60px; }
    .wavy-video__volume { flex: none; width: 70px; }
    @media (max-width: 480px) {
      .wavy-video__volume, .wavy-video__rate { display: none; }
    }
  `,
})
export class WavyVideoComponent {
  /** Path of the file relative to the media root (or the URL a token grants). */
  readonly path = input.required<string>();
  /** Where to start, in seconds. */
  readonly start = input<number | undefined, unknown>(undefined, { transform: optionalNumber });
  /** An `audio[].track` value from the probe. */
  readonly audioTrack = input<number | undefined, unknown>(undefined, { transform: optionalNumber });
  readonly poster = input<string | undefined>(undefined);
  /** Start the session and play as soon as the path is set (browsers may block sound). */
  readonly autoplay = input(false, { transform: booleanAttribute });
  /** 'custom' (default) shows the file's real timeline; 'native' the browser's controls; 'none' nothing. */
  readonly controls = input<'custom' | 'native' | 'none'>('custom');
  /** Pause other Wavy players when this one starts (default false for video). */
  readonly exclusive = input(false, { transform: booleanAttribute });
  /** Probe on load to show the duration and refuse unsupported files early (default true). */
  readonly probeOnLoad = input(true, { transform: booleanAttribute });
  readonly rates = input<readonly number[]>([1, 1.25, 1.5, 2, 0.5]);

  readonly playbackError = output<PlaybackError>();
  /** The probe result, once known. */
  readonly probed = output<ProbeResponse>();
  readonly started = output<void>();
  readonly ended = output<void>();
  /** A lost session is being restarted at `position`. */
  readonly resumed = output<number>();

  private readonly service = inject(WavyService);
  private readonly focus = inject(WavyPlaybackFocus);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly mediaRef = viewChild.required<ElementRef<HTMLVideoElement>>('media');

  readonly ctl = signal<MediaController | null>(null);
  private readonly scrub = signal<number | null>(null);
  private readonly idle = signal(false);
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  readonly playing = computed(() => this.ctl()?.playing() ?? false);
  readonly busy = computed(() => this.ctl()?.busy() ?? false);
  readonly message = computed(() => this.ctl()?.message() ?? '');
  readonly retryable = computed(() => this.ctl()?.error()?.code !== 'unsupported');
  readonly volume = computed(() => this.ctl()?.volume() ?? 1);
  readonly muted = computed(() => this.ctl()?.muted() ?? false);
  readonly rate = computed(() => this.ctl()?.rate() ?? 1);
  readonly position = computed(() => this.scrub() ?? this.ctl()?.position() ?? 0);
  readonly duration = computed(() => this.ctl()?.duration() ?? NaN);
  readonly controlsHidden = computed(() => this.idle() && this.playing() && !this.message());
  readonly timeLabel = computed(() => `${formatTime(this.position())} / ${formatTime(this.duration())}`);
  readonly seekMax = computed(() => {
    const d = this.duration();
    return Number.isFinite(d) && d > 0 ? d : 0;
  });
  readonly seekValue = computed(() => Math.min(this.position(), this.seekMax()));
  /** Played part, then the part that plays without a server restart, then the rest. */
  readonly seekBackground = computed(() => {
    const d = this.seekMax();
    if (!d) return null;
    const played = (this.seekValue() / d) * 100;
    const available = Math.max(played, Math.min(100, ((this.ctl()?.availableEnd() ?? 0) / d) * 100));
    return (
      `linear-gradient(to right, var(--_accent) 0 ${played}%, rgba(255,255,255,0.55) ${played}% ${available}%, ` +
      `rgba(255,255,255,0.25) ${available}% 100%)`
    );
  });

  constructor() {
    const destroyRef = inject(DestroyRef);

    afterNextRender(() => {
      const media = this.mediaRef().nativeElement;
      const player = this.service.createPlayer(media);
      const c = new MediaController(player);
      c.onError = (err) => this.playbackError.emit(err);
      c.onEnded = () => {
        this.focus.release(c);
        this.ended.emit();
      };
      const offResume = player.on('resume', ({ position }) => this.resumed.emit(position));
      const onPlay = () => {
        if (this.exclusive()) this.focus.take(c);
        // Native controls: pressing play before a session exists starts one.
        if (!player.sessionId && player.state === 'idle') {
          media.pause();
          void c.play();
          return;
        }
        this.started.emit();
        this.hideSoon();
      };
      const onPause = () => this.poke();
      media.addEventListener('play', onPlay);
      media.addEventListener('pause', onPause);
      this.ctl.set(c);
      destroyRef.onDestroy(() => {
        offResume();
        media.removeEventListener('play', onPlay);
        media.removeEventListener('pause', onPause);
        clearTimeout(this.idleTimer);
        this.focus.release(c);
        c.destroy();
      });
    });

    effect((onCleanup) => {
      const c = this.ctl();
      const path = this.path();
      const start = this.start();
      const audioTrack = this.audioTrack();
      const autoplay = this.autoplay();
      const probe = this.probeOnLoad();
      if (!c) return;
      untracked(() => {
        c.setSource(path || null, { start, audioTrack });
        if (!path) return;
        if (autoplay) {
          void c.play();
          return;
        }
        if (!probe || !this.browser) return;
        let cancelled = false;
        onCleanup(() => (cancelled = true));
        this.service.probe(path).then(
          (res) => {
            if (cancelled) return;
            this.probed.emit(res);
            c.knownDuration(res.duration);
            if (res.mode === 'unsupported') {
              const e = new PlaybackError('unsupported', res.reason || "This file can't be played in the browser.");
              c.error.set(e);
              this.playbackError.emit(e);
            }
          },
          (err) => {
            const e = toPlaybackError(err);
            // Show an unplayable or forbidden file now; other errors surface on play.
            if (!cancelled && ['unsupported', 'forbidden', 'unauthorized', 'not_found', 'not-found'].includes(e.code)) {
              c.error.set(e);
              this.playbackError.emit(e);
            }
          },
        );
      });
    });
  }

  toggle(): void {
    this.poke();
    void this.ctl()?.toggle();
  }

  play(): Promise<void> {
    return this.ctl()?.play() ?? Promise.resolve();
  }

  pause(): void {
    this.ctl()?.pause();
  }

  /** Seeks to an absolute position in the file, in seconds. */
  seek(seconds: number): Promise<void> {
    return this.ctl()?.seek(seconds) ?? Promise.resolve();
  }

  cycleRate(): void {
    const c = this.ctl();
    if (!c) return;
    const rates = this.rates().length ? this.rates() : [1];
    const i = rates.indexOf(c.rate());
    c.setRate(rates[(i + 1) % rates.length]!);
  }

  toggleFullscreen(): void {
    if (typeof document === 'undefined') return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void this.host.requestFullscreen?.().catch(() => {});
  }

  protected onScrub(e: Event): void {
    this.scrub.set(Number((e.target as HTMLInputElement).value));
  }

  protected onSeek(e: Event): void {
    const v = Number((e.target as HTMLInputElement).value);
    this.scrub.set(null);
    void this.seek(v);
  }

  protected onVolume(e: Event): void {
    this.ctl()?.setVolume(Number((e.target as HTMLInputElement).value));
  }

  /** Shows the controls, and hides them again after a while of playing. */
  protected poke(): void {
    this.idle.set(false);
    this.hideSoon();
  }

  protected hideSoon(ms = 2500): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.idle.set(true), ms);
  }

  protected onKey(e: KeyboardEvent): void {
    if (this.controls() !== 'custom') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' && e.key.startsWith('Arrow')) return;
    const c = this.ctl();
    if (!c) return;
    switch (e.key) {
      case ' ':
      case 'k':
        if (target.tagName === 'BUTTON' && e.key === ' ') return;
        e.preventDefault();
        this.toggle();
        break;
      case 'ArrowRight':
        e.preventDefault();
        void this.seek(c.position() + 5);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        void this.seek(Math.max(0, c.position() - 5));
        break;
      case 'm':
        c.toggleMute();
        break;
      case 'f':
        this.toggleFullscreen();
        break;
      default:
        return;
    }
    this.poke();
  }
}
