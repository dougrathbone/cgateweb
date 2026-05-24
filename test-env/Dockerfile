ARG BUILD_FROM

# ----------------------------------------------------------------------------
# Builder stage: install npm + run `npm ci` only. Mirrors the production
# Dockerfile's multi-stage layout so the integration test exercises the same
# image structure that ships to users.
# ----------------------------------------------------------------------------
FROM $BUILD_FROM AS builder

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs npm

WORKDIR /app
# package.json and source are in the repo root (build context)
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# ----------------------------------------------------------------------------
# Runtime stage
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

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY index.js ./

RUN mkdir -p /data /share/cgate

# addon-specific files are under homeassistant-addon/ relative to repo root
COPY homeassistant-addon/rootfs /
COPY homeassistant-addon/run.sh /
RUN chmod a+x /run.sh && \
    chmod a+x /etc/cont-init.d/*.sh && \
    chmod a+x /etc/services.d/*/run && \
    chmod a+x /etc/services.d/*/finish

ARG BUILD_ARCH=amd64
ARG BUILD_DATE=dev
ARG BUILD_REF=local
ARG BUILD_VERSION=dev

LABEL \
    io.hass.name="C-Gate Web Bridge (test)" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"

CMD [ "/run.sh" ]
