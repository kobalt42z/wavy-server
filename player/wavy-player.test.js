import { describe, expect, test } from "bun:test";
import { PlaybackError, WavyPlayer, describeError, formatTime } from "./wavy-player.js";
import { handle, isApiPath } from "./serve.js";

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
  const instances = [];
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
function makeApi(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
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

function setup(routes, options = {}) {
  const media = new FakeMedia();
  const { FakeHls, instances } = makeHls();
  const api = makeApi(routes);
  const player = new WavyPlayer(media, { Hls: FakeHls, fetch: api.fetch, stopOnPageHide: false, ...options });
  return { media, player, api, hls: instances };
}

const sessionRoutes = (probe, session) => ({
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
    const err = await player.load("cam.g64x").catch((e) => e);
    expect(err).toBeInstanceOf(PlaybackError);
    expect(err.code).toBe("unsupported");
    expect(describeError(err)).toBe(reason);
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(hls).toHaveLength(0);
    expect(player.state).toBe("error");
  });

  test("an {error, reason} response is surfaced as is", async () => {
    const { player } = setup({
      "GET /api/probe": () => [415, { error: "unsupported", reason: "prproj is an Adobe Premiere project file, not media." }],
    });
    const err = await player.load("a.prproj").catch((e) => e);
    expect(err.code).toBe("unsupported");
    expect(err.status).toBe(415);
    expect(describeError(err)).toBe("prproj is an Adobe Premiere project file, not media.");
  });

  test("a busy server (503 + Retry-After) gives a retry message", async () => {
    const { player } = setup({
      "GET /api/probe": () => [200, PROBE_TRANSCODE],
      "POST /api/sessions": () => [503, { error: "busy", reason: "Too many transcodes." }, { "Retry-After": "15" }],
    });
    const err = await player.load("x.mov").catch((e) => e);
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
    const err = await player.load("x.mp4").catch((e) => e);
    expect(err.code).toBe("network");
    expect(describeError(err)).toBe("Could not reach the playback service.");
  });

  test("a non-JSON error body still gives a readable reason", async () => {
    const { player } = setup({ "GET /api/probe": () => [404, undefined] });
    const err = await player.load("missing.mp4").catch((e) => e);
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
    expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/sessions/s1")).toBe(true);
    expect(hls[0].destroyed).toBe(true);
    expect(player.sessionId).toBe("s2");
  });

  test("a session that fails to attach is deleted", async () => {
    const media = new FakeMedia();
    const api = makeApi(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
    );
    const player = new WavyPlayer(media, { fetch: api.fetch, stopOnPageHide: false }); // no Hls
    const err = await player.load("x.mov").catch((e) => e);
    expect(err.code).toBe("no-hls");
    expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/sessions/s1")).toBe(true);
    expect(player.sessionId).toBeNull();
  });
});

describe("WavyPlayer.seek", () => {
  async function playing() {
    const ctx = setup({
      ...sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
      "POST /api/sessions/s1/seek": (body) => [
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
    expect(api.calls.some((c) => c.path.endsWith("/seek"))).toBe(false);
    expect(hls).toHaveLength(1);
    expect(player.availableEnd).toBe(40);
  });

  test("past the transcoded part it restarts FFmpeg and reloads the playlist", async () => {
    const { player, media, api, hls } = await playing();
    await player.seek(200);
    const call = api.calls.find((c) => c.path === "/api/sessions/s1/seek");
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
    expect(api.calls.filter((c) => c.path.endsWith("/seek"))).toHaveLength(2);
    expect(player.offset).toBe(10);
  });

  test("seeks are clamped to the file", async () => {
    const { player, api } = await playing();
    await player.seek(10_000);
    expect(api.calls.find((c) => c.path.endsWith("/seek")).body.position).toBe(299.5);
  });

  test("direct mode seeks the media element", async () => {
    const { player, media, api } = setup(
      sessionRoutes({ mode: "direct", duration: 60 }, { sessionId: "s1", mode: "direct", url: "/api/files/x.mp4" }),
    );
    await player.load("x.mp4");
    await player.seek(45);
    expect(media.currentTime).toBe(45);
    expect(api.calls.some((c) => c.path.endsWith("/seek"))).toBe(false);
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
    const beacons = [];
    const original = navigator.sendBeacon;
    navigator.sendBeacon = (url) => {
      beacons.push(url);
      return true;
    };
    try {
      player._stopOnUnload();
    } finally {
      navigator.sendBeacon = original;
    }
    expect(beacons).toEqual(["https://media.example.com/api/sessions/s1/stop"]);
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(player.sessionId).toBeNull();
  });

  test("a fatal media error is recovered once, then reported", async () => {
    const { player, hls } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
    );
    const errors = [];
    player.addEventListener("error", (e) => errors.push(e.detail));
    await player.load("x.mov");
    hls[0].emit("hlsError", { fatal: true, type: "mediaError" });
    expect(hls[0].recovered).toBe(1);
    expect(errors).toHaveLength(0);
    hls[0].emit("hlsError", { fatal: true, type: "mediaError" });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("stream");
    expect(player.state).toBe("error");
  });

  test("a fatal network error is reported with the HTTP status", async () => {
    const { player, hls } = setup(
      sessionRoutes(PROBE_TRANSCODE, { sessionId: "s1", mode: "transcode", url: "/api/sessions/s1/index.m3u8" }),
    );
    const errors = [];
    player.addEventListener("error", (e) => errors.push(e.detail));
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

describe("dev server", () => {
  test("serves only the player files", async () => {
    const page = await handle(new Request("http://localhost/"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Wavy test player");
    expect((await handle(new Request("http://localhost/wavy-player.js"))).status).toBe(200);
    expect((await handle(new Request("http://localhost/serve.js"))).status).toBe(404);
    expect((await handle(new Request("http://localhost/../package.json"))).status).toBe(404);
  });

  test("forwards API calls to the service", async () => {
    expect(isApiPath("/api/probe")).toBe(true);
    expect(isApiPath("/healthz")).toBe(true);
    expect(isApiPath("/app.js")).toBe(false);

    const upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        return Response.json({ method: req.method, path: u.pathname + u.search, body: await req.text() });
      },
    });
    try {
      const api = `http://localhost:${upstream.port}`;
      const res = await handle(
        new Request("http://localhost/api/sessions?x=1", { method: "POST", body: '{"path":"a.mov"}' }),
        api,
      );
      expect(await res.json()).toEqual({ method: "POST", path: "/api/sessions?x=1", body: '{"path":"a.mov"}' });
    } finally {
      upstream.stop(true);
    }

    const down = await handle(new Request("http://localhost/api/probe?path=x"), "http://127.0.0.1:9");
    expect(down.status).toBe(502);
    expect((await down.json()).error).toBe("proxy");
  });
});
