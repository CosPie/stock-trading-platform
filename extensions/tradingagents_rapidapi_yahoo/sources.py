"""RapidAPI-backed Yahoo Finance data sources.

The default TradingAgents yfinance path can fail hard when Yahoo rate-limits
the server IP. These functions use RapidAPI as an operator-provided fallback
without storing API keys in the repository.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any

import pandas as pd
import requests
from dateutil.relativedelta import relativedelta
from stockstats import wrap

from tradingagents.dataflows.symbol_utils import NoMarketDataError, normalize_symbol

RAPIDAPI_KEY_ENVS = ("RAPIDAPI_YAHOO_KEY", "RAPIDAPI_KEY", "X_RAPIDAPI_KEY")
CHART_HOST = "apidojo-yahoo-finance-v1.p.rapidapi.com"
TICKER_NEWS_HOST = "yahoo-finance15.p.rapidapi.com"
GLOBAL_NEWS_HOST = "yahoo-finance166.p.rapidapi.com"
TIMEOUT = 20

INDICATOR_DESCRIPTIONS = {
    "close_50_sma": "50 SMA: A medium-term trend indicator based on closing prices.",
    "close_200_sma": "200 SMA: A long-term trend benchmark based on closing prices.",
    "close_10_ema": "10 EMA: A responsive short-term exponential moving average.",
    "macd": "MACD: Momentum indicator based on the difference between moving averages.",
    "macds": "MACD Signal: Smoothed signal line for MACD.",
    "macdh": "MACD Histogram: Difference between MACD and its signal line.",
    "rsi": "RSI: Momentum oscillator for overbought/oversold conditions.",
    "boll": "Bollinger Middle: Moving-average center line of Bollinger Bands.",
    "boll_ub": "Bollinger Upper Band: Upper volatility band.",
    "boll_lb": "Bollinger Lower Band: Lower volatility band.",
    "atr": "ATR: Average True Range volatility indicator.",
    "vwma": "VWMA: Volume-weighted moving average.",
    "mfi": "MFI: Money Flow Index, combining price and volume.",
}


def rapidapi_is_configured() -> bool:
    return bool(_api_key())


def get_stock_data_rapidapi_yahoo(symbol: str, start_date: str, end_date: str) -> str:
    """Return OHLCV CSV data using Yahoo chart data through RapidAPI."""
    datetime.strptime(start_date, "%Y-%m-%d")
    datetime.strptime(end_date, "%Y-%m-%d")
    canonical = normalize_symbol(symbol)
    data = _chart_dataframe(canonical, start_date, end_date)
    if data.empty:
        raise NoMarketDataError(symbol, canonical, f"RapidAPI Yahoo returned no rows between {start_date} and {end_date}")

    for col in ("Open", "High", "Low", "Close", "Adj Close"):
        if col in data.columns:
            data[col] = data[col].round(2)

    label = canonical if canonical == symbol.upper() else f"{canonical} (from {symbol})"
    header = f"# Stock data for {label} from {start_date} to {end_date}\n"
    header += f"# Source: RapidAPI Yahoo Finance chart\n"
    header += f"# Total records: {len(data)}\n"
    header += f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    return header + data.set_index("Date").to_csv()


def get_indicators_rapidapi_yahoo(symbol: str, indicator: str, curr_date: str, look_back_days: int) -> str:
    """Calculate stockstats indicators from RapidAPI Yahoo OHLCV data."""
    if indicator not in INDICATOR_DESCRIPTIONS:
        raise ValueError(f"Indicator {indicator} is not supported. Please choose from: {list(INDICATOR_DESCRIPTIONS.keys())}")

    canonical = normalize_symbol(symbol)
    curr_date_dt = datetime.strptime(curr_date, "%Y-%m-%d")
    before = curr_date_dt - relativedelta(days=int(look_back_days))
    warmup_start = (before - relativedelta(days=260)).strftime("%Y-%m-%d")

    data = _chart_dataframe(canonical, warmup_start, curr_date)
    if data.empty:
        raise NoMarketDataError(symbol, canonical, f"RapidAPI Yahoo returned no rows before {curr_date}")

    stats = wrap(_clean_for_stockstats(data))
    stats["Date"] = stats["Date"].dt.strftime("%Y-%m-%d")
    stats[indicator]

    rows = stats[(stats["Date"] >= before.strftime("%Y-%m-%d")) & (stats["Date"] <= curr_date_dt.strftime("%Y-%m-%d"))]
    values = []
    for _, row in rows.iterrows():
        value = row.get(indicator)
        values.append(f"{row['Date']}: {'N/A' if pd.isna(value) else value}")

    if not values:
        values.append("N/A: No trading data in requested window")

    return (
        f"## {indicator} values from {before.strftime('%Y-%m-%d')} to {curr_date}:\n\n"
        + "\n".join(values)
        + "\n\n"
        + INDICATOR_DESCRIPTIONS[indicator]
        + "\nSource: RapidAPI Yahoo Finance chart."
    )


def get_news_rapidapi_yahoo(ticker: str, start_date: str, end_date: str) -> str:
    """Return ticker news from the RapidAPI Yahoo Finance news endpoint."""
    payload = _request_json(
        TICKER_NEWS_HOST,
        "https://yahoo-finance15.p.rapidapi.com/api/v1/markets/news",
        {"ticker": ticker},
    )
    articles = payload.get("body") if isinstance(payload, dict) else None
    if not isinstance(articles, list) or not articles:
        return f"No RapidAPI Yahoo news found for {ticker}"
    return _format_news_articles(
        articles,
        f"## RapidAPI Yahoo news for {ticker}, from {start_date} to {end_date}:\n\n",
        start_date,
        end_date,
    )


def get_global_news_rapidapi_yahoo(curr_date: str, look_back_days: int | None = None, limit: int | None = None) -> str:
    """Return global market news from the RapidAPI Yahoo Finance stream endpoint."""
    look_back_days = 7 if look_back_days is None else int(look_back_days)
    limit = 10 if limit is None else int(limit)
    payload = _request_json(
        GLOBAL_NEWS_HOST,
        "https://yahoo-finance166.p.rapidapi.com/api/news/list",
        {"snippetCount": str(limit), "region": "US"},
    )
    articles = _extract_stream_articles(payload)[:limit]
    if not articles:
        return f"No RapidAPI Yahoo global news found for {curr_date}"
    curr = datetime.strptime(curr_date, "%Y-%m-%d")
    start = (curr - relativedelta(days=look_back_days)).strftime("%Y-%m-%d")
    return _format_news_articles(
        articles,
        f"## RapidAPI Yahoo global market news, from {start} to {curr_date}:\n\n",
        start,
        curr_date,
    )


def _api_key() -> str:
    for name in RAPIDAPI_KEY_ENVS:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _headers(host: str) -> dict[str, str]:
    key = _api_key()
    if not key:
        raise RuntimeError("RapidAPI Yahoo fallback is not configured; set RAPIDAPI_YAHOO_KEY or RAPIDAPI_KEY")
    return {
        "Content-Type": "application/json",
        "x-rapidapi-host": host,
        "x-rapidapi-key": key,
    }


def _request_json(host: str, url: str, params: dict[str, str]) -> dict[str, Any]:
    response = requests.get(url, headers=_headers(host), params=params, timeout=TIMEOUT)
    if response.status_code == 429:
        raise RuntimeError("RapidAPI Yahoo rate limited the request")
    response.raise_for_status()
    return response.json()


@lru_cache(maxsize=64)
def _chart_payload(canonical_symbol: str, period1: int, period2: int) -> dict[str, Any]:
    return _request_json(
        CHART_HOST,
        "https://apidojo-yahoo-finance-v1.p.rapidapi.com/stock/v2/get-chart",
        {
            "interval": "1d",
            "symbol": canonical_symbol,
            "period1": str(period1),
            "period2": str(period2),
            "region": "US",
        },
    )


def _chart_dataframe(canonical_symbol: str, start_date: str, end_date: str) -> pd.DataFrame:
    period1, period2 = _period_bounds(start_date, end_date)
    payload = _chart_payload(canonical_symbol, period1, period2)
    result = (((payload.get("chart") or {}).get("result") or []) if isinstance(payload, dict) else [])
    if not result:
        return pd.DataFrame()

    chart = result[0]
    timestamps = chart.get("timestamp") or []
    quote = (((chart.get("indicators") or {}).get("quote") or [{}])[0]) or {}
    adjclose = (((chart.get("indicators") or {}).get("adjclose") or [{}])[0]).get("adjclose") or quote.get("close") or []
    rows = []
    for index, ts in enumerate(timestamps):
        row = {
            "Date": pd.to_datetime(ts, unit="s").normalize(),
            "Open": _array_value(quote.get("open"), index),
            "High": _array_value(quote.get("high"), index),
            "Low": _array_value(quote.get("low"), index),
            "Close": _array_value(quote.get("close"), index),
            "Adj Close": _array_value(adjclose, index),
            "Volume": _array_value(quote.get("volume"), index) or 0,
        }
        rows.append(row)

    data = pd.DataFrame(rows)
    if data.empty:
        return data
    data = data.dropna(subset=["Close"])
    start = pd.to_datetime(start_date)
    end = pd.to_datetime(end_date) + pd.Timedelta(days=1)
    data = data[(data["Date"] >= start) & (data["Date"] < end)]
    return data.sort_values("Date").reset_index(drop=True)


def _array_value(values: Any, index: int) -> Any:
    if not isinstance(values, list) or index >= len(values):
        return None
    return values[index]


def _period_bounds(start_date: str, end_date: str) -> tuple[int, int]:
    start = datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end = (datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)).replace(tzinfo=timezone.utc)
    return int(start.timestamp()), int(end.timestamp())


def _clean_for_stockstats(data: pd.DataFrame) -> pd.DataFrame:
    cleaned = data.copy()
    cleaned["Date"] = pd.to_datetime(cleaned["Date"], errors="coerce")
    for column in ("Open", "High", "Low", "Close", "Volume"):
        cleaned[column] = pd.to_numeric(cleaned[column], errors="coerce")
    cleaned = cleaned.dropna(subset=["Date", "Close"])
    cleaned[["Open", "High", "Low", "Close", "Volume"]] = cleaned[["Open", "High", "Low", "Close", "Volume"]].ffill().bfill()
    return cleaned


def _format_news_articles(articles: list[dict[str, Any]], header: str, start_date: str, end_date: str) -> str:
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d") + relativedelta(days=1)
    lines = []
    seen = set()
    for article in articles:
        item = _normalize_article(article)
        title = item["title"]
        if not title or title in seen:
            continue
        seen.add(title)
        published = _parse_article_date(item["published"])
        if published and not (start <= published.replace(tzinfo=None) <= end):
            continue
        lines.append(f"### {title} (source: {item['publisher']})")
        if item["summary"]:
            lines.append(item["summary"])
        if item["link"]:
            lines.append(f"Link: {item['link']}")
        lines.append("")
    if not lines:
        return header + "No matching RapidAPI Yahoo news articles found."
    return header + "\n".join(lines)


def _normalize_article(article: dict[str, Any]) -> dict[str, str]:
    content = article.get("content") or article.get("editorialContent") or article
    canonical_url = content.get("canonicalUrl") or content.get("clickThroughUrl") or {}
    provider = content.get("provider") or {}
    return {
        "title": str(content.get("title") or article.get("title") or "No title"),
        "summary": str(content.get("summary") or article.get("description") or ""),
        "publisher": str(provider.get("displayName") or article.get("publisher") or "Yahoo Finance"),
        "link": str(canonical_url.get("url") or article.get("link") or ""),
        "published": str(content.get("pubDate") or content.get("displayTime") or article.get("pubDate") or ""),
    }


def _parse_article_date(value: str) -> datetime | None:
    if not value:
        return None
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _extract_stream_articles(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    stream = (((payload.get("data") or {}).get("ntk") or {}).get("stream") or [])
    if isinstance(stream, list):
        return [item for item in stream if isinstance(item, dict)]
    return []
