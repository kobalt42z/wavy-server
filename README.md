# wavy-server

An audio/video server for the web. It lets Chrome play the media files on our share
(CCTV exports, camcorder footage, edit exports, audio) without VLC. Each file is
probed with `ffprobe` and gets the cheapest playback mode that works. See the dev
spec ("Web Media Playback Service — Dev Spec") for the full design.

Status: step 1 of 4 (sample files and scan tool). The playback API, Kubernetes
deployment and test player come next.

## Requirements

- [Bun](https://bun.sh) 1.4+
- FFmpeg and ffprobe on the `PATH` (`apt install ffmpeg`)

```bash
bun install
bun run typecheck
bun test        # generates samples in a temp folder and checks every mode
```

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
