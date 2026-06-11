"""Runtime registration for the China finance news vendor.

This module intentionally patches TradingAgents at runtime instead of editing
the vendored ``third_party/tradingagents`` source tree. Keeping the integration
here makes upstream ``git pull`` maintenance much less painful.
"""

from __future__ import annotations

import os
from copy import deepcopy

from .sources import (
    get_global_news_china,
    get_global_news_public_rss,
    get_news_china,
    get_news_public_rss,
    is_china_ticker,
)

VENDOR_NAME = "china_finance"
PUBLIC_VENDOR_NAME = "public_rss"


def install_china_news_extension(config: dict, ticker: str | None = None) -> dict:
    """Register ``china_finance`` and return an updated TradingAgents config."""
    from tradingagents.dataflows import interface

    if os.getenv("TRADINGAGENTS_CHINA_NEWS_ENABLED", "1").strip().lower() in {
        "0",
        "false",
        "no",
        "off",
    }:
        return config

    _register_vendor(interface)

    updated = deepcopy(config)
    data_vendors = dict(updated.get("data_vendors") or {})
    existing_news_vendor = data_vendors.get("news_data", "yfinance")
    vendor_chain = _prepend_vendor(existing_news_vendor, PUBLIC_VENDOR_NAME)

    # Use China-first news only when the target likely belongs to CN/HK, or
    # when explicitly requested by env. US/global tickers keep the upstream
    # default plus public RSS fallback unless the operator opts in.
    force = os.getenv("TRADINGAGENTS_CHINA_NEWS_FORCE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if force or is_china_ticker(ticker or ""):
        vendor_chain = _prepend_vendor(vendor_chain, VENDOR_NAME)

    override_chain = os.getenv("TRADINGAGENTS_NEWS_VENDOR_CHAIN", "").strip()
    data_vendors["news_data"] = override_chain or vendor_chain
    updated["data_vendors"] = data_vendors

    return updated


def _register_vendor(interface) -> None:
    registrations = {
        VENDOR_NAME: {
            "get_news": get_news_china,
            "get_global_news": get_global_news_china,
        },
        PUBLIC_VENDOR_NAME: {
            "get_news": get_news_public_rss,
            "get_global_news": get_global_news_public_rss,
        },
    }
    for vendor, methods_by_name in registrations.items():
        for method, impl in methods_by_name.items():
            methods = interface.VENDOR_METHODS.setdefault(method, {})
            methods[vendor] = impl

        if vendor not in interface.VENDOR_LIST:
            interface.VENDOR_LIST.append(vendor)


def _prepend_vendor(vendor_config: str, vendor: str) -> str:
    vendors = [part.strip() for part in str(vendor_config or "").split(",") if part.strip()]
    vendors = [part for part in vendors if part != vendor]
    return ",".join([vendor, *vendors])
