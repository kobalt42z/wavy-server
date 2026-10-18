import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics served at /metrics. Autoscaling should use
 * `wavy_active_transcodes` (full transcodes in progress), not CPU.
 */
export function createMetrics() {
  const registry = new Registry();
  try {
    collectDefaultMetrics({ register: registry, prefix: "wavy_" });
  } catch {
    // Some default collectors depend on Node internals; the service metrics below still work.
  }

  return {
    registry,
    activeSessions: new Gauge({
      name: "wavy_active_sessions",
      help: "Playback sessions currently open, by mode.",
      labelNames: ["mode"] as const,
      registers: [registry],
    }),
    activeTranscodes: new Gauge({
      name: "wavy_active_transcodes",
      help: "Full video transcodes currently open on this pod (the autoscaling signal).",
      registers: [registry],
    }),
    transcodeCapacity: new Gauge({
      name: "wavy_transcode_capacity",
      help: "Maximum concurrent full transcodes on this pod (MAX_TRANSCODES).",
      registers: [registry],
    }),
    sessionsStarted: new Counter({
      name: "wavy_sessions_started_total",
      help: "Playback sessions started, by mode and file extension.",
      labelNames: ["mode", "extension"] as const,
      registers: [registry],
    }),
    sessionsRejected: new Counter({
      name: "wavy_sessions_rejected_total",
      help: "Session requests refused, by reason (unsupported, capacity).",
      labelNames: ["reason", "extension"] as const,
      registers: [registry],
    }),
    ffmpegFailures: new Counter({
      name: "wavy_ffmpeg_failures_total",
      help: "FFmpeg processes that exited with an error, by mode and file extension.",
      labelNames: ["mode", "extension"] as const,
      registers: [registry],
    }),
    sessionsEnded: new Counter({
      name: "wavy_sessions_ended_total",
      help: "Sessions stopped, by cause (deleted, idle, expired, shutdown).",
      labelNames: ["cause"] as const,
      registers: [registry],
    }),
    transcodeSpeed: new Histogram({
      name: "wavy_ffmpeg_speed",
      help: "FFmpeg speed (x real time) reported while encoding, by mode. Below 1 means the viewer will stall.",
      labelNames: ["mode"] as const,
      buckets: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5, 10, 25, 50],
      registers: [registry],
    }),
    probeDuration: new Histogram({
      name: "wavy_probe_duration_seconds",
      help: "Time spent running ffprobe.",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [registry],
    }),
    probeResults: new Counter({
      name: "wavy_probe_results_total",
      help: "Files probed, by chosen mode and file extension.",
      labelNames: ["mode", "extension"] as const,
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
