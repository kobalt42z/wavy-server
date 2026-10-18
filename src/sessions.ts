import type { Subprocess } from "bun";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Decision, PlaybackMode } from "./decide.ts";
import { buildHlsArgs, parseProgressSpeed, PLAYLIST_NAME } from "./hls.ts";
import { ApiError } from "./http/errors.ts";
import { log } from "./log.ts";
import type { Metrics } from "./metrics.ts";
import type { ProbeResult } from "./probe.ts";

export type EncoderState = "none" | "running" | "done" | "failed";
export type EndCause = "deleted" | "idle" | "expired" | "shutdown";

export interface Session {
  id: string;
  /** User who created the session (null while auth is off). */
  ownerId: string | null;
  relPath: string;
  absPath: string;
  extension: string;
  mode: Exclude<PlaybackMode, "unsupported">;
  decision: Decision;
  probe: ProbeResult;
  /** Temp folder for HLS output; empty for direct sessions. */
  dir: string;
  /** Media time (seconds) the current encode started at. */
  start: number;
  /** Bumped on each FFmpeg (re)start; prefixes segment names. */
  generation: number;
  createdAt: number;
  lastAccess: number;
  encoder: EncoderState;
  /** Last FFmpeg error lines, when the encoder failed. */
  error?: string;
  proc?: Subprocess<"ignore", "pipe", "pipe">;
}

export interface CreateSessionInput {
  ownerId: string | null;
  relPath: string;
  absPath: string;
  extension: string;
  decision: Decision;
  probe: ProbeResult;
  start: number;
}

const isHls = (s: { mode: PlaybackMode }) => s.mode !== "direct" && s.mode !== "unsupported";

/**
 * Owns playback sessions: one temp folder and one FFmpeg process per HLS session,
 * the per-pod caps, idle cleanup and restart-on-seek.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private reaper?: ReturnType<typeof setInterval>;

  constructor(
    private readonly cfg: Config,
    private readonly metrics: Metrics,
    private readonly now: () => number = Date.now,
  ) {
    metrics.transcodeCapacity.set(cfg.maxTranscodes);
    this.refreshGauges();
  }

  /** Clears segments left by a previous run and starts the idle reaper. */
  async init(): Promise<void> {
    await mkdir(this.cfg.sessionsDir, { recursive: true });
    for (const entry of await readdir(this.cfg.sessionsDir)) {
      await rm(join(this.cfg.sessionsDir, entry), { recursive: true, force: true });
    }
    this.reaper = setInterval(() => void this.reap(), this.cfg.reapIntervalMs);
    this.reaper.unref?.();
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  activeTranscodes(): number {
    return this.list().filter((s) => s.mode === "transcode").length;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const mode = input.decision.mode;
    if (mode === "unsupported") throw new Error("create() called for an unsupported file");

    // Capacity checks and the map insert happen synchronously, so concurrent
    // requests can't both take the last slot.
    if (mode !== "direct") {
      const hlsCount = this.list().filter(isHls).length;
      if (hlsCount >= this.cfg.maxSessions) {
        throw this.capacityError("This server is at its session limit. Try again shortly.", input.extension);
      }
      if (mode === "transcode" && this.activeTranscodes() >= this.cfg.maxTranscodes) {
        throw this.capacityError("This server is at its transcoding limit. Try again shortly.", input.extension);
      }
    }

    const id = randomBytes(18).toString("base64url");
    const t = this.now();
    const session: Session = {
      id,
      ownerId: input.ownerId,
      relPath: input.relPath,
      absPath: input.absPath,
      extension: input.extension,
      mode,
      decision: input.decision,
      probe: input.probe,
      dir: mode === "direct" ? "" : join(this.cfg.sessionsDir, id),
      start: clampStart(input.start, input.probe.duration),
      generation: 0,
      createdAt: t,
      lastAccess: t,
      encoder: "none",
    };
    this.sessions.set(id, session);
    this.metrics.sessionsStarted.inc({ mode, extension: input.extension });
    this.refreshGauges();

    if (mode !== "direct") {
      try {
        await mkdir(session.dir, { recursive: true });
        this.startEncoder(session);
      } catch (err) {
        await this.stop(session, "deleted");
        throw err;
      }
    }
    log("info", "session_started", {
      sessionId: id,
      user: input.ownerId,
      path: input.relPath,
      mode,
      start: session.start,
    });
    return session;
  }

  touch(session: Session): void {
    session.lastAccess = this.now();
  }

  /** Restarts FFmpeg at `position` seconds. Old segments are deleted first. */
  async seek(session: Session, position: number): Promise<void> {
    this.touch(session);
    if (session.mode === "direct") return;
    await this.killEncoder(session);
    await clearDir(session.dir);
    if (!this.sessions.has(session.id)) return; // stopped while we waited
    session.start = clampStart(position, session.probe.duration);
    session.error = undefined;
    this.startEncoder(session);
    log("info", "session_seek", { sessionId: session.id, path: session.relPath, start: session.start });
  }

  async stop(session: Session, cause: EndCause): Promise<void> {
    if (!this.sessions.delete(session.id)) return;
    this.refreshGauges();
    this.metrics.sessionsEnded.inc({ cause });
    await this.killEncoder(session);
    if (session.dir) await rm(session.dir, { recursive: true, force: true });
    log("info", "session_ended", {
      sessionId: session.id,
      user: session.ownerId,
      path: session.relPath,
      mode: session.mode,
      cause,
      openSeconds: Math.round((this.now() - session.createdAt) / 1000),
    });
  }

  /** Stops sessions nobody has requested a segment from lately, or that ran too long. */
  async reap(): Promise<void> {
    const t = this.now();
    for (const s of this.list()) {
      if (t - s.createdAt > this.cfg.maxSessionAgeMs) await this.stop(s, "expired");
      else if (t - s.lastAccess > this.cfg.idleTimeoutMs) await this.stop(s, "idle");
    }
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all(this.list().map((s) => this.stop(s, "shutdown")));
  }

  /**
   * Waits until the current encode has written a playlist with at least one segment.
   * Fails fast if FFmpeg exits with an error.
   */
  async waitForPlaylist(session: Session, timeoutMs = this.cfg.playlistWaitMs): Promise<string> {
    const deadline = this.now() + timeoutMs;
    const playlistPath = join(session.dir, PLAYLIST_NAME);
    for (;;) {
      if (!this.sessions.has(session.id)) throw new ApiError(404, "not_found", "The session has ended.");
      const text = await readFile(playlistPath, "utf8").catch(() => null);
      // Segment names carry the generation, so a playlist left by an encode that a
      // seek replaced is never returned.
      if (text?.includes("#EXTINF") && text.includes(`g${session.generation}_`)) return text;
      if (session.encoder === "failed") {
        throw new ApiError(502, "ffmpeg_failed", `FFmpeg could not convert this file: ${session.error ?? "unknown error"}`);
      }
      if (session.encoder === "done" && !text) {
        throw new ApiError(502, "ffmpeg_failed", "FFmpeg finished without producing any output.");
      }
      if (this.now() >= deadline) {
        throw new ApiError(503, "not_ready", "The stream is not ready yet. Try again.", { "Retry-After": "1" });
      }
      await Bun.sleep(100);
    }
  }

  private startEncoder(session: Session): void {
    session.generation += 1;
    const args = buildHlsArgs(session.decision, session.probe, {
      input: session.absPath,
      outDir: session.dir,
      start: session.start,
      prefix: `g${session.generation}`,
      hlsTime: this.cfg.hlsTime,
      segmentType: this.cfg.segmentType,
      x264Preset: this.cfg.x264Preset,
      x264Crf: this.cfg.x264Crf,
      audioBitrate: this.cfg.audioBitrate,
    });
    const proc = Bun.spawn([this.cfg.ffmpegPath, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    session.proc = proc;
    session.encoder = "running";

    void this.watchProgress(session, proc);
    const stderr = new Response(proc.stderr).text();
    void proc.exited.then(async (code) => {
      const errText = await stderr.catch(() => "");
      if (session.proc !== proc) return; // replaced by a seek or stopped
      session.proc = undefined;
      if (code === 0) {
        session.encoder = "done";
        return;
      }
      if (proc.signalCode) return; // killed by us
      session.encoder = "failed";
      session.error = errText.trim().split("\n").slice(-3).join(" | ") || `ffmpeg exited with code ${code}`;
      this.metrics.ffmpegFailures.inc({ mode: session.mode, extension: session.extension });
      log("error", "ffmpeg_failed", {
        sessionId: session.id,
        path: session.relPath,
        mode: session.mode,
        start: session.start,
        exitCode: code,
        error: session.error,
        probe: session.probe,
      });
    });
  }

  private async watchProgress(session: Session, proc: Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const speed = parseProgressSpeed(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (speed !== undefined) this.metrics.transcodeSpeed.observe({ mode: session.mode }, speed);
        }
      }
    } catch {
      // The process was killed; nothing to report.
    }
  }

  private async killEncoder(session: Session): Promise<void> {
    const proc = session.proc;
    session.proc = undefined;
    if (!proc) return;
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await proc.exited;
  }

  private capacityError(reason: string, extension: string): ApiError {
    this.metrics.sessionsRejected.inc({ reason: "capacity", extension });
    return new ApiError(503, "capacity", reason, { "Retry-After": String(this.cfg.retryAfterSec) });
  }

  private refreshGauges(): void {
    const counts: Record<string, number> = { direct: 0, remux: 0, "transcode-audio": 0, transcode: 0 };
    for (const s of this.sessions.values()) counts[s.mode] = (counts[s.mode] ?? 0) + 1;
    for (const [mode, n] of Object.entries(counts)) this.metrics.activeSessions.set({ mode }, n);
    this.metrics.activeTranscodes.set(counts.transcode ?? 0);
  }
}

/** Keeps a seek inside the file, leaving room for at least one segment. */
function clampStart(start: number, duration?: number): number {
  if (!Number.isFinite(start) || start <= 0) return 0;
  if (duration && duration > 0) return Math.min(start, Math.max(0, duration - 1));
  return start;
}

async function clearDir(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(entries.map((e) => rm(join(dir, e), { recursive: true, force: true })));
}
