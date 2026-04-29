# syntax=docker/dockerfile:1.7

# Playwright's official image ships Chromium plus all required system libs and
# pins versions so they always match the bundled browser. We just layer the X
# stack (Xvfb / x11vnc / fluxbox) on top so the worker can drive a *headed*
# Chromium that x11vnc can mirror — see PRD §7.3.
FROM mcr.microsoft.com/playwright:v1.48.0-noble

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Headed Chromium dependencies + remote display stack. `xdpyinfo` is used by
# start.sh to wait for Xvfb to come up.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        fluxbox \
        x11-utils \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Activate pnpm via corepack so the workspace install resolves the same way the
# host does.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /repo

# Bring in the workspace manifests first so the dep install layer caches well.
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile=false

# Copy the rest of the workspace and build the worker.
COPY . .
RUN pnpm --filter @invenflow-tracker/worker build

# Run the worker out of its own directory so relative paths in start.sh
# (./start.sh, dist/index.js) resolve correctly.
WORKDIR /repo/apps/worker

# Browser profiles + screenshots persist on the host bind-mount.
RUN mkdir -p /data/profiles /tmp/screenshots \
    && chmod 0700 /data/profiles

ENV DISPLAY=:99
EXPOSE 5900

ENTRYPOINT ["./start.sh"]
