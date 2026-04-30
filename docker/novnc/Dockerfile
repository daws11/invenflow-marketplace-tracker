# syntax=docker/dockerfile:1.7

# Serves the noVNC web client on :6080 and proxies its WebSocket traffic to
# the worker container's x11vnc on :5900. PRD §7.3 calls for an embedded noVNC
# iframe at the same origin as the sidecar UI; Caddy will route /novnc/* and
# /websockify/* here.
FROM python:3.12-slim

ENV NOVNC_VERSION=1.5.0 \
    WEBSOCKIFY_VERSION=0.12.0 \
    NOVNC_HOME=/opt/novnc \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        net-tools \
        procps \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch v${NOVNC_VERSION} \
        https://github.com/novnc/noVNC ${NOVNC_HOME} \
    # Install websockify as a proper Python package so we can invoke it via
    # `websockify` CLI (the cloned `utils/websockify/run` is a bash launcher,
    # not a Python entrypoint — earlier ENTRYPOINT calling `python3 run`
    # crashed with `SyntaxError: invalid syntax` on the bash `cd` line).
    && pip install --no-cache-dir "websockify==${WEBSOCKIFY_VERSION}" \
    # Conventional landing page so /vnc.html works directly without query args.
    && ln -s ${NOVNC_HOME}/vnc.html ${NOVNC_HOME}/index.html

WORKDIR ${NOVNC_HOME}

EXPOSE 6080

# `--web` makes websockify also serve the static noVNC client on the same port,
# so a single container handles both the HTTP and the WebSocket sides. The
# `worker` hostname resolves over the internal Docker network defined in
# docker-compose.yml.
ENTRYPOINT ["websockify", \
            "--web=/opt/novnc", \
            "0.0.0.0:6080", \
            "worker:5900"]
