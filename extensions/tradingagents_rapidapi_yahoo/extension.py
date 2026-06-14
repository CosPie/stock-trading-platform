"""Runtime registration for RapidAPI Yahoo Finance fallback vendors."""

from __future__ import annotations

import os
from copy import deepcopy

from .sources import (
    get_global_news_rapidapi_yahoo,
    get_indicators_rapidapi_yahoo,
    get_news_rapidapi_yahoo,
    get_stock_data_rapidapi_yahoo,
    rapidapi_is_configured,
)

VENDOR_NAME = "rapidapi_yahoo"


def install_rapidapi_yahoo_extension(config: dict, ticker: str | None = None) -> dict:
    """Register RapidAPI Yahoo Finance and return an updated config.

    The vendor is only enabled when an API key exists unless explicitly forced.
    Supported env vars: RAPIDAPI_YAHOO_KEY, RAPIDAPI_KEY, X_RAPIDAPI_KEY.
    """
    if _disabled():
        return config
    if not rapidapi_is_configured() and not _forced():
        return config

    from tradingagents.dataflows import interface

    _register_vendor(interface)

    updated = deepcopy(config)
    data_vendors = dict(updated.get("data_vendors") or {})
    for category in ("core_stock_apis", "technical_indicators", "news_data"):
        existing = data_vendors.get(category, "yfinance")
        env_key = f"TRADINGAGENTS_{category.upper()}_VENDOR_CHAIN"
        override = os.getenv(env_key, "").strip()
        if category == "news_data" and _is_china_ticker(ticker or "") and not override:
            data_vendors[category] = _append_vendor(existing, VENDOR_NAME)
        else:
            data_vendors[category] = override or _prepend_vendor(existing, VENDOR_NAME)

    updated["data_vendors"] = data_vendors
    return updated


def _register_vendor(interface) -> None:
    registrations = {
        "get_stock_data": get_stock_data_rapidapi_yahoo,
        "get_indicators": get_indicators_rapidapi_yahoo,
        "get_news": get_news_rapidapi_yahoo,
        "get_global_news": get_global_news_rapidapi_yahoo,
    }
    for method, impl in registrations.items():
        methods = interface.VENDOR_METHODS.setdefault(method, {})
        methods[VENDOR_NAME] = impl

    if VENDOR_NAME not in interface.VENDOR_LIST:
        interface.VENDOR_LIST.append(VENDOR_NAME)


def _prepend_vendor(vendor_config: str, vendor: str) -> str:
    vendors = [part.strip() for part in str(vendor_config or "").split(",") if part.strip()]
    vendors = [part for part in vendors if part != vendor]
    return ",".join([vendor, *vendors])


def _append_vendor(vendor_config: str, vendor: str) -> str:
    vendors = [part.strip() for part in str(vendor_config or "").split(",") if part.strip()]
    vendors = [part for part in vendors if part != vendor]
    return ",".join([*vendors, vendor])


def _is_china_ticker(ticker: str) -> bool:
    try:
        from extensions.tradingagents_china_news.sources import is_china_ticker

        return is_china_ticker(ticker)
    except Exception:
        return False


def _disabled() -> bool:
    return os.getenv("TRADINGAGENTS_RAPIDAPI_YAHOO_ENABLED", "1").strip().lower() in {
        "0",
        "false",
        "no",
        "off",
    }


def _forced() -> bool:
    return os.getenv("TRADINGAGENTS_RAPIDAPI_YAHOO_FORCE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
