ARG BUILD_FROM
FROM $BUILD_FROM

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN \
    apk add --no-cache \
        nodejs \
        npm \
        openjdk17-jre-headless \
        curl \
        unzip \
        netcat-openbsd

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY src/ ./src/
COPY index.js ./

RUN mkdir -p /data /share/cgate

COPY homeassistant-addon/rootfs /

COPY homeassistant-addon/run.sh /
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

CMD [ "/run.sh" ]
