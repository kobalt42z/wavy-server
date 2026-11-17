// @ts-nocheck -- the fakes are untyped, as in the original JavaScript tests.
/* Ported from the server repo's player/wavy-player.test.js, against the TypeScript WavyPlayer. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PlaybackError, describeError, formatTime } from './errors';
import { WavyPlayer as RealPlayer } from './player';

// The fake media and hls.js are typed loosely, like the original tests.
type Any = any;

/** Test access to the player's private page-close handler. */
class WavyPlayer extends RealPlayer {
  _stopOnUnload() {
    (this as Any).stopOnUnload();
  }
}

// --- fakes -----------------------------------------------------------------

class FakeTimeRanges {
  constructor(ranges = []) {
    this.ranges = ranges;
  }
  get length() {
    return this.ranges.length;
  }
  start(i) {
    return this.ranges[i][0];
  }
  end(i) {
    return this.ranges[i][1];
  }
}

class FakeMedia extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.duration = NaN;
    this.seekable = new FakeTimeRanges();
    this._src = "";
    this.plays = 0;
    this.loads = 0;
  }
  get src() {
    return this._src;
  }
  set src(v) {
    this._src = v;
  }
  getAttribute(name) {
    return name === "src" && this._src ? this._src : null;
  }
  removeAttribute(name) {
    if (name === "src") this._src = "";
  }
  load() {
    this.loads++;
  }
  play() {
    this.plays++;
    return Promise.resolve();
  }
}

function makeHls() {
  const instances: Any[] = [];
  class FakeHls {
    static Events = { ERROR: "hlsError" };
    static ErrorTypes = { MEDIA_ERROR: "mediaError", NETWORK_ERROR: "networkError" };
    static isSupported() {
      return true;
    }
    constructor(config) {
      this.config = config;
      this.handlers = {};
      this.destroyed = false;
      this.recovered = 0;
      instances.push(this);
    }
    on(event, fn) {
      (this.handlers[event] ??= []).push(fn);
    }
    emit(event, data) {
      for (const fn of this.handlers[event] ?? []) fn(event, data);
    }
    loadSource(url) {
      this.source = url;
    }
    attachMedia(media) {
      this.media = media;
    }
    recoverMediaError() {
      this.recovered++;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { FakeHls, instances };
}

/** A fake API: routes are "METHOD /path" → (body, url) => [status, json, headers?]. */
function makeApi(routes: Any) {
  const calls: Any[] = [];
  const fetch = async (url: Any, init: Any = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url, "http://test.local");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, init });
    const route = routes[`${method} ${u.pathname}`];
    if (!route) return new Response("", { status: 404 });
    const [status, json, headers] = route(body, u);
    return new Response(json === undefined ? "" : JSON.stringify(json), { status, headers });
  };
  return { fetch, calls };
}

const PROBE_TRANSCODE = {
  mode: "transcode",
  duration: 300,
  container: "mov",
  video: { codec: "prores", width: 1920, height: 1080, fps: 25 },
  audio: [{ codec: "pcm_s16le", channels: 2 }],
  subtitles: [],
};

function setup(routes: Any, options: Any = {}) {
  const media = new FakeMedia();
  const { FakeHls, instances } = makeHls();
  const api = makeApi(routes);
  const player = new WavyPlayer(media as Any, { loadHls: async () => FakeHls as Any, fetch: api.fetch as Any, stopOnPageHide: false, ...options });
  return { media, player, api, hls: instances };
}

const sessionRoutes = (probe: Any, session: Any) => ({
  "GET /api/probe": () => [200, probe],
  "POST /api/sessions": () => [201, session],
  "DELETE /api/sessions/s1": () => [204, undefined],
  "DELETE /api/sessions/s2": () => [204, undefined],
});

// --- tests -------------------------------------------------------------------

describe("WavyPlayer.load", () => {
  test("direct mode sets media.src and uses no hls.js", async () => {
    const { media, player, api, hls } = setup(
      sessionRoutes(
        { mode: "direct", duration: 12.5, container: "mp4" },
        { sessionId: "s1", mode: "direct", url: "/api/files/a%20b.mp4" },
      ),
    );
    await player.load("a b.mp4");
    expect(api.calls[0]).toMatchObject({ method: "GET", path: "/api/probe", search: "?path=a%20b.mp4" });
    expect(api.calls[1]).toMatchObject({ method: "POST", path: "/api/sessions", body: { path: "a b.mp4" } });
    expect(media.src).toBe("/api/files/a%20b.mp4");
    expect(hls).toHaveLength(0);
    expect(player.mode).toBe("direct");
    expect(player.duration).toBe(12.5);
    expect(player.state).toBe("playing");
    expect(media.plays).toBe(1);
  });

  test("getToken: one token per load, sent to probe and session start only", async () => {
    const asked: Any[] = [];
    const { media, player, api } = setup(
      {
        ...sessionRoutes(
          { mode: "direct", duration: 5, container: "mp4" },
          { sessionId: "s1", mode: "direct", url: "/api/sessions/s1/file" },
        ),
      },
      { getToken: async (path: Any) => (asked.push(path), "tok-1") },
    );
    await player.load("cases/12/a.mp4");
    expect(asked).toEqual(["cases/12/a.mp4"]);
    expect(api.calls[0].init.headers).toMatchObject({ authorization: "Bearer tok-1" });
    expect(api.calls[1].init.headers).toMatchObject({ authorization: "Bearer tok-1", "content-type": "application/json" });
    expect(media.src).toBe("/api/sessions/s1/file");
    await player.stop();
    const del = api.calls.find((c: Any) => c.method === "DELETE");
    expect(del.init.headers).toBeUndefined();
  });

  test("getToken failing rejects load() with an unauthorized error and starts nothing", async () => {
    const { player, api } = setup(sessionRoutes({ mode: "direct" }, { sessionId: "s1", mode: "direct", url: "/x" }), {
      getToken: async () => {
        throw new Error("403 from main");
      },
    });
    await expect(player.load("a.mp4")).rejects.toMatchObject({ code: "unauthorized" });
    expect(api.calls).toHaveLength(0);
  });

  test("direct mode with a start time jumps there once metadata loads", async () => {
    const { media, player } = setup(
      sessionRoutes({ mode: "direct", duration: 60 }, { sessionId: "s1", mode: "direct", url: "/api/files/x.mp4" }),
    );
    await player.load("x.mp4", { start: 30 });
    expect(media.currentTime).toBe(0);
    media.dispatchEvent(new Event("loadedmetadata"));
    expect(media.currentTime).toBe(30);
    expect(player.currentTime).toBe(30);
  });

  test("HLS modes load the playlist with hls.js from the start of the playlist", async () => {
    const { media, player, api, hls } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
      { apiBase: "https://media.example.com/" },
    );
    await player.load("edit/master.mov", { start: 42 });
    expect(api.calls[1].body).toEqual({ path: "edit/master.mov", start: 42 });
    expect(hls).toHaveLength(1);
    expect(hls[0].source).toBe("https://media.example.com/api/sessions/s1/index.m3u8");
    expect(hls[0].media).toBe(media);
    expect(hls[0].config.startPosition).toBe(0);
    expect(media.src).toBe("");
    // Playlist timestamps restart at 0, so absolute time = start + media time.
    media.currentTime = 3;
    expect(player.offset).toBe(42);
    expect(player.currentTime).toBe(45);
    expect(player.duration).toBe(300);
  });

  test("the server's start and duration win, and audioTrack is passed on", async () => {
    const { player, api, media } = setup(
      sessionRoutes(
        { mode: "transcode", container: "mov" }, // no duration in the probe
        { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8", start: 40, duration: 250 },
      ),
    );
    await player.load("x.mov", { start: 42, audioTrack: 2 });
    expect(api.calls[1].body).toEqual({ path: "x.mov", start: 42, audioTrack: 2 });
    expect(player.offset).toBe(40);
    expect(player.duration).toBe(250);
    media.currentTime = 2;
    expect(player.currentTime).toBe(42);
  });

  test("manifest 404s are retried while FFmpeg starts, other 4xx are not", async () => {
    const { player, hls } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "remux", url: "/api/sessions/s1/index.m3u8" }),
    );
    await player.load("x.ts");
    const retry = hls[0].config.manifestLoadPolicy.default.errorRetry;
    expect(retry.shouldRetry(retry, 0, false, { code: 404 }, false)).toBe(true);
    expect(retry.shouldRetry(retry, retry.maxNumRetry, false, { code: 404 }, false)).toBe(false);
    expect(retry.shouldRetry(retry, 0, false, { code: 403 }, false)).toBe(false);
    expect(retry.shouldRetry(retry, 0, false, { code: 500 }, true)).toBe(true);
  });

  test("unsupported probe shows the API reason and starts no session", async () => {
    const reason = "g64x is a Genetec proprietary format. Export it from Genetec Security Center first.";
    const { player, api, hls } = setup({
      "GET /api/probe": () => [200, { mode: "unsupported", reason }],
    });
    const err = await player.load("cam.g64x").catch((e: Any) => e);
    expect(err).toBeInstanceOf(PlaybackError);
    expect(err.code).toBe("unsupported");
    expect(describeError(err)).toBe(reason);
    expect(api.calls.filter((c: Any) => c.method === "POST")).toHaveLength(0);
    expect(hls).toHaveLength(0);
    expect(player.state).toBe("error");
  });

  test("an {error, reason} response is surfaced as is", async () => {
    const { player } = setup({
      "GET /api/probe": () => [415, { error: "unsupported", reason: "prproj is an Adobe Premiere project file, not media." }],
    });
    const err = await player.load("a.prproj").catch((e: Any) => e);
    expect(err.code).toBe("unsupported");
    expect(err.status).toBe(415);
    expect(describeError(err)).toBe("prproj is an Adobe Premiere project file, not media.");
  });

  test("a busy server (503 + Retry-After) gives a retry message", async () => {
    const { player } = setup({
      "GET /api/probe": () => [200, PROBE_TRANSCODE],
      "POST /api/sessions": () => [503, { error: "busy", reason: "Too many transcodes." }, { "Retry-After": "15" }],
    });
    const err = await player.load("x.mov").catch((e: Any) => e);
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBe(15);
    expect(describeError(err)).toBe("The playback server is busy. Try again in 15 seconds.");
  });

  test("an unreachable service gives a network error", async () => {
    const media = new FakeMedia();
    const player = new WavyPlayer(media, {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      stopOnPageHide: false,
    });
    const err = await player.load("x.mp4").catch((e: Any) => e);
    expect(err.code).toBe("network");
    expect(describeError(err)).toBe("Could not reach the playback service.");
  });

  test("a non-JSON error body still gives a readable reason", async () => {
    const { player } = setup({ "GET /api/probe": () => [404, undefined] });
    const err = await player.load("missing.mp4").catch((e: Any) => e);
    expect(err.code).toBe("not-found");
    expect(describeError(err)).toBe("The file was not found.");
  });

  test("loading another file deletes the previous session", async () => {
    let n = 0;
    const { player, api, hls } = setup({
      "GET /api/probe": () => [200, PROBE_TRANSCODE],
      "POST /api/sessions": () => {
        n++;
        return [201, { sessionId: `s${n}`, mode: "transcode", url: `/api/sessions/s${n}/index.m3u8` }];
      },
      "DELETE /api/sessions/s1": () => [204, undefined],
    });
    await player.load("a.mov");
    await player.load("b.mov");
    expect(api.calls.some((c: Any) => c.method === "DELETE" && c.path === "/api/sessions/s1")).toBe(true);
    expect(hls[0].destroyed).toBe(true);
    expect(player.sessionId).toBe("s2");
  });

  test("a session that fails to attach is deleted", async () => {
    const media = new FakeMedia();
    const api = makeApi(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
    );
    const player = new WavyPlayer(media, { fetch: api.fetch, stopOnPageHide: false }); // no Hls
    const err = await player.load("x.mov").catch((e: Any) => e);
    expect(err.code).toBe("no-hls");
    expect(api.calls.some((c: Any) => c.method === "DELETE" && c.path === "/api/sessions/s1")).toBe(true);
    expect(player.sessionId).toBeNull();
  });
});

describe("WavyPlayer.seek", () => {
  async function playing() {
    const ctx = setup({
      ...sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
      "POST /api/sessions/s1/seek": (body: Any) => [
        200,
        { url: `/api/sessions/s1/index.m3u8?from=${body.position}`, start: body.position === 200 ? 198 : body.position },
      ],
    });
    await ctx.player.load("x.mov");
    ctx.media.seekable = new FakeTimeRanges([[0, 40]]);
    return ctx;
  }

  test("inside the transcoded part it is a plain media seek", async () => {
    const { player, media, api, hls } = await playing();
    await player.seek(20);
    expect(media.currentTime).toBe(20);
    expect(api.calls.some((c: Any) => c.path.endsWith("/seek"))).toBe(false);
    expect(hls).toHaveLength(1);
    expect(player.availableEnd).toBe(40);
  });

  test("past the transcoded part it restarts FFmpeg and reloads the playlist", async () => {
    const { player, media, api, hls } = await playing();
    await player.seek(200);
    const call = api.calls.find((c: Any) => c.path === "/api/sessions/s1/seek");
    expect(call.body).toEqual({ position: 200 });
    expect(hls).toHaveLength(2);
    expect(hls[0].destroyed).toBe(true);
    expect(hls[1].source).toBe("/api/sessions/s1/index.m3u8?from=200");
    expect(player.offset).toBe(198); // the server snapped to a keyframe
    media.currentTime = 1.5;
    expect(player.currentTime).toBe(199.5);
    // Back before the new playlist's start also needs a restart.
    media.seekable = new FakeTimeRanges([[0, 30]]);
    await player.seek(10);
    expect(api.calls.filter((c: Any) => c.path.endsWith("/seek"))).toHaveLength(2);
    expect(player.offset).toBe(10);
  });

  test("seeks are clamped to the file", async () => {
    const { player, api } = await playing();
    await player.seek(10_000);
    expect(api.calls.find((c: Any) => c.path.endsWith("/seek")).body.position).toBe(299.5);
  });

  test("direct mode seeks the media element", async () => {
    const { player, media, api } = setup(
      sessionRoutes({ mode: "direct", duration: 60 }, { sessionId: "s1", mode: "direct", url: "/api/files/x.mp4" }),
    );
    await player.load("x.mp4");
    await player.seek(45);
    expect(media.currentTime).toBe(45);
    expect(api.calls.some((c: Any) => c.path.endsWith("/seek"))).toBe(false);
  });
});

describe("WavyPlayer stop and errors", () => {
  test("stop() deletes the session and resets the player", async () => {
    const { player, api, hls, media } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
    );
    await player.load("x.mov");
    await player.stop();
    expect(api.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/sessions/s1" });
    expect(hls[0].destroyed).toBe(true);
    expect(player.sessionId).toBeNull();
    expect(player.state).toBe("idle");
    expect(media.src).toBe("");
  });

  test("page close sends a keepalive DELETE", async () => {
    const { player, api } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
    );
    await player.load("x.mov");
    player._stopOnUnload();
    await Promise.resolve();
    const call = api.calls.at(-1);
    expect(call).toMatchObject({ method: "DELETE", path: "/api/sessions/s1" });
    expect(call.init.keepalive).toBe(true);
  });

  test("page close prefers sendBeacon to the /stop alias", async () => {
    const { player, api } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
      { apiBase: "https://media.example.com" },
    );
    await player.load("x.mov");
    const beacons: Any[] = [];
    const original = navigator.sendBeacon;
    navigator.sendBeacon = (url: Any) => {
      beacons.push(url);
      return true;
    };
    try {
      player._stopOnUnload();
    } finally {
      navigator.sendBeacon = original;
    }
    expect(beacons).toEqual(["https://media.example.com/api/sessions/s1/stop"]);
    expect(api.calls.some((c: Any) => c.method === "DELETE")).toBe(false);
    expect(player.sessionId).toBeNull();
  });

  test("a fatal media error is recovered once, then reported", async () => {
    const { player, hls } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
    );
    const errors: Any[] = [];
    player.addEventListener("error", (e: Any) => errors.push(e.detail));
    await player.load("x.mov");
    hls[0].emit("hlsError", { fatal: true, type: "mediaError" });
    expect(hls[0].recovered).toBe(1);
    expect(errors).toHaveLength(0);
    hls[0].emit("hlsError", { fatal: true, type: "mediaError" });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("stream");
    expect(player.state).toBe("error");
  });

  test("a fatal network error is reported with the HTTP status (auto-resume off)", async () => {
    const { player, hls } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
      { autoResume: false },
    );
    const errors: Any[] = [];
    player.addEventListener("error", (e: Any) => errors.push(e.detail));
    await player.load("x.mov");
    hls[0].emit("hlsError", { fatal: false, type: "networkError" });
    expect(errors).toHaveLength(0);
    hls[0].emit("hlsError", { fatal: true, type: "networkError", response: { code: 410 } });
    expect(errors[0].status).toBe(410);
    expect(describeError(errors[0])).toContain("HTTP 410");
  });
});

describe("helpers", () => {
  test("formatTime", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(NaN)).toBe("--:--");
  });
});

describe("WavyPlayer auto-resume", () => {
  const tick = () => new Promise((r: Any) => setTimeout(r, 0));
  // Each POST /api/sessions hands out the next session id.
  const resumeRoutes = (probe: Any, mode: Any, url = (id: Any) => `/api/sessions/${id}/index.m3u8`) => {
    let n = 0;
    return {
      "GET /api/probe": () => [200, probe],
      "POST /api/sessions": (body: Any) => {
        const id = `s${++n}`;
        return [201, { sessionId: id, mode, url: url(id), start: body.start ?? 0 }];
      },
      "DELETE /api/sessions/s1": () => [204, undefined],
      "DELETE /api/sessions/s2": () => [204, undefined],
      "DELETE /api/sessions/s3": () => [204, undefined],
      "DELETE /api/sessions/s4": () => [204, undefined],
    };
  };

  test("a lost HLS session restarts at the current position", async () => {
    const { player, api, hls, media } = setup(resumeRoutes(PROBE_TRANSCODE, "transcode"));
    const resumes: Any[] = [];
    const errors: Any[] = [];
    player.addEventListener("resume", (e: Any) => resumes.push(e.detail));
    player.addEventListener("error", (e: Any) => errors.push(e.detail));
    await player.load("x.avi", { audioTrack: 1 });
    media.currentTime = 42;
    hls[0].emit("hlsError", { fatal: true, type: "networkError", response: { code: 404 } });
    await tick();
    await tick();

    expect(resumes).toHaveLength(1);
    expect(resumes[0].position).toBe(42);
    expect(errors).toHaveLength(0);
    const starts = api.calls.filter((c: Any) => c.method === "POST" && c.path === "/api/sessions");
    expect(starts.at(-1).body).toEqual({ path: "x.avi", start: 42, audioTrack: 1 });
    expect(player.sessionId).toBe("s2");
    expect(player.offset).toBe(42);
    expect(player.state).toBe("playing");
    expect(hls.at(-1).source).toBe("/api/sessions/s2/index.m3u8");
  });

  test("a resume that hits a busy or vanishing pod is tried again", async () => {
    const routes = resumeRoutes(PROBE_TRANSCODE, "transcode");
    let probes = 0;
    const probe = routes["GET /api/probe"];
    // The second probe (the first resume) lands on a pod that is going away.
    routes["GET /api/probe"] = (...args: Any[]) => (++probes === 2 ? [503, { error: "capacity", reason: "busy" }, { "Retry-After": "1" }] : probe(...args));
    const { player, hls, media } = setup(routes);
    const errors: Any[] = [];
    player.addEventListener("error", (e: Any) => errors.push(e.detail));
    await player.load("x.avi");
    media.currentTime = 50;
    hls[0].emit("hlsError", { fatal: true, type: "networkError", response: { code: 404 } });
    await tick();
    await tick();
    expect(player.state).toBe("error");
    await new Promise((r: Any) => setTimeout(r, 1100));
    await tick();
    await tick();
    expect(errors).toHaveLength(0);
    expect(player.state).toBe("playing");
    expect(player.offset).toBe(50);
    expect(probes).toBe(3);
  });

  test("gives up after maxResumes losses in a minute", async () => {
    const { player, hls } = setup(resumeRoutes(PROBE_TRANSCODE, "transcode"), { maxResumes: 2 });
    const errors: Any[] = [];
    player.addEventListener("error", (e: Any) => errors.push(e.detail));
    await player.load("x.avi");
    for (let i = 0; i < 3; i++) {
      hls.at(-1).emit("hlsError", { fatal: true, type: "networkError", response: { code: 404 } });
      await tick();
      await tick();
    }
    expect(hls).toHaveLength(3); // the first one + 2 resumes
    expect(errors).toHaveLength(1);
    expect(errors[0].status).toBe(404);
    expect(player.state).toBe("error");
  });

  test("a seek on a lost session starts a new one at the target", async () => {
    const routes = resumeRoutes(PROBE_TRANSCODE, "transcode");
    routes["POST /api/sessions/s1/seek"] = () => [404, { error: "not_found", reason: "The session does not exist or has ended." }];
    const { player, api } = setup(routes);
    await player.load("x.avi");
    await player.seek(200);
    await tick();
    await tick();
    const starts = api.calls.filter((c: Any) => c.method === "POST" && c.path === "/api/sessions");
    expect(starts.at(-1).body).toEqual({ path: "x.avi", start: 200 });
    expect(player.sessionId).toBe("s2");
    expect(player.state).toBe("playing");
  });

  test("a direct file that stops loading mid-playback resumes", async () => {
    const probe = { ...PROBE_TRANSCODE, mode: "direct" };
    const { player, media, api } = setup(resumeRoutes(probe, "direct", (id) => `/api/sessions/${id}/file`));
    await player.load("a.mp4");
    media.currentTime = 30;
    media.error = { code: 2 };
    media.dispatchEvent(new Event("error"));
    await tick();
    await tick();
    expect(api.calls.filter((c: Any) => c.method === "POST" && c.path === "/api/sessions").at(-1).body).toEqual({ path: "a.mp4", start: 30 });
    expect(media.src).toBe("/api/sessions/s2/file");
  });

  test("a decode error on a direct file is not resumed", async () => {
    const probe = { ...PROBE_TRANSCODE, mode: "direct" };
    const { player, media, api } = setup(resumeRoutes(probe, "direct", (id) => `/api/sessions/${id}/file`));
    await player.load("a.mp4");
    media.currentTime = 30;
    media.error = { code: 3 };
    media.dispatchEvent(new Event("error"));
    await tick();
    expect(api.calls.filter((c: Any) => c.method === "POST" && c.path === "/api/sessions")).toHaveLength(1);
    expect(player.sessionId).toBe("s1");
  });
});

describe("WavyPlayer withCredentials", () => {
  test("off by default: no credentials on API calls, no xhrSetup", async () => {
    const { player, api, hls } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
    );
    await player.load("x.mov");
    expect(api.calls.every((c: Any) => c.init.credentials === undefined)).toBe(true);
    expect(hls[0].config.xhrSetup).toBeUndefined();
  });

  test("sends cookies on API calls, hls.js requests and the direct file", async () => {
    const { player, api, hls } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
      { withCredentials: true, apiBase: "https://media.example.com" },
    );
    await player.load("x.mov");
    await player.stop();
    expect(api.calls.map((c: Any) => c.init.credentials)).toEqual(["include", "include", "include"]);
    const xhr: Any = {};
    hls[0].config.xhrSetup(xhr);
    expect(xhr.withCredentials).toBe(true);

    const direct = setup(
      sessionRoutes({ ...PROBE_TRANSCODE, mode: "direct" }, { sessionId: "s1", mode: "direct", url: "/api/sessions/s1/file" }),
      { withCredentials: true },
    );
    await direct.player.load("a.mp4");
    expect(direct.media.crossOrigin).toBe("use-credentials");
  });
});

describe("WavyPlayer additions", () => {
  test("autoplay: false attaches the stream without playing", async () => {
    const { player, media } = setup(sessionRoutes({ mode: "direct", duration: 5 }, { sessionId: "s1", mode: "direct", url: "/f" }));
    await player.load("a.mp3", { autoplay: false });
    expect(media.src).toBe("/f");
    expect(media.plays).toBe(0);
  });

  test("without Media Source, HLS plays natively where the browser can (iPhone Safari)", async () => {
    const routes = sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" });
    const { media, player, hls } = setup(routes);
    media.canPlayType = (t) => (t === "application/vnd.apple.mpegurl" ? "maybe" : "");
    const { FakeHls } = makeHls();
    FakeHls.isSupported = () => false;
    (player as Any).loadHls = async () => FakeHls;
    await player.load("x.mov");
    expect(hls).toHaveLength(0);
    expect(media.src).toBe("/api/sessions/s1/index.m3u8");
  });

  test("hls.js is preferred over native HLS when Media Source works", async () => {
    const { media, player, hls } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
    );
    media.canPlayType = () => "maybe";
    await player.load("x.mov");
    expect(hls).toHaveLength(1);
  });

  test("on() returns an unsubscribe function", async () => {
    const { player } = setup(sessionRoutes({ mode: "direct" }, { sessionId: "s1", mode: "direct", url: "/f" }));
    const states: string[] = [];
    const off = player.on("statechange", ({ state }) => states.push(state));
    await player.load("a.mp3");
    off();
    await player.stop();
    expect(states).toEqual(["probing", "starting", "playing"]);
  });

  test("describeError covers busy servers and unknown errors", () => {
    expect(describeError(new PlaybackError("busy", "x", { retryAfter: 3 }))).toBe("The playback server is busy. Try again in 3 seconds.");
    expect(describeError(new Error("boom"))).toBe("Playback failed for an unexpected reason.");
  });
});
