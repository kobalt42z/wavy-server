/**
 * An error the user should see. `code` is the API's `error` field ("unsupported", "busy",
 * "forbidden", …) or a client code ("network", "stream", "unauthorized", "no-mse", …), and
 * `reason` is a sentence that can be shown as is.
 */
export class PlaybackError extends Error {
  readonly code: string;
  readonly reason: string;
  /** HTTP status of the failed request, when there was one. */
  readonly status?: number;
  /** Seconds from a 503's Retry-After header. */
  readonly retryAfter?: number;

  constructor(code: string, reason: string, extra: { status?: number; retryAfter?: number; cause?: unknown } = {}) {
    super(reason);
    this.name = 'PlaybackError';
    this.code = code;
    this.reason = reason;
    this.status = extra.status;
    this.retryAfter = extra.retryAfter;
    if (extra.cause !== undefined) (this as { cause?: unknown }).cause = extra.cause;
  }
}

/** Turns any error from the player into one sentence for the user. */
export function describeError(err: unknown): string {
  if (err instanceof PlaybackError) {
    if (err.code === 'busy' || err.code === 'capacity' || err.status === 503) {
      const wait = err.retryAfter ? ` Try again in ${err.retryAfter} seconds.` : ' Try again shortly.';
      return `The playback server is busy.${wait}`;
    }
    return err.reason;
  }
  return 'Playback failed for an unexpected reason.';
}

export function toPlaybackError(err: unknown): PlaybackError {
  if (err instanceof PlaybackError) return err;
  return new PlaybackError('client', 'Playback failed for an unexpected reason.', { cause: err });
}

/** Formats seconds as h:mm:ss or m:ss. Unknown or negative values give "--:--". */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
