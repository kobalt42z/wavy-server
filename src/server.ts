#!/usr/bin/env bun
/** Entry point: `bun src/server.ts`. Settings come from environment variables (see README). */
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { createMetrics } from "./metrics.ts";
import { loadRules } from "./rules.ts";
import { SessionManager } from "./sessions.ts";

const config = loadConfig();
const rules = loadRules(config.rulesPath);
const metrics = createMetrics();
const sessions = new SessionManager(config, metrics);
await sessions.init();

const app = createApp({ config, rules, metrics, sessions });
const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  // Playlist requests may wait for FFmpeg's first segment.
  idleTimeout: Math.min(255, Math.ceil(config.playlistWaitMs / 1000) + 15),
});

log("info", "server_started", {
  port: server.port,
  mediaRoot: config.mediaRoot,
  sessionsDir: config.sessionsDir,
  maxTranscodes: config.maxTranscodes,
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "server_stopping", { signal });
  await server.stop();
  await sessions.shutdown();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
