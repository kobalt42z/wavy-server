import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  ViewEncapsulation,
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
import { PlaybackError, describeError, formatTime, toPlaybackError } from '../core/errors';
import { MediaController, WavyPlaybackFocus } from '../core/media-controller';
import { WavyService } from '../core/wavy.service';
import { fitPeaks, placeholderPeaks } from './waveform';

/** How many peaks are asked from the server; the component fits them to its width. */
const PEAKS_RESOLUTION = 200;

/**
 * A voice-message style audio player for a file on the wavy playback service: a round
 * play button, a waveform of the real audio (from `GET /api/peaks`) that fills as it plays,
 * tap or drag to seek, elapsed/total time and a speed toggle.
 *
 * Nothing starts on the server until the user presses play; the waveform needs only the
 * access token. Only one player plays at a time (`exclusive`).
 *
 * ```html
 * <wavy-audio path="calls/2026-11-02/0815.wav" (playbackError)="log($event)" />
 * ```
 */
@Component({
  selector: 'wavy-audio',
  exportAs: 'wavyAudio',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.Emulated,
  host: {
    class: 'wavy-audio',
    '[class.wavy-audio--playing]': 'ctl()?.playing()',
    '[class.wavy-audio--error]': '!!message()',
  },
  template: `
    <audio #media preload="none"></audio>
    <button
      type="button"
      class="wavy-audio__play"
      [disabled]="!path()"
      [attr.aria-label]="playing() ? 'Pause' : 'Play'"
      (click)="toggle()"
    >
      @if (busy()) {
        <svg class="wavy-audio__ring" viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="24" cy="24" r="22" />
        </svg>
      }
      @if (playing()) {
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2" /><rect x="14" y="5" width="4" height="14" rx="1.2" /></svg>
      } @else {
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8c0 .8.9 1.3 1.6.9l10-6.4c.6-.4.6-1.3 0-1.7l-10-6.4C8.9 4.3 8 4.8 8 5.6z" /></svg>
      }
    </button>
    <div class="wavy-audio__body">
      <div
        #wave
        class="wavy-audio__wave"
        [class.wavy-audio__wave--loading]="!waveReady()"
        role="slider"
        tabindex="0"
        aria-label="Seek"
        [attr.aria-valuemin]="0"
        [attr.aria-valuemax]="ariaMax()"
        [attr.aria-valuenow]="ariaNow()"
        [attr.aria-valuetext]="ariaText()"
        [style.gap.px]="barGap()"
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp($event)"
        (pointercancel)="onPointerCancel()"
        (keydown)="onKey($event)"
      >
        @for (h of bars(); track $index) {
          <span
            class="wavy-audio__bar"
            [class.wavy-audio__bar--played]="($index + 0.5) / bars().length <= progress()"
            [style.width.px]="barWidth()"
            [style.height.%]="h"
          ></span>
        }
        <span class="wavy-audio__knob" [style.left.%]="progress() * 100"></span>
      </div>
      <div class="wavy-audio__meta">
        @if (message()) {
          <span class="wavy-audio__error" [attr.title]="message()" role="alert">{{ message() }}</span>
        } @else {
          <span class="wavy-audio__time">{{ timeLabel() }}</span>
        }
      </div>
    </div>
    @if (showSpeed()) {
      <button type="button" class="wavy-audio__speed" [attr.aria-label]="'Playback speed ' + rate() + 'x'" (click)="cycleRate()">
        {{ rateLabel() }}
      </button>
    }
  `,
  styles: `
    :host {
      --_accent: var(--wavy-audio-accent, #2f80ed);
      --_played: var(--wavy-audio-played, var(--_accent));
      --_unplayed: var(--wavy-audio-unplayed, rgba(60, 72, 88, 0.28));
      --_bg: var(--wavy-audio-bg, #ffffff);
      --_fg: var(--wavy-audio-fg, #5b6675);
      --_button-fg: var(--wavy-audio-button-fg, #ffffff);
      --_error: var(--wavy-audio-error, #d93025);
      display: inline-flex;
      align-items: center;
      gap: 10px;
      box-sizing: border-box;
      width: var(--wavy-audio-width, 320px);
      max-width: 100%;
      min-height: 56px;
      padding: 8px 12px 8px 8px;
      border-radius: var(--wavy-audio-radius, 18px);
      background: var(--_bg);
      color: var(--_fg);
      box-shadow: var(--wavy-audio-shadow, 0 1px 2px rgba(16, 24, 40, 0.12));
      font: 12px/1.3 var(--wavy-audio-font, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --_unplayed: var(--wavy-audio-unplayed, rgba(220, 228, 238, 0.3));
        --_bg: var(--wavy-audio-bg, #1f2c34);
        --_fg: var(--wavy-audio-fg, #a9b6c2);
      }
    }
    audio { display: none; }
    button { font: inherit; cursor: pointer; }
    button:disabled { cursor: default; opacity: 0.5; }
    button:focus-visible, .wavy-audio__wave:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
    .wavy-audio__play {
      position: relative;
      flex: none;
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: var(--_accent);
      color: var(--_button-fg);
    }
    .wavy-audio__play svg { width: 22px; height: 22px; fill: currentColor; }
    .wavy-audio__play .wavy-audio__ring {
      position: absolute;
      inset: -4px;
      width: 48px;
      height: 48px;
      fill: none;
      stroke: var(--_accent);
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-dasharray: 100 140;
      animation: wavy-audio-spin 0.9s linear infinite;
      transform-origin: center;
    }
    @keyframes wavy-audio-spin { to { transform: rotate(360deg); } }
    .wavy-audio__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .wavy-audio__wave {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: var(--wavy-audio-wave-height, 30px);
      cursor: pointer;
      touch-action: none;
      border-radius: 4px;
    }
    .wavy-audio__bar {
      flex: none;
      min-height: 2px;
      border-radius: 99px;
      background: var(--_unplayed);
      transition: height 0.25s ease, background-color 0.1s linear;
    }
    .wavy-audio__bar--played { background: var(--_played); }
    .wavy-audio__wave--loading .wavy-audio__bar { opacity: 0.55; }
    .wavy-audio__knob {
      position: absolute;
      top: 50%;
      width: 12px;
      height: 12px;
      margin: -6px 0 0 -6px;
      border-radius: 50%;
      background: var(--_played);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
    }
    :host(.wavy-audio--playing) .wavy-audio__knob, .wavy-audio__wave:hover .wavy-audio__knob, .wavy-audio__wave:focus-visible .wavy-audio__knob { opacity: 1; }
    .wavy-audio__meta { display: flex; justify-content: space-between; min-height: 16px; }
    .wavy-audio__time { font-variant-numeric: tabular-nums; }
    .wavy-audio__error { color: var(--_error); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wavy-audio__speed {
      flex: none;
      min-width: 38px;
      height: 24px;
      padding: 0 8px;
      border: 0;
      border-radius: 12px;
      background: var(--_unplayed);
      color: var(--_fg);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    @media (prefers-reduced-motion: reduce) {
      .wavy-audio__bar { transition: none; }
    }
  `,
})
export class WavyAudioComponent {
  /** Path of the file relative to the media root (or the URL a token grants). */
  readonly path = input.required<string>();
  /** Which audio track to play and draw (an `audio[].track` from the probe). */
  readonly audioTrack = input<number | undefined, unknown>(undefined, {
    transform: (v: unknown) => (v === undefined || v === null || v === '' ? undefined : numberAttribute(v)),
  });
  /**
   * Waveform values from 0 to 1, when the app already has them (for example from
   * `peaksFromAudioBuffer`). When null, they are fetched from `GET /api/peaks`.
   */
  readonly peaks = input<readonly number[] | null>(null);
  /** Fetch the waveform from the server when `peaks` is not given (default true). */
  readonly waveform = input(true, { transform: booleanAttribute });
  /** Duration in seconds to show before anything is loaded. */
  readonly duration = input<number | undefined, unknown>(undefined, {
    transform: (v: unknown) => (v === undefined || v === null || v === '' ? undefined : numberAttribute(v)),
  });
  /** Bar width and gap in px. */
  readonly barWidth = input(3, { transform: numberAttribute });
  readonly barGap = input(2, { transform: numberAttribute });
  /** Pause other Wavy players when this one starts (default true). */
  readonly exclusive = input(true, { transform: booleanAttribute });
  /** Show the 1x / 1.5x / 2x button (default true). */
  readonly showSpeed = input(true, { transform: booleanAttribute });
  /** Speeds the speed button cycles through. */
  readonly rates = input<readonly number[]>([1, 1.5, 2]);

  /** Any playback failure, with a `reason` that can be shown. */
  readonly playbackError = output<PlaybackError>();
  readonly started = output<void>();
  readonly paused = output<void>();
  readonly ended = output<void>();

  private readonly service = inject(WavyService);
  private readonly focus = inject(WavyPlaybackFocus);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly mediaRef = viewChild.required<ElementRef<HTMLAudioElement>>('media');
  private readonly waveRef = viewChild.required<ElementRef<HTMLElement>>('wave');

  /** The controller, once the view exists (browser only). */
  readonly ctl = signal<MediaController | null>(null);
  private readonly fetchedPeaks = signal<readonly number[] | null>(null);
  private readonly fetchedDuration = signal<number | null>(null);
  private readonly width = signal(0);
  /** Position under the pointer while dragging, as a fraction. */
  private readonly scrub = signal<number | null>(null);

  readonly playing = computed(() => this.ctl()?.playing() ?? false);
  readonly busy = computed(() => this.ctl()?.busy() ?? false);
  /** An error from fetching the waveform that also means the file won't play. */
  private readonly loadError = signal<PlaybackError | null>(null);
  readonly message = computed(() => {
    const m = this.ctl()?.message();
    if (m) return m;
    const e = this.loadError();
    return e ? describeError(e) : '';
  });
  readonly rate = computed(() => this.ctl()?.rate() ?? 1);
  readonly rateLabel = computed(() => `${this.rate()}×`);

  readonly totalDuration = computed(() => {
    const d = this.ctl()?.duration() ?? NaN;
    if (Number.isFinite(d) && d > 0) return d;
    return this.fetchedDuration() ?? this.duration() ?? NaN;
  });
  readonly currentPosition = computed(() => this.ctl()?.position() ?? 0);
  readonly progress = computed(() => {
    const s = this.scrub();
    if (s !== null) return s;
    const d = this.totalDuration();
    return Number.isFinite(d) && d > 0 ? Math.min(1, Math.max(0, this.currentPosition() / d)) : 0;
  });
  readonly timeLabel = computed(() => {
    const c = this.ctl();
    const d = this.totalDuration();
    // Like chat apps: the length until it starts, then the elapsed time.
    if (this.scrub() !== null && Number.isFinite(d)) return formatTime(this.scrub()! * d);
    if (c && (c.playing() || c.position() > 0)) return formatTime(c.position());
    return formatTime(d);
  });

  readonly barCount = computed(() => {
    const w = this.width();
    const step = Math.max(1, this.barWidth() + this.barGap());
    if (w <= 0) return 40;
    return Math.max(8, Math.min(PEAKS_RESOLUTION, Math.floor((w + this.barGap()) / step)));
  });
  readonly waveReady = computed(() => (this.peaks() ?? this.fetchedPeaks()) !== null);
  /** Bar heights in percent. */
  readonly bars = computed(() => {
    const n = this.barCount();
    const source = this.peaks() ?? this.fetchedPeaks();
    const values = source ? fitPeaks(source, n) : placeholderPeaks(n);
    return values.map((v) => Math.max(7, Math.round(v * 100)));
  });

  readonly ariaMax = computed(() => Math.round(Number.isFinite(this.totalDuration()) ? this.totalDuration() : 0));
  readonly ariaNow = computed(() => Math.round(this.currentPosition()));
  readonly ariaText = computed(() => `${formatTime(this.currentPosition())} of ${formatTime(this.totalDuration())}`);

  private pointerId: number | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);

    afterNextRender(() => {
      const c = new MediaController(this.service.createPlayer(this.mediaRef().nativeElement));
      c.onError = (err) => this.playbackError.emit(err);
      c.onEnded = () => {
        this.ended.emit();
        this.focus.release(c);
        // Back to the start, like a chat app; the next play starts over.
        void c.seek(0);
      };
      const media = this.mediaRef().nativeElement;
      media.addEventListener('play', () => {
        if (this.exclusive()) this.focus.take(c);
        this.started.emit();
      });
      media.addEventListener('pause', () => {
        if (!media.ended) this.paused.emit();
      });
      this.ctl.set(c);

      const wave = this.waveRef().nativeElement;
      this.width.set(wave.clientWidth);
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => this.width.set(wave.clientWidth));
        ro.observe(wave);
        destroyRef.onDestroy(() => ro.disconnect());
      }
      destroyRef.onDestroy(() => {
        this.focus.release(c);
        c.destroy();
      });
    });

    // A new file: stop the old session; the next one starts on play.
    effect(() => {
      const c = this.ctl();
      const path = this.path();
      const audioTrack = this.audioTrack();
      const duration = this.duration();
      if (!c) return;
      untracked(() => c.setSource(path || null, { audioTrack, duration }));
    });

    // The waveform, unless the app gave one.
    effect((onCleanup) => {
      const path = this.path();
      const audioTrack = this.audioTrack();
      const wanted = this.peaks() === null && this.waveform();
      this.fetchedPeaks.set(null);
      this.fetchedDuration.set(null);
      this.loadError.set(null);
      if (!this.browser || !path || !wanted) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      onCleanup(() => {
        cancelled = true;
        clearTimeout(timer);
      });
      const load = (attempt: number): void => {
        this.service.peaks(path, PEAKS_RESOLUTION, audioTrack).then(
          (res) => {
            if (cancelled) return;
            this.fetchedPeaks.set(res.peaks);
            if (res.duration != null) {
              this.fetchedDuration.set(res.duration);
              untracked(() => this.ctl()?.knownDuration(res.duration));
            }
          },
          (err) => {
            if (cancelled) return;
            const e = toPlaybackError(err);
            // A busy server: try again a few times.
            if ((e.status === 503 || e.code === 'network') && attempt < 3) {
              timer = setTimeout(() => load(attempt + 1), Math.max(1, e.retryAfter ?? 2 ** attempt) * 1000);
              return;
            }
            // No waveform (an older server, still busy): keep the placeholder bars. A file the
            // server can't play at all is reported now rather than on play.
            if (['unsupported', 'forbidden', 'unauthorized'].includes(e.code)) {
              this.loadError.set(e);
              this.playbackError.emit(e);
            }
          },
        );
      };
      load(0);
    });
  }

  /** Plays or pauses. The first play starts the session. */
  toggle(): void {
    void this.ctl()?.toggle();
  }

  play(): Promise<void> {
    return this.ctl()?.play() ?? Promise.resolve();
  }

  pause(): void {
    this.ctl()?.pause();
  }

  /** Seeks to an absolute position in seconds. */
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

  protected onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.pointerId = e.pointerId;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    this.scrub.set(this.fraction(e));
    e.preventDefault();
  }

  protected onPointerMove(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    this.scrub.set(this.fraction(e));
  }

  protected onPointerUp(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    const f = this.fraction(e);
    this.scrub.set(null);
    this.seekFraction(f);
  }

  protected onPointerCancel(): void {
    this.pointerId = null;
    this.scrub.set(null);
  }

  protected onKey(e: KeyboardEvent): void {
    const d = this.totalDuration();
    const pos = this.currentPosition();
    let target: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') target = pos + 5;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') target = pos - 5;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End' && Number.isFinite(d)) target = d;
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this.toggle();
      return;
    }
    if (target === null) return;
    e.preventDefault();
    void this.seek(Math.max(0, target));
  }

  private seekFraction(f: number): void {
    const d = this.totalDuration();
    if (!Number.isFinite(d) || d <= 0) return;
    void this.seek(f * d);
  }

  private fraction(e: PointerEvent): number {
    const rect = this.waveRef().nativeElement.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }
}
