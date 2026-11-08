// Dev server for the test player: serves this folder and forwards /api and
// /healthz to the playback service, so the page and the API share an origin
// (no CORS needed).
//
//   bun player/serve.js
//   WAVY_API_URL=http://localhost:8080 PORT=5173 bun player/serve.js
import { dirname, isAbsolute, join } from "node:path";

const API = (process.env.WAVY_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 5173);
const ROOT = import.meta.dir;

// hls.js is served from node_modules (`bun install`), not a CDN, so the page works
// offline. HLS_JS_PATH points at another copy of hls.mjs if node_modules isn't there.
function findHlsJs() {
  if (process.env.HLS_JS_PATH) return process.env.HLS_JS_PATH;
  try {
    return join(dirname(Bun.resolveSync("hls.js/package.json", ROOT)), "dist", "hls.mjs");
  } catch {
    return join(ROOT, "hls.mjs");
  }
}
const HLS_JS = findHlsJs();

// Only these files are served, so no path can escape the folder.
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/wavy-player.js": ["wavy-player.js", "text/javascript; charset=utf-8"],
  "/hls.mjs": [HLS_JS, "text/javascript; charset=utf-8"],
};

export function isApiPath(pathname) {
  return pathname.startsWith("/api/") || pathname === "/healthz" || pathname === "/metrics";
}

export async function handle(req, api = API) {
  const url = new URL(req.url);

  if (isApiPath(url.pathname)) {
    const headers = new Headers(req.headers);
    headers.delete("host");
    try {
      return await fetch(api + url.pathname + url.search, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual",
        decompress: false,
      });
    } catch {
      return Response.json(
        { error: "proxy", reason: `The playback service at ${api} is not reachable.` },
        { status: 502 },
      );
    }
  }

  const entry = STATIC[url.pathname];
  if (!entry) return new Response("Not found", { status: 404 });
  const file = Bun.file(isAbsolute(entry[0]) ? entry[0] : join(ROOT, entry[0]));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: { "content-type": entry[1], "cache-control": "no-store" },
  });
}

if (import.meta.main) {
  const server = Bun.serve({ port: PORT, fetch: (req) => handle(req) });
  console.log(`Test player: http://localhost:${server.port}/  (API: ${API})`);
}
