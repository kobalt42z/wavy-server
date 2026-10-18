# Playback service: Bun + Hono API that drives distro FFmpeg.
FROM oven/bun:1.4.2-slim

# FFmpeg for probing/remuxing/transcoding; tini as PID 1 so signals reach Bun and
# FFmpeg children are always reaped.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY config ./config

ENV NODE_ENV=production \
    PORT=8080 \
    MEDIA_ROOT=/media \
    SESSIONS_DIR=/tmp/sessions \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Non-root (the image's "bun" user, uid 1000). /media is mounted read-only; the root
# filesystem can be read-only too as long as /tmp is writable.
RUN mkdir -p /tmp/sessions /media && chown 1000:1000 /tmp/sessions
USER 1000:1000

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 8080) + '/healthz'); process.exit(r.ok ? 0 : 1)"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/server.ts"]
