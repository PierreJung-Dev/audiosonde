# syntax=docker/dockerfile:1

# =============================================================================
# audiosonde runtime image (Debian bookworm slim).
# Ships pinned audio binaries: ffmpeg/ffprobe (Debian) + audiowaveform (BBC).
# NOTE: exact ffmpeg version pinning (e.g. a pinned static build) is a M6
# hardening item; M0 uses the distro package.
# =============================================================================

# ---- build stage: dev deps + TypeScript compile ---------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- production deps stage (clean, no dev deps) ---------------------------
FROM node:22-bookworm-slim AS proddeps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# ---- runtime stage --------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# audiowaveform 1.10.2, Debian 12 (bookworm) amd64 build. Verified asset name.
ARG AUDIOWAVEFORM_VERSION=1.10.2
ARG AUDIOWAVEFORM_DEB=audiowaveform_${AUDIOWAVEFORM_VERSION}-1-12_amd64.deb
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates wget; \
    wget -q "https://github.com/bbc/audiowaveform/releases/download/${AUDIOWAVEFORM_VERSION}/${AUDIOWAVEFORM_DEB}" -O /tmp/audiowaveform.deb; \
    apt-get install -y --no-install-recommends /tmp/audiowaveform.deb; \
    apt-get purge -y --auto-remove wget; \
    rm -rf /tmp/audiowaveform.deb /var/lib/apt/lists/*; \
    ffmpeg -version | head -n1; \
    ffprobe -version | head -n1; \
    audiowaveform --version

COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
