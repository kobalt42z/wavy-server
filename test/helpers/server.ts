import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import { createMetrics } from "../../src/metrics.ts";
import { loadRules } from "../../src/rules.ts";
import { SessionManager } from "../../src/sessions.ts";
import { generateSamples } from "../../scripts/samples.ts";

process.env.LOG_LEVEL ??= "silent";

let samples: Promise<string> | undefined;

/** Generates the sample set once per test process (2-second files). */
export function samplesDir(): Promise<string> {
  samples ??= (async () => {
    const dir = process.env.SAMPLES_DIR ?? mkdtempSync(join(tmpdir(), "wavy-api-samples-"));
    const res = await generateSamples(dir, { duration: 2 });
    if (res.failed.length) throw new Error(`sample generation failed: ${JSON.stringify(res.failed)}`);
    return dir;
  })();
  return samples;
}

export interface TestServer {
  base: string;
  config: Config;
  sessions: SessionManager;
  metrics: ReturnType<typeof createMetrics>;
  close: () => Promise<void>;
}

/** Starts the real app on a random port, with its own sessions folder. */
export async function startServer(mediaRoot: string, overrides: Partial<Config> = {}): Promise<TestServer> {
  const sessionsDir = mkdtempSync(join(tmpdir(), "wavy-sessions-"));
  const config: Config = { ...loadConfig({}), mediaRoot, sessionsDir, port: 0, ...overrides };
  const metrics = createMetrics();
  const sessions = new SessionManager(config, metrics);
  await sessions.init();
  const app = createApp({ config, rules: loadRules(), metrics, sessions });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
  return {
    base: `http://127.0.0.1:${server.port}`,
    config,
    sessions,
    metrics,
    close: async () => {
      await server.stop(true);
      await sessions.shutdown();
      rmSync(sessionsDir, { recursive: true, force: true });
    },
  };
}

export async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** Codecs of the first video and audio stream, as ffprobe sees them (works on HLS URLs). */
export async function probeStreams(url: string): Promise<{ codec_type: string; codec_name: string; pix_fmt?: string; profile?: string }[]> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,profile", "-of", "json", url],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`ffprobe ${url} failed: ${err}`);
  return (JSON.parse(out) as { streams: { codec_type: string; codec_name: string }[] }).streams;
}

export async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
