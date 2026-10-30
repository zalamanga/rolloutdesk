# syntax=docker/dockerfile:1
FROM rust:1.99.1-slim-bookworm AS builder
WORKDIR /build
ENV CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
COPY backend/migrations ./migrations
RUN --mount=type=cache,id=rolloutdesk-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=rolloutdesk-target,target=/build/target \
    mkdir -p /dist && \
    cargo build --locked --release --bin api && \
    (cargo test --locked --release --lib --no-run --message-format=json > /tmp/test-build.json || (cat /tmp/test-build.json && exit 1)) && \
    harness="$(sed -n 's/.*"executable":"\([^"]*\)".*/\1/p' /tmp/test-build.json | tail -n 1)" && \
    test -n "$harness" && cp "$harness" /dist/labtests && cp target/release/api /dist/api

FROM debian:bookworm-slim AS base
WORKDIR /app
USER 10001:10001

FROM base AS runtime
COPY --from=builder /dist/api /app/api
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=10s --start-period=15s --retries=12 CMD ["/app/api", "health"]
CMD ["/app/api"]

FROM base AS test
COPY --from=builder /dist/labtests /app/labtests
CMD ["/app/labtests", "--test-threads=1"]
