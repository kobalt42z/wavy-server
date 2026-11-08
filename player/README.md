# Test player

A small browser player for the playback API, plus the reusable client the web app
can copy. No build step and no framework: plain ES modules and
[hls.js](https://github.com/video-dev/hls.js).

| File | What it is |
| --- | --- |
| `wavy-player.js` | The reusable part. Probe, start a session, play direct or HLS, seek, stop. Copy it into the web app. |
| `index.html`, `app.js` | The test page around it: path box, custom seek bar, file info, error messages. |
| `serve.js` | Dev server: serves this folder and forwards `/api`, `/healthz` and `/metrics` to the service, so no CORS is needed. |
| `wavy-player.test.js` | Unit tests (`bun test`), with a fake API, fake hls.js and fake `<video>`. |

## Run it

Start the playback service, then:

```bash
bun player/serve.js                                   # http://localhost:5173
WAVY_API_URL=http://localhost:8080 PORT=5173 bun player/serve.js
```

Type a path relative to the media root and press Play, or open
`http://localhost:5173/?path=cctv/cam3.dav&start=30`. Use Google Chrome, the only
supported browser.

hls.js comes from `node_modules` (a dev dependency, so run `bun install` first) and is
served at `/hls.mjs`; nothing is fetched from a CDN, so the page works air-gapped.
Without `node_modules`, put `hls.mjs` (from `hls.js/dist/`) next to `serve.js`, or set
`HLS_JS_PATH` to its location.

To talk to a service on another origin without the dev server, add
`?api=https://media.example.com` (the service must then allow CORS).

## Use it in the web app

```js
import Hls from "hls.js"; // npm i hls.js
import { WavyPlayer, describeError } from "./wavy-player.js";

const player = new WavyPlayer(document.querySelector("video"), {
  Hls,
  // With AUTH_MODE=jwt: ask your main server for a playback token for this file.
  getToken: async (path) => {
    const res = await fetch("/media/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ path }),
    });
    if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
    return (await res.json()).token;
  },
});

try {
  await player.load(path, { start: 0 });
} catch (err) {
  showMessage(describeError(err)); // the API's reason, e.g. for a .g64x file
}

player.addEventListener("error", (e) => showMessage(describeError(e.detail)));
await player.seek(120);  // absolute seconds in the file
player.currentTime;      // absolute position, also after a server-side restart
player.duration;         // full file length, from the probe
await player.stop();     // ends the session (kills FFmpeg)
```

What it does, following the dev spec's "Frontend player" section:

1. `GET /api/probe` for the duration and mode. An `unsupported` file rejects
   `load()` with the API's `reason`, and no session is started.
2. `POST /api/sessions` with `{ path, start?, audioTrack? }`.
3. `direct`: sets `video.src` to the file URL, and Chrome seeks with Range requests.
   Every other mode (`remux`, `transcode-audio`, `transcode`): plays the HLS
   playlist with hls.js, from the start of the playlist (the playlist is still
   growing, and hls.js would otherwise jump to its newest segment).
4. Seeking inside the part FFmpeg has already produced is a normal media seek.
   Seeking past it, or before the playlist's start, calls
   `POST /api/sessions/{id}/seek` and loads the new playlist. Its timestamps
   restart at 0, so the player adds the server's `start` to report absolute times.
5. `DELETE /api/sessions/{id}` on stop and when another file is loaded. On page
   close it sends `navigator.sendBeacon` to `POST /api/sessions/{id}/stop`
   (sendBeacon can only POST), with a keepalive `DELETE` as fallback. The server's
   60-second idle timeout is the backup.

6. If the session is lost mid-playback (the pod restarted, or a request reached a
   pod that doesn't hold the session and got a 404), the player starts a new session
   at the current position and keeps playing. It fires a `resume` event
   (`{ position, error }`) each time. A seek that hits a lost session does the same at
   the seek target. If the new session can't start yet (a 503, or the dying pod still
   gets the request for a moment), it tries again with a backoff for about 30 s. After
   `maxResumes` (3) losses within a minute it gives up and fires `error`.
   `autoResume: false` turns this off. Decode errors are never resumed.
7. `withCredentials: true` sends cookies to a service on another origin, so the load
   balancer's sticky-session cookie comes back (fetch `credentials: "include"`, hls.js
   `withCredentials`, `crossorigin="use-credentials"`). The service's `CORS_ORIGINS`
   must list the page's origin. Same-origin requests send cookies anyway.

Errors are `PlaybackError`s with `code` (`unsupported`, `busy`, `network`,
`stream`, …), `reason`, `status` and `retryAfter` (from a `503`).
`describeError()` turns any of them into one sentence for the user.

Autoplay: Chrome blocks playback with sound until the user has interacted with the
page. After a click (the normal case) playback starts on its own; when a file is
opened from the URL on a fresh tab, the user presses Play.
