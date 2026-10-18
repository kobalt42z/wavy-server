# Wavy playback API: every route end to end

Last updated Oct 18, 2026. Describes the server code in `src/`.

## Overview

The service has 11 routes. Every `/api/*` request goes through the same five steps before its handler runs, and every error comes back in the same shape. The entry point is `src/server.ts`, and the routes are in `src/app.ts`.

| Route | What it does | Success |
| --- | --- | --- |
| `GET /api/probe?path=` | Reads a file's codecs and picks a playback mode | `200` JSON |
| `POST /api/sessions` | Starts playback (direct file or FFmpeg HLS) | `201` JSON |
| `GET /api/sessions/{id}` | Session state | `200` JSON |
| `GET /api/sessions/{id}/index.m3u8` | HLS playlist | `200` playlist |
| `GET /api/sessions/{id}/{segment}` | One HLS segment or init file | `200` video |
| `POST /api/sessions/{id}/seek` | Restarts FFmpeg at a new position | `200` JSON |
| `DELETE /api/sessions/{id}` | Stops the session | `204` |
| `POST /api/sessions/{id}/stop` | Same as DELETE, for `sendBeacon` | `204` |
| `GET` / `HEAD /api/files/{path}` | Original file with Range, direct files only | `200` / `206` |
| `GET /healthz` | Liveness | `200` JSON |
| `GET /metrics` | Prometheus metrics | `200` text |

What every `/api/*` request goes through:

1. **Bun.serve** accepts the connection. Its idle timeout is the playlist wait plus 15 s (30 s by default), so a playlist request that waits for FFmpeg is not cut off.
2. **CORS** (`hono/cors`): allows `CORS_ORIGINS` (default `*`), the methods GET, HEAD, POST, DELETE and OPTIONS, and the headers Content-Type, Range and Authorization. It exposes Content-Range, Content-Length, Accept-Ranges and Retry-After to the browser. A preflight `OPTIONS` is answered `204` here.
3. **Auth hook** (`src/auth.ts`, `authenticate`): today it sets `user = null` and lets everything through. When auth is added, this is where the token is checked and `user` is set.
4. **The route handler** runs (sections below).
5. **Error handler** (`app.onError`): an `ApiError` becomes `{ "error": "<code>", "reason": "<sentence for the user>" }` with its status and any extra headers (Retry-After). Anything else is logged as `request_failed` and returned as `500 { error: "internal" }`. An unknown URL gives `404 { error: "not_found", reason: "No such endpoint." }`.

**Path safety** (`src/media-path.ts`, `resolveMediaPath`) runs in every route that takes a file path (probe, sessions, files), in this order:

1. Empty or missing path → `400 invalid_path`.
2. NUL byte → `400 invalid_path`.
3. Backslashes become `/`. An absolute path (`/etc/passwd`) or a Windows drive (`C:/...`) → `400 invalid_path`.
4. Any `..` segment → `400 invalid_path`.
5. The media root itself is resolved with `realpath`. If the share is missing → `500 media_root_unavailable`.
6. The path is joined to the root and checked to still be inside it.
7. `realpath` follows symlinks. A missing file → `404 not_found`. A symlink that points outside the root → `400 invalid_path`.
8. `stat`: a folder → `404 not_found` ("The path is not a file").
9. `canViewPath(user, path)` (auth hook, always true today) → `403 forbidden` when it says no.

The result is the normalized relative path, the real absolute path, the size and the modification time.

## GET /api/probe

This route answers "how would this file play?" without starting anything. It runs ffprobe at most once per file version, then applies the decision table from `config/playback-rules.json`.

**Request:** `GET /api/probe?path=video/clip.mov`. The path is relative to the media root and URL-encoded.

**Inside** (`src/playback.ts`, `PlaybackAnalyzer.analyze`):

1. Path safety (Overview).
2. **Cache lookup.** The key is real path + size + modification time, and up to 1000 entries are kept, least recently used dropped first. A file that changes on the share gets a new key, so it is probed again.
3. **Extension check.** Blocked extensions (g64x, prproj, pkf, sys) return their configured message. Extensions not on `allowedExtensions` return ".xyz files are not on the list of allowed formats." ffprobe is not run in either case.
4. **ffprobe** (`src/probe.ts`): `ffprobe -v error -show_streams -show_format -of json [input options] -i <file>`, as an argument array with a 30 s timeout.
   - Raw CCTV streams (`.264`, `.h264`, `.265`, `.hevc`) get forced input options from `inputOverrides`, for example `-f h264 -framerate 25`.
   - If auto-detection fails, it retries with each format in `probeFallbackFormats` (`-f mpeg` for Hikvision-style files).
   - Cover art in audio files is ignored, so it doesn't count as video.
   - If ffprobe fails or finds no audio or video stream, the file is unsupported: "FFmpeg cannot read this file (...)".
5. **Decision table** (`src/decide.ts`). It looks at the first video and the first audio stream, independently:
   - **direct**: a `direct` rule matches the container, extension and codecs (for example MP4 + H.264 8-bit 4:2:0 + AAC, WebM VP9 + Opus, MP3, PCM WAV, FLAC). Raw streams never play direct.
   - **transcode**: the video codec is not copyable (HEVC, ProRes, MPEG-2, WMV, MJPEG...), H.264 is 10-bit or 4:2:2, or it is taller than `copy.maxVideoHeight` (2160). Output is scaled to `transcode.maxHeight` (1080) at most.
   - **transcode-audio**: video copies, but audio is not AAC (AC3, G.711, WMA, ALAC...) or has more than 2 channels.
   - **remux**: both streams copy, and only the container changes (TS, MOV, AVI or raw H.264).
   - HEVC counts as H.264 only if `allowHevcPassthrough` is true.
6. **Metrics and log.** `wavy_probe_duration_seconds` times ffprobe and `wavy_probe_results_total{mode,extension}` counts the result. An unsupported file is logged as `unsupported_file`, with its reason and the probe result.

**Response** `200`:

```json
{
  "path": "video/mov_prores_pcm.mov",
  "mode": "transcode",
  "reason": "Video: prores is not playable in Chrome. Audio: pcm_s16le is converted to AAC.",
  "duration": 12,
  "container": "mov,mp4,m4a,3gp,3g2,mj2",
  "size": 20289160,
  "video": { "codec": "prores", "width": 640, "height": 360, "fps": 25, "pixFmt": "yuv422p10le" },
  "audio": [{ "track": 0, "codec": "pcm_s16le", "channels": 1, "lang": null }],
  "subtitles": [],
  "plan": { "video": "encode", "audio": "encode" }
}
```

An unsupported file still answers `200`, with `mode: "unsupported"` and the reason. In that case `video` is null and the lists are empty when the file was never probed. `audio[].track` is the number to send as `audioTrack` when starting a session.

**Errors:** `400 invalid_path`, `404 not_found` (missing file or a folder), `403 forbidden` (auth hook), `500 media_root_unavailable`.

## POST /api/sessions

This route starts playback. A direct file gets a session record and its file URL. Any other playable file gets its own temp folder and one FFmpeg process writing HLS.

**Request:**

```json
{ "path": "video/mov_prores_pcm.mov", "start": 0, "audioTrack": 0 }
```

`start` (seconds) and `audioTrack` (an `audio[].track` value from probe) are both optional.

**Inside** (`src/app.ts`, then `SessionManager.create` in `src/sessions.ts`):

1. **Body.** It must be a JSON object, otherwise `400 bad_request`. `start` must be a number >= 0, and `audioTrack` an integer >= 0 (`400 bad_request`). A `path` that is missing or not a string gives `400 invalid_path`.
2. **Path safety**, then **probe**: the same cached analysis as `GET /api/probe`, so a probe followed by a session start runs ffprobe once.
3. **Unsupported** → `wavy_sessions_rejected_total{reason="unsupported"}` goes up and the route answers `422 { error: "unsupported", reason }`, for example "g64x is a Genetec proprietary format. Export it from Genetec Security Center first."
4. **Audio track.** With `audioTrack` 0 or absent, the probe's decision is used. With another track, that track moves to the front and the decision is recomputed with direct play ruled out, because the browser can't choose the track of a raw file. A track that doesn't exist → `400 bad_request`. Example: an MP4 with AAC and AC3 tracks plays direct by default, but `audioTrack: 1` becomes `transcode-audio` with the AC3 track as AAC.
5. **Capacity checks**, which run synchronously before anything is awaited, so two requests can't both take the last slot. Direct sessions skip both checks.
   - More than `MAX_SESSIONS` (50) HLS sessions open → `503 capacity` with `Retry-After: 5`.
   - A full `transcode` while `MAX_TRANSCODES` (4) transcodes are open → `503 capacity` with `Retry-After: 5`. Remux and audio-only sessions are not counted.
   - Both add to `wavy_sessions_rejected_total{reason="capacity"}`.
6. **Session record.** The id is 18 random bytes in base64url (24 characters, unguessable). It stores the owner (`user.id`, null today), file, mode, decision, probe, start, generation 0 and timestamps. `start` is clamped between 0 and duration − 1 s. `wavy_sessions_started_total{mode,extension}` goes up and the gauges are refreshed.
7. **Direct mode stops here.** There is no folder and no process.
8. **HLS modes**: the route creates `SESSIONS_DIR/<id>/` and starts FFmpeg (`startEncoder`). The generation becomes 1, so files are prefixed `g1_`. The command is built by `buildHlsArgs` (`src/hls.ts`) and passed as an array, never through a shell:

```
ffmpeg -hide_banner -nostdin -loglevel error -progress pipe:1 -nostats -fflags +genpts
  [-ss <start>]  [raw-stream input options]  -i <file>
  -map 0:<video index>  -map 0:<audio index>  -sn -dn -map_metadata -1 -map_chapters -1
  <video options>  <audio options>
  -avoid_negative_ts make_zero -max_muxing_queue_size 1024
  -f hls -hls_time 4 -hls_list_size 0 -hls_playlist_type event -hls_segment_type fmp4
  -hls_flags independent_segments+temp_file
  -hls_fmp4_init_filename g1_init.mp4 -hls_segment_filename <dir>/g1_%05d.m4s  <dir>/index.m3u8
```

| Mode | Video options | Audio options |
| --- | --- | --- |
| remux | `-c:v copy` | `-c:a copy` |
| transcode-audio | `-c:v copy` (or no video) | `-c:a aac -b:a 160k -ac 2 -ar 48000` |
| transcode | `-c:v libx264 -preset veryfast -crf 23 -profile:v high -pix_fmt yuv420p -vf scale=-2:'min(1080,ih)' -force_key_frames expr:gte(t,n_forced*4) -sc_threshold 0` | copy if AAC stereo, else as above |

The forced keyframe every 4 s means each segment starts on a keyframe, at any frame rate. `temp_file` makes FFmpeg write each segment under a temporary name and rename it when complete, so a half-written segment is never served. With `HLS_SEGMENT_TYPE=mpegts`, segments are `g1_%05d.ts` and there is no init file.

9. **While FFmpeg runs**, the service reads its `-progress` output and records every `speed=` value in the `wavy_ffmpeg_speed{mode}` histogram. It also keeps stderr.
10. **When FFmpeg exits**: code 0 marks the encoder `done`. A kill by the service is ignored. Any other exit marks it `failed` and keeps the last 3 stderr lines as the error. It also adds to `wavy_ffmpeg_failures_total{mode,extension}` and logs `ffmpeg_failed` with the probe result.
11. The route logs `session_started` with session, user, path, mode and start.

**Response** `201`:

```json
{
  "sessionId": "q718Ode85tVjsGtxj8CKwIlg",
  "mode": "transcode",
  "url": "/api/sessions/q718Ode85tVjsGtxj8CKwIlg/index.m3u8?v=1",
  "start": 0,
  "duration": 12,
  "reason": "Video: prores is not playable in Chrome. Audio: pcm_s16le is converted to AAC."
}
```

For `direct`, `url` is `/api/files/<encoded path>` and the player sets `video.src` to it. Otherwise the player loads `url` with hls.js straight away, because the playlist request waits for the first segment. `?v=<generation>` only makes each restart's URL unique for caches.

**Errors:** `400 bad_request` / `invalid_path`, `403 forbidden`, `404 not_found`, `422 unsupported`, `503 capacity` (with `Retry-After`).

## GET playlist and segments

These two routes are what hls.js calls over and over during playback. Each call also counts as activity that keeps the session alive.

### GET /api/sessions/{id}/index.m3u8

1. **Find the session.** If the id is unknown, or `canUseSession(user, owner)` says no, the answer is `404 not_found` ("The session does not exist or has ended."). Someone else's session looks the same as a missing one. A direct session → `404` ("Direct sessions have no playlist; use the file URL.").
2. **Touch:** `lastAccess = now`.
3. **Wait for the first segment** (`waitForPlaylist`). Every 100 ms, up to `PLAYLIST_WAIT_MS` (15 s), it reads `index.m3u8` from the session folder:
   - It returns the playlist once it has at least one `#EXTINF` and mentions the current generation (`g<N>_`). The generation check means a playlist left over from before a seek is never returned.
   - If the encoder `failed` → `502 ffmpeg_failed` with FFmpeg's last error lines in `reason`.
   - If the encoder finished without writing a playlist → `502 ffmpeg_failed` ("FFmpeg finished without producing any output.").
   - If the session was stopped meanwhile → `404`.
   - If time runs out → `503 not_ready` with `Retry-After: 1`.
4. **Touch again**, then answer `200` with `Content-Type: application/vnd.apple.mpegurl` and `Cache-Control: no-store`.

The playlist is FFmpeg's own, an EVENT playlist that grows as segments are written and ends with `#EXT-X-ENDLIST` once the file is fully converted:

```
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="g1_init.mp4"
#EXTINF:4.000000,
g1_00000.m4s
#EXTINF:4.000000,
g1_00001.m4s
```

Segment URIs are relative, so the browser requests them under `/api/sessions/{id}/`.

### GET /api/sessions/{id}/{segment}

1. **Find the session**, as above (`404` if unknown or not yours).
2. **Check the name** against `^[A-Za-z0-9_-]{1,64}\.(m4s|mp4|ts)$`. Anything else, including `..`, slashes or `index.m3u8.bak`, → `404`. This keeps every read inside the session's own folder. A direct session → `404`.
3. **Touch** (`lastAccess = now`). This is what the 60 s idle rule watches.
4. **Read** `<SESSIONS_DIR>/<id>/<name>`. Not written yet, or already deleted by a seek → `404` ("The segment is not ready or no longer exists."); hls.js retries.
5. **Answer** `200` with `Content-Type: video/mp4` for `.m4s` and `.mp4` (init), `video/mp2t` for `.ts`, and `Cache-Control: private, max-age=3600`. A segment never changes once written, because restarts use new names.

## POST /api/sessions/{id}/seek

This route jumps past what FFmpeg has produced so far. Version 1 restarts FFmpeg at the new time, as the spec says. The player calls it only when the target time is outside what it already has buffered.

**Request:** `{ "position": 120 }` (seconds).

**Inside** (`SessionManager.seek`):

1. **Find the session** (`404` if unknown or not yours). `position` must be a number >= 0, otherwise `400 bad_request` ("position (seconds) is required.").
2. **Touch** the session.
3. **Direct session:** nothing to restart. The answer is the file URL with `start = position`, and the player just sets `currentTime`.
4. **HLS session:**
   1. Kill the running FFmpeg with SIGKILL and wait until it has exited.
   2. Delete every file in the session folder (old playlist, init file and segments).
   3. If the session was stopped while this happened, stop here.
   4. Set `start = position`, clamped between 0 and duration − 1 s, and clear any old error.
   5. Start FFmpeg again with `-ss <start>` before `-i`, so FFmpeg jumps straight to the nearest keyframe without decoding the start of the file. The generation goes up by one, so the new files are `g2_init.mp4`, `g2_00000.m4s` and so on.
   6. Log `session_seek`.
5. A seek doesn't take a new transcode slot; the session keeps the one it has.

**Response** `200`: `{ "url": "/api/sessions/<id>/index.m3u8?v=2", "start": 120 }`.

The player loads the new `url`. The playlist request waits for the first new segment, as described above. The new stream's timestamps start at 0, so the player shows `start + video.currentTime` as the real position.

**Errors:** `400 bad_request`, `404 not_found`. If the restarted FFmpeg fails, the error appears on the next playlist request as `502 ffmpeg_failed`.

## Stopping and cleanup

A session ends in one of four ways, and all four run the same `SessionManager.stop`, so FFmpeg is always killed and the folder is always deleted.

| Cause | Trigger | `cause` label |
| --- | --- | --- |
| Player stops it | `DELETE /api/sessions/{id}` or `POST /api/sessions/{id}/stop` | `deleted` |
| Viewer left | No playlist or segment request for `SESSION_IDLE_TIMEOUT_MS` (60 s) | `idle` |
| Too old | Open longer than `SESSION_MAX_AGE_MS` (4 h) | `expired` |
| Pod stopping | SIGTERM or SIGINT | `shutdown` |

### DELETE /api/sessions/{id} and POST /api/sessions/{id}/stop

Both routes do the same thing. `POST /stop` exists because `navigator.sendBeacon`, which still works while the tab closes, can only send POST. The player can also use `fetch(..., { method: "DELETE", keepalive: true })`.

1. Look up the session. If it exists and `canUseSession` allows it, stop it with cause `deleted`.
2. Answer `204` with no body, whether or not the session existed. Stopping twice is not an error, and an unknown id leaks nothing.

### What stop does (`SessionManager.stop`)

1. Remove the session from the in-memory map. If it was already gone, return; this makes stop idempotent.
2. Refresh the gauges `wavy_active_sessions{mode}` and `wavy_active_transcodes`. A transcode slot is free from this point.
3. Count it in `wavy_sessions_ended_total{cause}`.
4. SIGKILL FFmpeg if it is still running, and wait for it to exit.
5. Delete `SESSIONS_DIR/<id>/` and everything in it.
6. Log `session_ended` with session, user, path, mode, cause and how many seconds it was open. This is the start of the audit log the spec asks for.

### The idle reaper

Every `SESSION_REAP_INTERVAL_MS` (5 s) the reaper checks each session:

- Older than the max age → stop with `expired`.
- Otherwise, last request more than 60 s ago → stop with `idle`.

Only playlist and segment requests (and seek) count as activity. So when a tab closes without sending stop, FFmpeg dies and the temp files are deleted within 60 to 65 s. That meets the spec's acceptance criterion. Direct sessions have no process or folder, so reaping them only removes the record.

### Startup and shutdown

- **At startup** (`init`), the service creates `SESSIONS_DIR` and deletes anything in it, such as segments left by a pod that crashed.
- **On SIGTERM or SIGINT** (`src/server.ts`), it stops accepting connections, stops every session with cause `shutdown` (killing every FFmpeg), then exits 0. `tini` is PID 1 in the image, so the signal reaches Bun. Kubernetes gives 30 s of grace, which is plenty. A viewer on that pod gets errors, and the player starts a new session on another pod.

## GET / HEAD /api/files/{path}

This route serves an original file from the read-only share, unchanged. Chrome seeks in it by itself with Range requests. It is the URL a `direct` session returns.

**Request:** `GET /api/files/video/clip%20one.mp4` with an optional `Range: bytes=...` header, usually sent by the `<video>` element.

**Inside** (`src/app.ts` then `serveFile` in `src/files.ts`):

1. **Decode the path.** It is the raw URL path after `/api/files/`, decoded with `decodeURIComponent`. Bad percent-encoding → `400 bad_request`. An encoded `..%2F` decodes to `../` and is rejected by the next step.
2. **Path safety** (Overview).
3. **Direct-only check.** The cached analysis must say `direct`. Otherwise → `409 not_direct`: for an unsupported file the reason is the unsupported message, and for others it is "This file needs transcode; start a session with POST /api/sessions." This stops the route being used to download any file on the share.
4. **Headers on every answer:** `Content-Type` from the extension (mp4/m4v `video/mp4`, mov `video/quicktime`, webm `video/webm`, mp3 `audio/mpeg`, aac `audio/aac`, m4a `audio/mp4`, wav `audio/wav`, opus/ogg/oga `audio/ogg`, flac `audio/flac`), `Accept-Ranges: bytes`, `Last-Modified`, an `ETag` built from size and modification time, and `Cache-Control: private, max-age=3600`.
5. **If-Range.** If the browser sends `If-Range` and it matches neither the ETag nor Last-Modified, the file changed, so the Range is ignored and the whole file is sent.
6. **Range parsing** (`parseRange`):

| Range header | Result for a 1000-byte file |
| --- | --- |
| none, malformed, or not `bytes=` | `200`, the whole file |
| `bytes=100-199` | `206`, bytes 100–199 |
| `bytes=900-` | `206`, bytes 900–999 |
| `bytes=900-5000` | `206`, bytes 900–999 (end clamped) |
| `bytes=-100` | `206`, the last 100 bytes |
| `bytes=0-1, 5-6` | `206`, only the first range |
| `bytes=1000-` or `bytes=-0` | `416`, `Content-Range: bytes */1000` |
| `bytes=5-2` | `200`, the whole file |

7. **Body.** A `206` carries `Content-Range: bytes <start>-<end>/<size>` and the exact `Content-Length`. Bun streams the slice from disk without loading the file into memory. `HEAD` gets the same headers and no body.

This route does not touch any session, so a direct session's record is simply reaped after 60 s. Playback isn't affected.

**Errors:** `400 bad_request` / `invalid_path`, `403 forbidden`, `404 not_found`, `409 not_direct`, `416`.

## Session state, health and metrics

### GET /api/sessions/{id}

This route returns a session's current state without touching it, so polling it doesn't keep a session alive. An unknown session, or someone else's, → `404`.

```json
{
  "sessionId": "q718Ode85tVjsGtxj8CKwIlg",
  "mode": "transcode",
  "url": "/api/sessions/q718Ode85tVjsGtxj8CKwIlg/index.m3u8?v=2",
  "path": "video/mov_prores_pcm.mov",
  "start": 8,
  "duration": 12,
  "encoder": "running",
  "error": null
}
```

`encoder` is `none` (direct), `running`, `done` (the whole file is converted) or `failed` (with `error` set).

### GET /healthz

This route sits outside `/api`, so it has no CORS and no auth. It always answers `200 { "status": "ok", "sessions": <open sessions> }` while the process is up. Kubernetes uses it for the startup, readiness and liveness probes. It doesn't check the share or FFmpeg; a missing share shows up as `500 media_root_unavailable` on API calls instead.

### GET /metrics

This route is also outside `/api`. It returns the Prometheus text format from prom-client.

| Metric | Type | Updated when |
| --- | --- | --- |
| `wavy_active_transcodes` | gauge | A transcode session starts or stops. The HPA/KEDA autoscaling signal. |
| `wavy_transcode_capacity` | gauge | Set at startup to `MAX_TRANSCODES`. |
| `wavy_active_sessions{mode}` | gauge | Any session starts or stops. |
| `wavy_sessions_started_total{mode,extension}` | counter | `POST /api/sessions` succeeds. |
| `wavy_sessions_rejected_total{reason,extension}` | counter | A `422 unsupported` or a `503 capacity`. |
| `wavy_sessions_ended_total{cause}` | counter | stop runs (`deleted`, `idle`, `expired`, `shutdown`). |
| `wavy_ffmpeg_failures_total{mode,extension}` | counter | FFmpeg exits with an error the service didn't cause. |
| `wavy_ffmpeg_speed{mode}` | histogram | Each FFmpeg progress report (about once a second). Below 1 means the viewer will stall. |
| `wavy_probe_duration_seconds` | histogram | Each ffprobe run (cache hits are not counted). |
| `wavy_probe_results_total{mode,extension}` | counter | Each probe result, including unsupported files. |
| `wavy_process_*`, `wavy_nodejs_*` | various | Default process metrics (CPU, memory, file handles). |

The `extension` label is limited to the extensions in the rules file, and anything else is reported as `other`, so a share full of odd files can't create unlimited series.

## Worked examples

Four files, from click to cleanup. The file names are the generated sample files, and the responses are what the service returned in testing.

### 1. A standard MP4 (direct)

1. `POST /api/sessions { "path": "video/mp4_h264_aac.mp4" }` runs ffprobe and finds H.264 8-bit + AAC in MP4, so the `mp4` direct rule matches. The response is `201 { mode: "direct", url: "/api/files/video/mp4_h264_aac.mp4" }`. No FFmpeg is started.
2. The player sets `video.src = url`. Chrome sends `GET /api/files/... Range: bytes=0-` and gets `206`, then fetches more ranges as it plays and when the user seeks. The probe is cached, so those requests don't run ffprobe again.
3. On close, `DELETE` removes the record (`204`). If the player never sends it, the reaper drops the record after 60 s. CPU cost is near zero.

### 2. An MPEG-TS with H.264 + AAC (remux)

1. `POST /api/sessions` gives `mode: "remux"`. The service creates `/tmp/sessions/<id>/` and starts `ffmpeg ... -c:v copy -c:a copy -f hls ...`.
2. hls.js requests `index.m3u8`, which waits about 0.1 to 1 s for the first 4 s segment, then gets the playlist. It then fetches `g1_init.mp4`, `g1_00000.m4s` and so on. Every request resets the 60 s idle timer.
3. Copying is far faster than real time, so FFmpeg converts the whole file in a few seconds, adds `#EXT-X-ENDLIST`, and the encoder becomes `done`. Every segment is then on disk, and seeking anywhere works without `/seek`.
4. When the tab closes, `POST /stop` via sendBeacon (or the reaper after 60 s) deletes the folder.

### 3. A ProRes MOV (full transcode) with a seek

1. `POST /api/sessions` checks the transcode cap (fewer than 4 open, so it passes) and gives `mode: "transcode"`. FFmpeg runs libx264 veryfast, scaled to 1080p at most, AAC stereo. `wavy_active_transcodes` becomes 1.
2. The playlist arrives once the first segment is encoded. The player plays while FFmpeg works ahead of it, and `wavy_ffmpeg_speed{mode="transcode"}` records how far ahead.
3. The user drags to 8:00, past what is encoded. The player calls `POST /seek { position: 480 }`. The service kills FFmpeg, deletes the `g1_*` files, and starts `ffmpeg -ss 480.000 ...` writing `g2_*`. It answers `{ url: ".../index.m3u8?v=2", start: 480 }`.
4. The player loads the new URL, which waits for `g2_00000.m4s`, and shows `480 + currentTime`. The transcode slot stays with this session.
5. If a fifth viewer starts a transcode on this pod meanwhile, they get `503 capacity` with `Retry-After: 5`. With several pods, the ingress or a retry sends them to a pod with room.
6. On close, FFmpeg is killed, the folder deleted, and `wavy_active_transcodes` drops to 0.

### 4. A Genetec export (unsupported)

1. `GET /api/probe?path=other/export.g64x` answers `200 { mode: "unsupported", reason: "g64x is a Genetec proprietary format. Export it from Genetec Security Center first." }`. ffprobe never runs, because the extension is blocked. The file is logged as `unsupported_file`.
2. `POST /api/sessions` for the same file answers `422 { error: "unsupported", reason: "..." }`, and `wavy_sessions_rejected_total{reason="unsupported",extension="g64x"}` goes up.
3. The player shows the `reason` instead of a broken video. A random-byte `corrupt.mp4` takes the same path, except ffprobe runs and fails, and the reason reads "FFmpeg cannot read this file (...)".
