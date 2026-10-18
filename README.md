# wavy-server

An audio/video server for the web. It lets Chrome play the media files on our share
(CCTV exports, camcorder footage, edit exports, audio) without VLC. Each file is
probed with `ffprobe` and gets the cheapest playback mode that works. See the dev
spec ("Web Media Playback Service — Dev Spec") for the full design.

Contents: the playback API (`src/`), sample files and a scan tool (`scripts/`),
Kubernetes manifests (`deploy/k8s/`), a test player (`player/`) and an Angular client
(`clients/angular/`).

## Requirements

- [Bun](https://bun.sh) 1.4+
- FFmpeg and ffprobe on the `PATH` (`apt install ffmpeg`)

```bash
bun install
bun run typecheck
bun test        # generates samples in a temp folder and checks every mode
MEDIA_ROOT=./samples bun run start   # API on :8080
```

## Playback API

All paths are relative to the media root (`MEDIA_ROOT`, `/media` in the container).
Errors are `{ "error": "<code>", "reason": "<sentence for the user>" }`.

| Endpoint | Purpose | Response |
| --- | --- | --- |
| `GET /api/probe?path=` | ffprobe + decision table | `{ path, mode, reason, duration, container, size, video, audio: [{ track, codec, channels, lang }], subtitles, plan }` |
| `POST /api/sessions` `{ path, start?, audioTrack? }` | Start playback | `201 { sessionId, mode, url, start, duration, reason }`. `url` is the file URL for `direct`, else the HLS playlist. |
| `GET /api/sessions/{id}` | Session state | `{ sessionId, mode, url, path, start, duration, encoder, error }` |
| `GET /api/sessions/{id}/index.m3u8` | HLS playlist (waits for the first segment) | `application/vnd.apple.mpegurl` |
| `GET /api/sessions/{id}/{segment}` | HLS segment | `video/mp4` (fMP4) or `video/mp2t` |
| `POST /api/sessions/{id}/seek` `{ position }` | Restart FFmpeg at `position` seconds | `{ url, start }` |
| `DELETE /api/sessions/{id}` | Stop: kill FFmpeg, delete segments (idempotent) | `204` |
| `POST /api/sessions/{id}/stop` | Same as DELETE, for `navigator.sendBeacon` | `204` |
| `GET`/`HEAD /api/files/{path}` | Original file with Range support, `direct` files only | `200` / `206` / `416` |
| `GET /healthz`, `GET /metrics` | Liveness, Prometheus metrics | |

Status codes: `400` bad input or `invalid_path`, `404` missing file or session,
`409 not_direct` when `/api/files` is asked for a file that needs conversion,
`422 unsupported` with the reason to show, `502 ffmpeg_failed`, and `503` with
`Retry-After` when the pod is at `MAX_TRANSCODES` / `MAX_SESSIONS` (`capacity`) or the
first segment isn't ready in time (`not_ready`).

Behaviour:

- One temp folder and one FFmpeg process per HLS session. A session with no playlist
  or segment request for `SESSION_IDLE_TIMEOUT_MS` (60 s) is stopped and its folder
  deleted; so is any session older than `SESSION_MAX_AGE_MS`.
- Seeking restarts FFmpeg with `-ss`. The new playlist's timestamps start at 0, so the
  player adds the returned `start` to `currentTime`. Segment names carry a generation
  (`g2_00000.m4s`) so old and new segments never mix.
- Picking `audioTrack` other than 0 always goes through HLS, since the browser can't
  choose the track of a directly served file.
- Paths are normalized; `..`, absolute paths, NUL bytes and symlinks that leave the
  media root are rejected. FFmpeg gets an argument array, never a shell string.
- Unsupported and failed files are logged (JSON lines on stdout) with their probe
  result. Session start and end are logged with user, file, mode and time open.

### Authentication hook

Version 1 is open. `src/auth.ts` holds the hooks: `authenticate` (Hono middleware on
`/api/*`, sets `user`), `canViewPath(user, path)` and `canUseSession(user, ownerId)`.
Sessions already record their owner, so once `authenticate` sets a user, sessions and
segments are only reachable by the user who created them.

### Metrics

| Metric | Meaning |
| --- | --- |
| `wavy_active_transcodes` | Full transcodes open on this pod: the autoscaling signal. |
| `wavy_transcode_capacity` | `MAX_TRANSCODES` for this pod. |
| `wavy_active_sessions{mode}` | Open sessions by mode. |
| `wavy_sessions_started_total{mode,extension}` | Sessions started. |
| `wavy_sessions_rejected_total{reason,extension}` | `unsupported` or `capacity`. |
| `wavy_sessions_ended_total{cause}` | `deleted`, `idle`, `expired`, `shutdown`. |
| `wavy_ffmpeg_failures_total{mode,extension}` | FFmpeg exits with an error. |
| `wavy_ffmpeg_speed{mode}` | Histogram of FFmpeg speed (x real time); below 1 stalls. |
| `wavy_probe_duration_seconds`, `wavy_probe_results_total{mode,extension}` | ffprobe timing and outcomes. |

Plus the default process metrics, prefixed `wavy_`.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. |
| `MEDIA_ROOT` | `/media` | Read-only share. |
| `SESSIONS_DIR` | `$TMPDIR/sessions` (`/tmp/sessions` in the image) | HLS temp folders; wiped at startup. |
| `PLAYBACK_RULES` | `config/playback-rules.json` | Decision table. |
| `MAX_TRANSCODES` | `4` | Concurrent full transcodes per pod. |
| `MAX_SESSIONS` | `50` | Concurrent HLS sessions per pod. |
| `SESSION_IDLE_TIMEOUT_MS` | `60000` | Stop a session after this long without requests. |
| `SESSION_MAX_AGE_MS` | `14400000` | Hard session lifetime (4 h). |
| `SESSION_REAP_INTERVAL_MS` | `5000` | How often idle sessions are checked. |
| `PLAYLIST_WAIT_MS` | `15000` | How long a playlist request waits for the first segment. |
| `HLS_TIME` | `4` | Segment length in seconds. |
| `HLS_SEGMENT_TYPE` | `fmp4` | `fmp4` or `mpegts`. |
| `X264_PRESET`, `X264_CRF` | `veryfast`, `23` | Full transcode quality. |
| `AUDIO_BITRATE` | `160k` | AAC bitrate. |
| `RETRY_AFTER_SEC` | `5` | `Retry-After` on 503. |
| `CORS_ORIGINS` | `*` | Allowed browser origins, comma-separated. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Binaries. |
| `LOG_LEVEL` | | `silent` turns logs off. |

### Docker

```bash
docker build -t wavy-server .
docker run -p 8080:8080 -v /path/to/media:/media:ro --read-only --tmpfs /tmp wavy-server
```

The image is `oven/bun` slim with Debian's FFmpeg, runs as uid 1000 under `tini`, and
works with a read-only root filesystem as long as `/tmp` is writable.

## Playback modes

| Mode | Meaning |
| --- | --- |
| `direct` | Chrome plays the original file as-is (HTTP Range). |
| `remux` | Codecs are fine, only the container changes (stream copy into HLS). |
| `transcode-audio` | Video is copied (or there is none); audio is converted to AAC. |
| `transcode` | Video is re-encoded to H.264 (max 1080p). |
| `unsupported` | Blocked, not on the allowed list, or FFmpeg can't read it. |

Video and audio are decided independently, by codec, never by extension alone.

## Sample files

```bash
bun run samples            # writes ./samples (kept out of git)
bun run samples -- --force --duration 30
```

Generates 41 short files covering the format inventory: H.264 (8-bit and 10-bit),
HEVC, ProRes, DNxHR, MPEG-1/2, Xvid, MJPEG, WMV, VP9, raw H.264/HEVC CCTV streams,
AC3, G.711, ADPCM, ALAC, WMA and the common audio formats, plus blocked, unknown and
corrupt files. `samples/manifest.json` lists each file with its expected mode.

FFmpeg can read but not write two inventory formats, so they need real files:
Dahua `.dav` and `.tak`.

## Scanning a folder

```bash
bun run scan -- /media --out inventory.csv
```

Probes every file under the folder (symlinks are skipped) and writes a CSV with
path, extension, size, container, video codec, resolution, fps, pixel format, audio
codec, channels, duration, mode, the per-stream action (`copy`, `encode`, `none`) and
the reason. A summary by mode goes to stderr:

```
42 files
  direct               12   28.6%     7.0 MB  mp3 2, mp4 2, aac 1, ...
  remux                 3    7.1%     6.9 MB  264 1, mov 1, ts 1
  transcode-audio       9   21.4%    12.4 MB  wav 2, avi 2, ...
  transcode            11   26.2%    45.4 MB  avi 2, mov 2, mp4 2, ...
  unsupported           7   16.7%    19.1 KB  g64x 1, prproj 1, ...
```

Running it on the real share gives the remux/transcode ratio needed to size the cluster.

## Playback rules

The decision table lives in [`config/playback-rules.json`](config/playback-rules.json).
Point `PLAYBACK_RULES` (or `scan --rules`) at another file to change it without a code
change.

| Field | Purpose |
| --- | --- |
| `allowedExtensions` | Only these extensions are probed at all. |
| `blockedExtensions` | Extension → message shown to the user (g64x, prproj, pkf, sys). |
| `inputOverrides` | Extra FFmpeg input options per extension, e.g. raw `.264` needs `-f h264 -framerate 25`. |
| `probeFallbackFormats` | Formats to force when auto-detection fails (`mpeg` for Hikvision-style files). |
| `direct` | Container + codec combinations Chrome plays natively. `formats` match ffprobe's `format_name`. |
| `copy` | Codecs that can be copied into HLS without re-encoding, with pixel format, height and channel limits. |
| `allowHevcPassthrough` | Treat HEVC like H.264. Only turn on if every PC has a hardware HEVC decoder. |
| `transcode.maxHeight` | Re-encoded video is scaled down to this height (never up). |
