# @wavy/stream-support

An Angular 21 directive that plays a wavy playback-service stream in a plain `<video>` or `<audio>` element. It does not call the API; you fetch the session and pass it in.

- `direct` files are set as the element's `src`.
- HLS streams (`remux`, `transcode-audio`, `transcode`) play natively where the browser supports HLS (Safari, iOS), otherwise through hls.js, which is loaded lazily the first time it's needed.
- Changing the input, setting it to `null`, or destroying the element stops the old stream (hls.js is destroyed and `src` is cleared).
- `unsupported` streams, and anything that fails, are reported through outputs instead of a broken player.

## Usage

```ts
import { StreamSupportDirective, PlaybackStream } from '@wavy/stream-support';

@Component({
  imports: [StreamSupportDirective],
  template: `
    <video controls [streamSupport]="session()" #player="streamSupport"
           (streamError)="message.set($event.message)"></video>
    <span>{{ player.position() | number: '1.0-0' }} / {{ player.totalDuration() | number: '1.0-0' }} s</span>
    @if (message()) { <p class="error">{{ message() }}</p> }
  `,
})
export class Player {
  session = signal<PlaybackStream | null>(null);
  message = signal('');

  async open(path: string) {
    const res = await fetch('/api/sessions', { method: 'POST', body: JSON.stringify({ path }) });
    const body = await res.json();
    // 422 { error: "unsupported", reason } becomes an unsupported stream.
    this.session.set(res.ok ? body : { mode: 'unsupported', reason: body.reason });
  }
}
```

## Inputs

| Input | Type | |
| --- | --- | --- |
| `streamSupport` | `PlaybackStream \| string \| null` | The session response `{ sessionId, mode, url, start, duration, reason }` (only `mode` is required), or a bare URL. URLs ending in `.m3u8` are played as HLS. |
| `hlsConfig` | `Partial<HlsConfig>` | Extra hls.js settings. |

A new object with the same `url`, `mode`, `start`, `duration` and `reason` does not reload the player.

## Outputs

| Output | Payload | When |
| --- | --- | --- |
| `streamError` | `StreamError { kind, message, cause? }` | Any failure. `kind` is `unsupported`, `invalid-stream`, `hls-unsupported`, `hls-load-failed`, `network` or `media`. `message` can be shown to the user. |
| `streamUnsupported` | `string` | The service said the file can't be played; the payload is its `reason`. |
| `streamReady` | `'native' \| 'native-hls' \| 'hls.js'` | Metadata loaded. |

## Signals (via `#player="streamSupport"`)

- `engine()`: the player in use, or `null`.
- `error()`: the last error for the current stream, or `null`.
- `position()`: `currentTime` plus the stream's `start`, because HLS timestamps restart at 0 after a seek.
- `totalDuration()`: the stream's `duration` when given, else what the element reports plus `start`.

Fatal hls.js media errors get one `recoverMediaError()` attempt before being reported.

To supply your own hls.js build (or a fake in tests), provide `HLS_LOADER`:

```ts
providers: [{ provide: HLS_LOADER, useValue: () => import('hls.js').then((m) => m.default) }]
```

## Development

From `clients/angular`:

```bash
npm ci
npm test        # Vitest + jsdom
npm run build   # ng-packagr, output in dist/stream-support
```
