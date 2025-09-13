ARG BUILD_FROM
FROM $BUILD_FROM

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install Node.js and npm
RUN \
    apk add --no-cache \
        nodejs \
        npm \
    && npm install -g npm@latest

# Set work directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application source
COPY src/ ./src/
COPY index.js ./
COPY *.md ./

# Create data directory for addon configuration
RUN mkdir -p /data

# Copy run script
COPY homeassistant-addon/run.sh /
RUN chmod a+x /run.sh

# Labels
LABEL \
    io.hass.name="C-Gate Web Bridge" \
    io.hass.description="Bridge between Clipsal C-Bus systems and MQTT/Home Assistant" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}" \
    maintainer="Doug Rathbone <doug@rathbone.id.au>" \
    org.opencontainers.image.title="C-Gate Web Bridge" \
    org.opencontainers.image.description="Bridge between Clipsal C-Bus systems and MQTT/Home Assistant" \
    org.opencontainers.image.vendor="Doug Rathbone" \
    org.opencontainers.image.authors="Doug Rathbone <doug@rathbone.id.au>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/dougrathbone/cgateweb" \
    org.opencontainers.image.source="https://github.com/dougrathbone/cgateweb" \
    org.opencontainers.image.documentation="https://github.com/dougrathbone/cgateweb" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

CMD [ "/run.sh" ]
