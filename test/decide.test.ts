import { describe, expect, test } from "bun:test";
import { decide, checkExtension } from "../src/decide.ts";
import { parseFfprobe, type ProbeResult } from "../src/probe.ts";
import { loadRules, normalizeRules, type PlaybackRules } from "../src/rules.ts";

const rules = loadRules();
const withRules = (patch: (r: PlaybackRules) => void): PlaybackRules => {
  const r = structuredClone(rules);
  patch(r);
  return r;
};

function probe(p: Partial<ProbeResult>): ProbeResult {
  return { container: "mov,mp4,m4a,3gp,3g2,mj2", video: [], audio: [], subtitles: [], inputArgs: [], ...p };
}
const h264 = { index: 0, codec: "h264", pixFmt: "yuv420p", width: 1920, height: 1080 };
const hevc = { index: 0, codec: "hevc", pixFmt: "yuv420p", width: 1920, height: 1080 };
const aac = { index: 1, codec: "aac", channels: 2 };

describe("extension checks", () => {
  test("blocked extensions return the configured reason", () => {
    expect(checkExtension("g64x", rules)).toContain("Genetec");
  });
  test("unknown extensions are rejected", () => {
    expect(checkExtension("exe", rules)).toContain(".exe");
    expect(checkExtension("", rules)).toContain("without an extension");
  });
  test("allowed extensions pass", () => {
    expect(checkExtension("dav", rules)).toBeNull();
    expect(checkExtension("tak", rules)).toBeNull();
  });
});

describe("decide", () => {
  test("mov with H.264 + AAC remuxes (direct is limited to .mp4/.m4v/.m4a)", () => {
    expect(decide(probe({ video: [h264], audio: [aac] }), "mov", rules).mode).toBe("remux");
    expect(decide(probe({ video: [h264], audio: [aac] }), "mp4", rules).mode).toBe("direct");
  });

  test("HEVC transcodes by default and is copied when passthrough is on", () => {
    const p = probe({ video: [hevc], audio: [aac] });
    expect(decide(p, "mp4", rules).mode).toBe("transcode");
    const on = withRules((r) => (r.allowHevcPassthrough = true));
    expect(decide(p, "mp4", on).mode).toBe("direct");
    expect(decide(probe({ container: "dhav", video: [hevc], audio: [aac] }), "dav", on).mode).toBe("remux");
  });

  test("Dahua H.264 with G.711 copies video and encodes audio", () => {
    const d = decide(probe({ container: "dhav", video: [h264], audio: [{ index: 1, codec: "pcm_alaw", channels: 1 }] }), "dav", rules);
    expect(d.mode).toBe("transcode-audio");
    expect(d.video.action).toBe("copy");
    expect(d.audio.action).toBe("encode");
  });

  test("video above the copy height limit is re-encoded and capped at 1080p", () => {
    const tall = { ...h264, width: 7680, height: 4320 };
    const d = decide(probe({ container: "mpegts", video: [tall], audio: [aac] }), "ts", rules);
    expect(d.mode).toBe("transcode");
    expect(d.maxOutputHeight).toBe(1080);
    const lower = withRules((r) => (r.copy.maxVideoHeight = 1080));
    expect(decide(probe({ container: "mpegts", video: [{ ...h264, height: 2160 }] }), "ts", lower).mode).toBe("transcode");
  });

  test("files needing forced input options are never direct", () => {
    const d = decide(probe({ container: "h264", video: [h264], inputArgs: ["-f", "h264"] }), "264", rules);
    expect(d.mode).toBe("remux");
  });

  test("a file with no streams is unsupported", () => {
    expect(decide(probe({}), "mp4", rules).mode).toBe("unsupported");
  });

  test("audio-only AAC in an unknown container remuxes", () => {
    expect(decide(probe({ container: "matroska,webm", audio: [aac] }), "webm", rules).mode).toBe("remux");
  });
});

describe("parseFfprobe", () => {
  test("normalizes streams and skips cover art", () => {
    const p = parseFfprobe({
      format: { format_name: "MP3", duration: "12.5", size: "1000" },
      streams: [
        { index: 0, codec_type: "audio", codec_name: "mp3", channels: 2, sample_rate: "44100", tags: { language: "eng" } },
        { index: 1, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
        { index: 2, codec_type: "video", codec_name: "h264", avg_frame_rate: "30000/1001", width: 1280, height: 720 },
        { index: 3, codec_type: "subtitle", codec_name: "mov_text" },
      ],
    });
    expect(p.container).toBe("mp3");
    expect(p.duration).toBe(12.5);
    expect(p.audio).toEqual([{ index: 0, codec: "mp3", channels: 2, sampleRate: 44100, lang: "eng" }]);
    expect(p.video.map((v) => v.index)).toEqual([2]);
    expect(p.video[0]?.fps).toBe(29.97);
    expect(p.subtitles).toHaveLength(1);
  });
});

describe("rules validation", () => {
  test("bad config fails with a clear message", () => {
    expect(() => normalizeRules({ direct: "nope" })).toThrow(/direct must be an array/);
    expect(() => normalizeRules({ ...structuredClone(rules), copy: { ...rules.copy, maxVideoHeight: -1 } })).toThrow(/maxVideoHeight/);
  });
  test("extensions and codecs are lower-cased", () => {
    const r = normalizeRules({ ...structuredClone(rules), allowedExtensions: ["MP4"], blockedExtensions: { G64X: "x" } });
    expect(r.allowedExtensions).toEqual(["mp4"]);
    expect(r.blockedExtensions.g64x).toBe("x");
  });
});
