import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { join } from "node:path";
import { authenticate, canUseSession, canViewPath, type AppEnv } from "./auth.ts";
import type { Config } from "./config.ts";
import { serveFile } from "./files.ts";
import { PLAYLIST_NAME, SEGMENT_NAME, segmentContentType } from "./hls.ts";
import { ApiError, badRequest, notFound } from "./http/errors.ts";
import { log } from "./log.ts";
import { encodeMediaPath, resolveMediaPath, type MediaFile } from "./media-path.ts";
import type { Metrics } from "./metrics.ts";
import { PlaybackAnalyzer, unsupportedError } from "./playback.ts";
import type { PlaybackRules } from "./rules.ts";
import type { Session, SessionManager } from "./sessions.ts";

export interface AppDeps {
  config: Config;
  rules: PlaybackRules;
  metrics: Metrics;
  sessions: SessionManager;
}

const FILES_PREFIX = "/api/files/";

export function createApp({ config, rules, metrics, sessions }: AppDeps) {
  const analyzer = new PlaybackAnalyzer(rules, metrics, config.ffprobePath);
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
      return c.json({ error: err.code, reason: err.reason }, err.status);
    }
    log("error", "request_failed", { method: c.req.method, path: c.req.path, error: String(err) });
    return c.json({ error: "internal", reason: "Something went wrong on the server." }, 500);
  });
  app.notFound((c) => c.json({ error: "not_found", reason: "No such endpoint." }, 404));

  app.get("/healthz", (c) => c.json({ status: "ok", sessions: sessions.list().length }));
  app.get("/metrics", async (c) => {
    c.header("Content-Type", metrics.registry.contentType);
    return c.body(await metrics.registry.metrics());
  });

  app.use(
    "/api/*",
    cors({
      origin: config.corsOrigins.includes("*") ? "*" : config.corsOrigins,
      allowMethods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Range", "Authorization"],
      exposeHeaders: ["Content-Range", "Content-Length", "Accept-Ranges", "Retry-After"],
      maxAge: 600,
    }),
  );
  // Auth hook: see src/auth.ts. Open for now.
  app.use("/api/*", authenticate);

  /** Resolves a client path and checks the viewer may see it. */
  const openFile = async (c: Context<AppEnv>, path: string | undefined): Promise<MediaFile> => {
    const file = await resolveMediaPath(config.mediaRoot, path);
    if (!canViewPath(c.get("user"), file.relPath)) throw new ApiError(403, "forbidden", "You may not view this file.");
    return file;
  };

  const sessionFor = (c: Context<AppEnv>): Session => {
    const s = sessions.get(c.req.param("id") ?? "");
    // Someone else's session looks the same as a missing one.
    if (!s || !canUseSession(c.get("user"), s.ownerId)) throw notFound("The session does not exist or has ended.");
    return s;
  };

  const playlistUrl = (s: Session) => `/api/sessions/${s.id}/${PLAYLIST_NAME}?v=${s.generation}`;
  const fileUrl = (relPath: string) => `${FILES_PREFIX}${encodeMediaPath(relPath)}`;
  const sessionUrl = (s: Session) => (s.mode === "direct" ? fileUrl(s.relPath) : playlistUrl(s));

  app.get("/api/probe", async (c) => {
    const file = await openFile(c, c.req.query("path"));
    const analysis = await analyzer.analyze(file);
    return c.json(analyzer.toResponse(file, analysis));
  });

  app.post("/api/sessions", async (c) => {
    const body = await readJson(c);
    const start = optionalNumber(body.start, "start", 0);
    const audioTrack = optionalNumber(body.audioTrack, "audioTrack", 0);
    if (audioTrack !== undefined && !Number.isInteger(audioTrack)) throw badRequest("audioTrack must be an integer.");
    const file = await openFile(c, typeof body.path === "string" ? body.path : undefined);

    const analysis = await analyzer.analyze(file);
    if (analysis.decision.mode === "unsupported" || !analysis.probe) {
      metrics.sessionsRejected.inc({ reason: "unsupported", extension: analyzer.label(analysis.extension) });
      throw unsupportedError(analysis.decision.reason);
    }
    const { decision, probe } = analyzer.decideForSession(analysis, audioTrack);
    if (decision.mode === "unsupported" || !probe) throw unsupportedError(decision.reason);

    const user = c.get("user");
    const session = await sessions.create({
      ownerId: user?.id ?? null,
      relPath: file.relPath,
      absPath: file.absPath,
      extension: analyzer.label(analysis.extension),
      decision,
      probe,
      start: start ?? 0,
    });
    return c.json(
      {
        sessionId: session.id,
        mode: session.mode,
        url: sessionUrl(session),
        start: session.start,
        duration: probe.duration ?? null,
        reason: decision.reason,
      },
      201,
    );
  });

  app.get("/api/sessions/:id", (c) => {
    const s = sessionFor(c);
    return c.json({
      sessionId: s.id,
      mode: s.mode,
      url: sessionUrl(s),
      path: s.relPath,
      start: s.start,
      duration: s.probe.duration ?? null,
      encoder: s.encoder,
      error: s.error ?? null,
    });
  });

  app.get(`/api/sessions/:id/${PLAYLIST_NAME}`, async (c) => {
    const s = sessionFor(c);
    if (s.mode === "direct") throw notFound("Direct sessions have no playlist; use the file URL.");
    sessions.touch(s);
    const text = await sessions.waitForPlaylist(s);
    sessions.touch(s);
    return c.body(text, 200, {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
    });
  });

  app.get("/api/sessions/:id/:segment", async (c) => {
    const s = sessionFor(c);
    const name = c.req.param("segment");
    if (!SEGMENT_NAME.test(name) || s.mode === "direct") throw notFound("No such segment.");
    sessions.touch(s);
    const f = Bun.file(join(s.dir, name));
    if (!(await f.exists())) throw notFound("The segment is not ready or no longer exists.");
    return new Response(f, {
      headers: { "Content-Type": segmentContentType(name), "Cache-Control": "private, max-age=3600" },
    });
  });

  app.post("/api/sessions/:id/seek", async (c) => {
    const s = sessionFor(c);
    const body = await readJson(c);
    const position = optionalNumber(body.position, "position", 0);
    if (position === undefined) throw badRequest("position (seconds) is required.");
    await sessions.seek(s, position);
    return c.json({ url: sessionUrl(s), start: s.mode === "direct" ? position : s.start });
  });

  const stop = async (c: Context<AppEnv>) => {
    const s = sessions.get(c.req.param("id") ?? "");
    if (s && canUseSession(c.get("user"), s.ownerId)) await sessions.stop(s, "deleted");
    // Idempotent: stopping an ended session is not an error.
    return c.body(null, 204);
  };
  app.delete("/api/sessions/:id", stop);
  // navigator.sendBeacon can only POST, so the player's unload handler uses this.
  app.post("/api/sessions/:id/stop", stop);

  const filesHandler = async (c: Context<AppEnv>) => {
    const raw = new URL(c.req.url).pathname.slice(FILES_PREFIX.length);
    let rel: string;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      throw badRequest("The file path is not valid URL encoding.");
    }
    const file = await openFile(c, rel);
    const analysis = await analyzer.analyze(file);
    // Only files the browser can play as-is are served raw.
    if (analysis.decision.mode !== "direct") {
      throw new ApiError(
        409,
        "not_direct",
        analysis.decision.mode === "unsupported"
          ? analysis.decision.reason
          : `This file needs ${analysis.decision.mode}; start a session with POST /api/sessions.`,
      );
    }
    return serveFile(file, c.req.raw);
  };
  app.on(["GET", "HEAD"], `${FILES_PREFIX}*`, filesHandler);

  return app;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("The request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw badRequest("The request body must be a JSON object.");
  return body as Record<string, unknown>;
}

function optionalNumber(v: unknown, field: string, min: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw badRequest(`${field} must be a number >= ${min}.`);
  return v;
}
