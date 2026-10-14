FROM debian:sid-slim
RUN apt-get update -qq && apt-get install -y --no-install-recommends guile-hoot ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /spike
