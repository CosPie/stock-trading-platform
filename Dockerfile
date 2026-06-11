# syntax=docker/dockerfile:1

FROM golang:1.25-alpine AS go-builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ cmd/
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM node:22-alpine AS web-builder

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY frontend/ frontend/
COPY postcss.config.cjs tailwind.config.cjs vite.config.js ./
RUN npm run build \
 && mkdir -p /out/web \
 && cp -R web/. /out/web/

FROM python:3.12-slim AS py-builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_COMPILE=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /build
COPY third_party/tradingagents ./third_party/tradingagents
RUN python - <<'PY' > /tmp/tradingagents-constraints.txt
import tomllib
from pathlib import Path

locked = {}
for package in tomllib.loads(Path("third_party/tradingagents/uv.lock").read_text()).get("package", []):
    name = package["name"]
    if name != "tradingagents":
        locked[name] = package["version"]

for name in sorted(locked):
    print(f"{name}=={locked[name]}")
PY
RUN pip install --no-cache-dir --prefer-binary -c /tmp/tradingagents-constraints.txt ./third_party/tradingagents

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    YF_DISABLE_CURL_CFFI=1 \
    APP_ADDR=:16666

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=py-builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY --from=go-builder /out/server /app/server
COPY --from=web-builder /out/web/ /app/web/
COPY scripts/ /app/scripts/
COPY third_party/tradingagents/ /app/third_party/tradingagents/

RUN useradd --create-home --uid 1000 appuser \
 && install -d -m 0755 -o appuser -g appuser /app/data/runtime/tradingagents-results \
 && install -d -m 0755 -o appuser -g appuser /home/appuser/.tradingagents \
 && chown -R appuser:appuser /app

USER appuser

EXPOSE 16666

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:16666/api/health')" || exit 1

ENTRYPOINT ["/app/server"]
