ARG BUILD_FROM

# ----------------------------------------------------------------------------
# Builder stage: only purpose is to run `npm ci`. npm + its deps are ~50-80MB
# on Alpine and are never needed at runtime, so we isolate them here and
# carry only node_modules forward.
# ----------------------------------------------------------------------------
FROM $BUILD_FROM AS builder

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# ----------------------------------------------------------------------------
# Runtime stage: only the packages the addon actually needs at runtime.
# curl + unzip are kept because managed-mode's cont-init.d C-Gate installer
# uses them; netcat-openbsd is used by the HEALTHCHECK.
# ----------------------------------------------------------------------------
FROM $BUILD_FROM

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN \
    apk add --no-cache \
        nodejs \
        openjdk17-jre-headless \
        curl \
        unzip \
        netcat-openbsd

WORKDIR /app

# node_modules from the builder stage (no npm needed in the runtime image)
COPY --from=builder /app/node_modules ./node_modules

# package.json is read at runtime for the version string (src/constants.js,
# src/cgateWebBridge.js diagnostics, etc.) - keep it but skip the lockfile.
COPY package.json ./

COPY src/ ./src/
COPY public/ ./public/
COPY index.js ./

RUN mkdir -p /data /share/cgate

COPY rootfs /

COPY run.sh /
RUN chmod a+x /run.sh && \
    chmod a+x /etc/cont-init.d/*.sh && \
    chmod a+x /etc/services.d/*/run && \
    chmod a+x /etc/services.d/*/finish

ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

LABEL \
    io.hass.name="C-Gate Web Bridge" \
    io.hass.description="Bridge between Clipsal C-Bus systems and MQTT/Home Assistant" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}" \
    maintainer="Doug Rathbone <doug@dougrathbone.com>" \
    org.opencontainers.image.title="C-Gate Web Bridge" \
    org.opencontainers.image.description="Bridge between Clipsal C-Bus systems and MQTT/Home Assistant" \
    org.opencontainers.image.vendor="Doug Rathbone" \
    org.opencontainers.image.authors="Doug Rathbone <doug@dougrathbone.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/dougrathbone/cgateweb" \
    org.opencontainers.image.source="https://github.com/dougrathbone/cgateweb" \
    org.opencontainers.image.documentation="https://github.com/dougrathbone/cgateweb" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

# Liveness probe: the cgateweb process always serves the C-Bus Labels web UI
# on port 8080, so a successful TCP check means the Node.js bridge has booted.
# start-period is generous because managed-mode first-boot downloads and
# extracts C-Gate (potentially hundreds of MB on slow connections) before the
# bridge even starts.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD nc -z 127.0.0.1 8080 || exit 1

CMD [ "/run.sh" ]
