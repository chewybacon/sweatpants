ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG DEBIAN_SNAPSHOT
ARG HOOT_VERSION
ARG GUILE_VERSION
ARG GUILE_LIBS_VERSION
RUN printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s/ sid main\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
 && rm /etc/apt/sources.list.d/debian.sources \
 && apt-get update -qq \
 && apt-get install -y --no-install-recommends "guile-hoot=$HOOT_VERSION" "guile-3.0=$GUILE_VERSION" "guile-3.0-libs=$GUILE_LIBS_VERSION" \
 && rm -rf /var/lib/apt/lists/*
ENV GUILE_AUTO_COMPILE=0
WORKDIR /build
