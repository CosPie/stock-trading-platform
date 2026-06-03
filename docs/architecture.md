# Architecture

## Runtime Flow

1. Browser posts `/api/analyses` with ticker and depth.
2. Go creates a report record and starts an async job.
3. The job launches `scripts/run_tradingagents.py` as a child process.
4. The Python bridge imports `third_party/tradingagents`, runs the graph, and prints JSON lines.
5. Go stores every event in `data/app_state.json` and broadcasts it through Server-Sent Events.
6. Browser subscribes to `/api/analyses/:id/events` and updates progress/logs in real time.

## Why A Python Bridge

TradingAgents is a Python package and its CLI is interactive. The bridge avoids terminal automation and lets the Go backend keep a clean HTTP API while still preserving real-time progress events.

## Trusted Storage

The WebUI saves the DeepSeek API Key locally because the target deployment is an internal trusted environment without authentication. Do not deploy this as-is on a public network.
