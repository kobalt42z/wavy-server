# Playback service: Bun + Hono API that drives FFmpeg.
#
# The runtime image is distroless base-nossl (glibc only: no shell, no package
# manager, no OpenSSL) holding four things: the Bun binary, a static
# FFmpeg/ffprobe, a static tini and the app. Nothing is installed with apt, so there are no distro FFmpeg
# libraries (X11, SDL, codecs we never use...) for a CVE scanner to flag.
#
# Base images are pinned by digest; Dependabot (.github/dependabot.yml) bumps them.

ARG TINI_VERSION=v0.19.0

# Install production dependencies with the Debian Bun image; only the bun binary and
# node_modules are kept (Bun needs nothing but glibc).
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
 && mkdir -p /rootfs/tmp/sessions /rootfs/media

# Statically linked FFmpeg/ffprobe (libx264 + native AAC, HLS muxer), multi-arch.
FROM mwader/static-ffmpeg:8.0@sha256:415a41fa3167b890b9703d20bd0f00bf1e9dab8a4b6c27fef1445b2bf5f1ab4a AS ffmpeg

# Static tini, checksum-verified per architecture.
FROM scratch AS tini-amd64
ARG TINI_VERSION
ADD --chmod=755 --checksum=sha256:c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee \
    https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-static-amd64 /tini
FROM scratch AS tini-arm64
ARG TINI_VERSION
ADD --chmod=755 --checksum=sha256:eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9 \
    https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-static-arm64 /tini
FROM tini-${TARGETARCH} AS tini

FROM gcr.io/distroless/base-nossl-debian13:latest@sha256:d710a5c8bfe4cf7e726d7e1afd73e363a9fb02c2a11ad893d2d6185c1b9a89cb

# tini as PID 1 so signals reach Bun and FFmpeg children are always reaped.
COPY --from=tini /tini /usr/bin/tini

COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY config ./config

ENV NODE_ENV=production \
    PORT=8080 \
    MEDIA_ROOT=/media \
    SESSIONS_DIR=/tmp/sessions \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Non-root (uid 1000). /media is mounted read-only; the root filesystem can be
# read-only too as long as /tmp is writable.
COPY --from=deps --chown=1000:1000 /rootfs/tmp/sessions /tmp/sessions
COPY --from=deps /rootfs/media /media
USER 1000:1000

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 8080) + '/healthz'); process.exit(r.ok ? 0 : 1)"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/server.ts"]
