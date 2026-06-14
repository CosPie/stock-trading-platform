"""China-focused public news sources for TradingAgents.

The implementation prefers RSS feeds and small public JSON endpoints because
they are less brittle than scraping rendered news pages. Every fetch degrades
to a short placeholder so a failed source never blocks a full analysis run.
"""

from __future__ import annotations

import html
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Iterable
from urllib.parse import urlencode

import requests

DEFAULT_TIMEOUT = 8
USER_AGENT = (
    "stock-trading-platform/1.0 "
    "(China finance news extension; contact: local-user)"
)


@dataclass(frozen=True)
class RSSSource:
    name: str
    url: str
    weight: int
    role: str


@dataclass(frozen=True)
class Article:
    title: str
    source: str
    link: str = ""
    published: str = ""
    summary: str = ""
    weight: int = 1


STOCK_NEWS_SOURCES = (
    RSSSource("新浪财经-股票要闻", "https://rss.sina.com.cn/roll/stock/hot_roll.xml", 4, "stock"),
    RSSSource("新浪财经-股市及时雨", "https://rss.sina.com.cn/finance/jsy.xml", 4, "stock"),
    RSSSource("上海证券报", "https://feed.cnstock.com/rss/news.xml", 5, "stock"),
    RSSSource("中国证券报-海外信息", "https://www.cs.com.cn/xwzx/hwxx/rss.xml", 3, "stock"),
    RSSSource("财新-金融市场", "https://finance.caixin.com/market/rss/100300179.xml", 5, "stock"),
)

EASTMONEY_SEARCH_URL = "https://search-api-web.eastmoney.com/search/jsonp"
EASTMONEY_ANN_URL = "https://np-anotice-stock.eastmoney.com/api/security/ann"
EASTMONEY_QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
EASTMONEY_GUBA_URL = "https://gbapi.eastmoney.com/webarticlelist/api/Article/Articlelist"
XUEQIU_SEARCH_URL = "https://xueqiu.com/query/v1/search/status.json"
THS_SEARCH_URL = "https://search.10jqka.com.cn/search"

GLOBAL_NEWS_SOURCES = (
    RSSSource("新浪财经-财经要闻", "https://rss.sina.com.cn/roll/finance/hot_roll.xml", 4, "macro"),
    RSSSource("财新-经济新闻", "https://economy.caixin.com/news/rss/100300184.xml", 5, "macro"),
    RSSSource("财新-金融市场", "https://finance.caixin.com/market/rss/100300179.xml", 5, "macro"),
)

PUBLIC_GLOBAL_QUERIES = (
    "Federal Reserve interest rates inflation",
    "S&P 500 earnings GDP economic outlook",
    "geopolitical risk trade war sanctions",
    "oil commodities supply chain energy markets",
)

_A_SHARE_RE = re.compile(r"(?<!\d)(?:SH|SZ)?(\d{6})(?:\.(?:SS|SH|SZ|BJ))?(?!\d)", re.I)
_HK_RE = re.compile(r"(?<!\d)(\d{4,5})(?:\.HK)?(?!\d)", re.I)
_TAGS_RE = re.compile(r"<[^>]+>")


def is_china_ticker(ticker: str) -> bool:
    normalized = ticker.strip().upper()
    if not normalized:
        return False
    if normalized.endswith((".SS", ".SH", ".SZ", ".BJ", ".HK")):
        return True
    return bool(_A_SHARE_RE.fullmatch(normalized) or _HK_RE.fullmatch(normalized))


def get_news_china(ticker: str, start_date: str, end_date: str) -> str:
    aliases = _ticker_aliases(ticker)
    lookback_start = _parse_date(start_date) or (datetime.now(timezone.utc) - timedelta(days=7))
    lookback_end = _parse_date(end_date) or datetime.now(timezone.utc)
    limit = _env_int("TRADINGAGENTS_CHINA_NEWS_LIMIT", 16)

    articles = []
    fetch_notes = []
    for source in STOCK_NEWS_SOURCES:
        fetched, note = _fetch_rss(source, lookback_start, lookback_end)
        if note:
            fetch_notes.append(note)
        articles.extend(_matching_articles(fetched, aliases))

    if os.getenv("TRADINGAGENTS_CHINA_LOCAL_SOURCES_ENABLED", "1").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }:
        fetched, notes = _fetch_local_china_sources(ticker, aliases, lookback_start, lookback_end)
        articles.extend(fetched)
        fetch_notes.extend(notes)

    articles = _dedupe_articles(articles)
    articles.sort(key=lambda item: (item.weight, item.published), reverse=True)

    if not articles:
        alias_text = ", ".join(aliases) if aliases else ticker
        return (
            f"## China finance news for {ticker}, from {start_date} to {end_date}\n\n"
            f"<no China finance RSS headlines matched {alias_text}. "
            "Keep this as a data-limit note; do not infer positive or negative sentiment from silence.>\n"
            + _format_notes(fetch_notes)
        )

    return (
        f"## China finance news for {ticker}, from {start_date} to {end_date}\n\n"
        "Sources include China-focused public finance feeds plus A-share local "
        "endpoints where available: Eastmoney quote/news/announcements, Eastmoney "
        "Guba, Xueqiu, and Tonghuashun search. Treat exchange/regulatory filings "
        "and established financial-media headlines as higher-confidence signals; "
        "treat retail/community chatter as weaker sentiment context when present.\n\n"
        + _format_articles(articles[:limit])
        + _format_notes(fetch_notes)
    )


def get_global_news_china(
    curr_date: str,
    look_back_days: int | None = None,
    limit: int | None = None,
) -> str:
    days = look_back_days or _env_int("TRADINGAGENTS_CHINA_GLOBAL_LOOKBACK_DAYS", 7)
    max_items = limit or _env_int("TRADINGAGENTS_CHINA_GLOBAL_NEWS_LIMIT", 12)
    end = _parse_date(curr_date) or datetime.now(timezone.utc)
    start = end - timedelta(days=days)

    articles = []
    fetch_notes = []
    for source in GLOBAL_NEWS_SOURCES:
        fetched, note = _fetch_rss(source, start, end)
        if note:
            fetch_notes.append(note)
        articles.extend(fetched)

    articles = _dedupe_articles(articles)
    articles.sort(key=lambda item: (item.weight, item.published), reverse=True)

    if not articles:
        return (
            f"## China macro and market news, from {start.date()} to {end.date()}\n\n"
            "<no China macro RSS headlines were available from configured feeds.>\n"
            + _format_notes(fetch_notes)
        )

    return (
        f"## China macro and market news, from {start.date()} to {end.date()}\n\n"
        + _format_articles(articles[:max_items])
        + _format_notes(fetch_notes)
    )


def get_news_public_rss(ticker: str, start_date: str, end_date: str) -> str:
    """Fetch ticker news from public RSS search feeds as a no-key fallback."""
    query = os.getenv(
        "TRADINGAGENTS_PUBLIC_NEWS_QUERY_TEMPLATE",
        '"{ticker}" stock OR shares OR earnings OR analyst',
    ).format(ticker=ticker.strip().upper())
    start = _parse_date(start_date) or (datetime.now(timezone.utc) - timedelta(days=7))
    end = _parse_date(end_date) or datetime.now(timezone.utc)
    limit = _env_int("TRADINGAGENTS_PUBLIC_NEWS_LIMIT", 12)

    articles, note = _fetch_google_news(query, "Google News RSS", start, end, weight=3)
    articles = _dedupe_articles(articles)
    articles.sort(key=lambda item: (item.weight, item.published), reverse=True)

    if not articles:
        return (
            f"## Public RSS news for {ticker}, from {start_date} to {end_date}\n\n"
            "<no public RSS headlines matched this ticker. Keep this as a data-limit note; "
            "do not infer positive or negative sentiment from silence.>\n"
            + _format_notes([note])
        )

    return (
        f"## Public RSS news for {ticker}, from {start_date} to {end_date}\n\n"
        "Source: public RSS search feeds. Treat these headlines as lower-confidence "
        "fallback context when primary market-data news providers are unavailable.\n\n"
        + _format_articles(articles[:limit])
        + _format_notes([note])
    )


def get_global_news_public_rss(
    curr_date: str,
    look_back_days: int | None = None,
    limit: int | None = None,
) -> str:
    """Fetch global macro/market news from public RSS search feeds."""
    days = look_back_days or _env_int("TRADINGAGENTS_PUBLIC_GLOBAL_LOOKBACK_DAYS", 7)
    max_items = limit or _env_int("TRADINGAGENTS_PUBLIC_GLOBAL_NEWS_LIMIT", 10)
    end = _parse_date(curr_date) or datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    query_text = os.getenv("TRADINGAGENTS_PUBLIC_GLOBAL_NEWS_QUERIES", "")
    queries = [part.strip() for part in query_text.split("|") if part.strip()] or list(PUBLIC_GLOBAL_QUERIES)

    articles = []
    fetch_notes = []
    for query in queries:
        fetched, note = _fetch_google_news(query, "Google News RSS", start, end, weight=2)
        articles.extend(fetched)
        if note:
            fetch_notes.append(note)

    articles = _dedupe_articles(articles)
    articles.sort(key=lambda item: (item.weight, item.published), reverse=True)

    if not articles:
        return (
            f"## Public RSS global market news, from {start.date()} to {end.date()}\n\n"
            "<no public RSS macro headlines were available from configured feeds.>\n"
            + _format_notes(fetch_notes)
        )

    return (
        f"## Public RSS global market news, from {start.date()} to {end.date()}\n\n"
        + _format_articles(articles[:max_items])
        + _format_notes(fetch_notes)
    )


def _ticker_aliases(ticker: str) -> tuple[str, ...]:
    normalized = ticker.strip().upper()
    aliases = {normalized}
    code = _extract_code(normalized)
    if code:
        aliases.add(code)
        aliases.add(f"{code}.SH" if _looks_shanghai(code) else f"{code}.SZ")
        name = _lookup_eastmoney_name(code)
        if name:
            aliases.add(name)
    return tuple(sorted({item for item in aliases if item}, key=len, reverse=True))


def _extract_code(ticker: str) -> str:
    match = _A_SHARE_RE.search(ticker)
    if match:
        return match.group(1)
    return ""


def _looks_shanghai(code: str) -> bool:
    return code.startswith(("5", "6", "9"))


def _lookup_eastmoney_name(code: str) -> str:
    if not code or os.getenv("TRADINGAGENTS_CHINA_NEWS_NAME_LOOKUP", "1") == "0":
        return ""
    market = "1" if _looks_shanghai(code) else "0"
    url = "https://push2.eastmoney.com/api/qt/stock/get?" + urlencode(
        {"secid": f"{market}.{code}", "fields": "f57,f58"}
    )
    try:
        payload = _session().get(url, timeout=DEFAULT_TIMEOUT).json()
        data = payload.get("data") or {}
        return str(data.get("f58") or "").strip()
    except Exception:
        return ""


def _eastmoney_market(code: str) -> str:
    return "1" if _looks_shanghai(code) else "0"


def _eastmoney_secid(code: str) -> str:
    return f"{_eastmoney_market(code)}.{code}"


def _eastmoney_scaled(value, scale: int = 100) -> str:
    try:
        if value is None or value == "-":
            return "N/A"
        return f"{float(value) / scale:.2f}"
    except Exception:
        return str(value)


def _preferred_query(aliases: Iterable[str], fallback: str) -> str:
    cleaned = [_clean_text(str(item)) for item in aliases if _clean_text(str(item))]
    if not cleaned:
        return fallback
    return max(cleaned, key=lambda item: (any("\u4e00" <= ch <= "\u9fff" for ch in item), len(item)))


def _matches_alias(haystack: str, aliases: Iterable[str]) -> bool:
    compact = re.sub(r"\s+", "", haystack.lower())
    for alias in aliases:
        value = str(alias or "").strip().lower()
        if not value:
            continue
        if value in haystack or re.sub(r"\s+", "", value) in compact:
            return True
    return False


def _browser_user_agent() -> str:
    return os.getenv(
        "TRADINGAGENTS_CHINA_BROWSER_UA",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    )


def _get_json(url: str, params: dict, headers: dict | None = None) -> dict:
    response = _session().get(url, params=params, headers=headers or {}, timeout=DEFAULT_TIMEOUT)
    response.raise_for_status()
    text = response.text.strip()
    if not text:
        return {}
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1]
    if "=" in text[:80] and text.rstrip().endswith(";"):
        text = text.split("=", 1)[1].rstrip(";")
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    return json.loads(text)


def _fetch_local_china_sources(
    ticker: str,
    aliases: Iterable[str],
    start: datetime,
    end: datetime,
) -> tuple[list[Article], list[str]]:
    code = _extract_code(ticker)
    if not code:
        return [], ["local China sources skipped: no six-digit A-share code found"]

    notes: list[str] = []
    articles: list[Article] = []
    name = _lookup_eastmoney_name(code)
    query_aliases = tuple(dict.fromkeys([code, name, *aliases]))

    for fetcher in (
        _fetch_eastmoney_quote_snapshot,
        _fetch_eastmoney_announcements,
        _fetch_eastmoney_articles,
        _fetch_eastmoney_guba_posts,
        _fetch_xueqiu_posts,
        _fetch_ths_search_results,
    ):
        fetched, note = fetcher(code, query_aliases, start, end)
        articles.extend(fetched)
        if note:
            notes.append(note)

    return articles, notes


def _fetch_eastmoney_quote_snapshot(
    code: str,
    aliases: Iterable[str],
    start: datetime,
    end: datetime,
) -> tuple[list[Article], str]:
    secid = _eastmoney_secid(code)
    fields = ",".join(
        [
            "f43", "f44", "f45", "f46", "f47", "f48", "f57", "f58", "f60",
            "f116", "f117", "f135", "f136", "f137", "f168", "f169", "f170",
        ]
    )
    try:
        payload = _session().get(
            EASTMONEY_QUOTE_URL,
            params={"secid": secid, "fields": fields},
            headers={
                "Referer": f"https://quote.eastmoney.com/{'sz' if _eastmoney_market(code) == '0' else 'sh'}{code}.html",
                "User-Agent": _browser_user_agent(),
            },
            timeout=DEFAULT_TIMEOUT,
        ).json()
        data = payload.get("data") or {}
        if not data:
            return [], "东方财富 quote: no data"
        name = _clean_text(str(data.get("f58") or ""))
        price = _eastmoney_scaled(data.get("f43"))
        prev_close = _eastmoney_scaled(data.get("f60"))
        pct = _eastmoney_scaled(data.get("f170"))
        high = _eastmoney_scaled(data.get("f44"))
        low = _eastmoney_scaled(data.get("f45"))
        open_price = _eastmoney_scaled(data.get("f46"))
        turnover = data.get("f48")
        volume = data.get("f47")
        market_cap = data.get("f116")
        turnover_rate = _eastmoney_scaled(data.get("f168"))
        summary = (
            f"本土行情快照：最新价 {price}，涨跌幅 {pct}% ，昨收 {prev_close}，"
            f"开盘 {open_price}，最高 {high}，最低 {low}，成交量 {volume} 手，"
            f"成交额 {turnover} 元，换手率 {turnover_rate}% ，总市值 {market_cap} 元。"
        )
        return [
            Article(
                title=f"{name or code}({code}) 东方财富本土行情快照",
                source="东方财富 quote",
                link=f"https://quote.eastmoney.com/{'sz' if _eastmoney_market(code) == '0' else 'sh'}{code}.html",
                published=end.strftime("%Y-%m-%d"),
                summary=summary,
                weight=7,
            )
        ], ""
    except Exception as exc:
        return [], f"东方财富 quote: {exc}"


def _fetch_eastmoney_announcements(
    code: str,
    aliases: Iterable[str],
    start: datetime,
    end: datetime,
) -> tuple[list[Article], str]:
    try:
        payload = _session().get(
            EASTMONEY_ANN_URL,
            params={
                "sr": "-1",
                "page_size": _env_int("TRADINGAGENTS_CHINA_ANN_LIMIT", 8),
                "page_index": 1,
                "ann_type": "A",
                "client_source": "web",
                "stock_list": code,
            },
            timeout=DEFAULT_TIMEOUT,
        ).json()
        rows = ((payload.get("data") or {}).get("list") or []) if payload.get("success") else []
    except Exception as exc:
        return [], f"东方财富公告: {exc}"

    articles = []
    for row in rows:
        published = str(row.get("notice_date") or row.get("display_time") or "")
        if published and not _in_range(published, start, end):
            continue
        title = _clean_text(str(row.get("title_ch") or row.get("title") or ""))
        if not title:
            continue
        columns = ", ".join(
            _clean_text(str(item.get("column_name") or ""))
            for item in row.get("columns") or []
            if item.get("column_name")
        )
        art_code = str(row.get("art_code") or "")
        link = f"https://data.eastmoney.com/notices/detail/{code}/{art_code}.html" if art_code else ""
        articles.append(
            Article(
                title=title,
                source="东方财富公告",
                link=link,
                published=published,
                summary=f"公告栏目：{columns}" if columns else "",
                weight=8,
            )
        )
    return articles, "" if articles else "东方财富公告: no recent announcements in requested window"


def _fetch_eastmoney_articles(
    code: str,
    aliases: Iterable[str],
    start: datetime,
    end: datetime,
) -> tuple[list[Article], str]:
    keyword = code
    param = {
        "uid": "",
        "keyword": keyword,
        "type": ["cmsArticleWebOld"],
        "client": "web",
        "clientType": "web",
        "clientVersion": "curr",
        "param": {
            "cmsArticleWebOld": {
                "searchScope": "default",
                "sort": "default",
                "pageIndex": 1,
                "pageSize": _env_int("TRADINGAGENTS_CHINA_EASTMONEY_ARTICLE_LIMIT", 8),
            }
        },
    }
    try:
        payload = _get_json(EASTMONEY_SEARCH_URL, {"cb": "", "param": json.dumps(param, ensure_ascii=False)})
        rows = ((payload.get("result") or {}).get("cmsArticleWebOld") or [])
    except Exception as exc:
        return [], f"东方财富文章搜索: {exc}"

    articles = []
    for row in rows:
        published = str(row.get("date") or "")
        if published and not _in_range(published, start, end):
            continue
        title = _clean_text(str(row.get("title") or ""))
        if not title:
            continue
        summary = _clean_text(str(row.get("content") or ""))
        haystack = f"{title}\n{summary}".lower()
        if not _matches_alias(haystack, aliases):
            continue
        articles.append(
            Article(
                title=title,
                source=_clean_text(str(row.get("mediaName") or "东方财富文章搜索")),
                link=str(row.get("url") or ""),
                published=published,
                summary=summary,
                weight=7,
            )
        )
    return articles, "" if articles else "东方财富文章搜索: no matching recent articles"


def _fetch_eastmoney_guba_posts(
    code: str,
    aliases: Iterable[str],
    start: datetime,
    end: datetime,
) -> tuple[list[Article], str]:
    try:
        payload = _get_json(
            EASTMONEY_GUBA_URL,
            {
                "code": code,
                "sorttype": "0",
                "page": "1",
                "ps": str(_env_int("TRADINGAGENTS_CHINA_GUBA_LIMIT", 8)),
                "from": "CommonBaPost",
            },
            headers={"Referer": f"https://guba.eastmoney.com/list,{code}.html"},
        )
    except Exception as exc:
        return [], f"东方财富股吧: {exc}"

    rows = payload.get("re") or payload.get("data") or []
    articles = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        published = str(row.get("post_publish_time") or row.get("update_time") or row.get("ctime") or "")
        if published and not _in_range(published, start, end):
            continue
        title = _clean_text(str(row.get("post_title") or row.get("title") or ""))
        if not title:
            continue
        summary = _clean_text(str(row.get("post_content") or row.get("summary") or ""))
        articles.append(
            Article(
                title=title,
                source="东方财富股吧",
                link=f"https://guba.eastmoney.com/news,{code},{row.get('post_id')}.html" if row.get("post_id") else "",
                published=published,
                summary=summary,
                weight=3,
            )
        )
    if articles:
        return articles, ""
    message = _clean_text(str(payload.get("me") or "no posts returned"))
    bar = payload.get("bar_info") or {}
    short_name = _clean_text(str(bar.get("ShortName") or ""))
    suffix = f"; bar resolved to {short_name}" if short_name else ""
    return [], f"东方财富股吧: {message}{suffix}"


def _fetch_xueqiu_posts(
    code: str,
    aliases: Iterable[str],
    start: datetime,
    end: datetime,
) -> tuple[list[Article], str]:
    query = _preferred_query(aliases, code)
    try:
        payload = _get_json(
            XUEQIU_SEARCH_URL,
            {"q": query, "sortId": 1, "count": _env_int("TRADINGAGENTS_CHINA_XUEQIU_LIMIT", 8), "page": 1},
            headers={"Referer": f"https://xueqiu.com/S/SZ{code}"},
        )
    except Exception as exc:
        return [], f"雪球: {exc}"

    rows = payload.get("list") or payload.get("statuses") or payload.get("data") or []
    articles = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = _clean_text(str(row.get("title") or row.get("description") or row.get("text") or ""))
        if not title:
            continue
        published = str(row.get("created_at") or row.get("timeBefore") or "")
        articles.append(
            Article(
                title=title[:120],
                source="雪球",
                link=str(row.get("target") or row.get("url") or ""),
                published=published,
                summary=title,
                weight=3,
            )
        )
    return articles, "" if articles else "雪球: no public search results returned"


def _fetch_ths_search_results(
    code: str,
    aliases: Iterable[str],
    start: datetime,
    end: datetime,
) -> tuple[list[Article], str]:
    # Tonghuashun's current search page is a client-rendered app. We still
    # probe it so failures are explicit in the report, but avoid brittle HTML
    # scraping unless a server-rendered result appears.
    query = _preferred_query(aliases, code)
    try:
        response = _session().get(
            THS_SEARCH_URL,
            params={"w": query, "tid": "info"},
            headers={"Referer": "https://www.10jqka.com.cn/"},
            timeout=DEFAULT_TIMEOUT,
        )
        response.raise_for_status()
        text = response.text
    except Exception as exc:
        return [], f"同花顺搜索: {exc}"
    if "同花顺问财" in text or "window.__vite_is_modern_browser" in text:
        return [], "同花顺搜索: client-rendered/WAF page returned; no structured public results parsed"
    titles = re.findall(r"<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", text, flags=re.I | re.S)
    articles = []
    for link, raw_title in titles[: _env_int("TRADINGAGENTS_CHINA_THS_LIMIT", 5)]:
        title = _clean_text(raw_title)
        if not title or not any(alias and alias in title for alias in aliases):
            continue
        articles.append(Article(title=title, source="同花顺搜索", link=link, published="", weight=4))
    return articles, "" if articles else "同花顺搜索: no server-rendered matching results"


def _fetch_rss(source: RSSSource, start: datetime, end: datetime) -> tuple[list[Article], str]:
    try:
        response = _session().get(source.url, timeout=DEFAULT_TIMEOUT)
        response.raise_for_status()
        articles = _parse_feed(response.content, source)
        return [item for item in articles if _in_range(item.published, start, end)], ""
    except Exception as exc:
        return [], f"{source.name}: {exc}"


def _fetch_google_news(query: str, source_name: str, start: datetime, end: datetime, weight: int) -> tuple[list[Article], str]:
    url = "https://news.google.com/rss/search?" + urlencode(
        {
            "q": query,
            "hl": os.getenv("TRADINGAGENTS_PUBLIC_NEWS_HL", "en-US"),
            "gl": os.getenv("TRADINGAGENTS_PUBLIC_NEWS_GL", "US"),
            "ceid": os.getenv("TRADINGAGENTS_PUBLIC_NEWS_CEID", "US:en"),
        }
    )
    source = RSSSource(source_name, url, weight, "public")
    return _fetch_rss(source, start, end)


def _parse_feed(content: bytes, source: RSSSource) -> list[Article]:
    root = ET.fromstring(content)
    if _local_name(root.tag) == "rss":
        items = root.findall(".//item")
    else:
        items = [node for node in root.iter() if _local_name(node.tag) == "entry"]

    articles = []
    for item in items:
        title = _clean_text(_child_text(item, "title"))
        if not title:
            continue
        articles.append(
            Article(
                title=title,
                source=source.name,
                link=_first_link(item),
                published=_published_text(item),
                summary=_clean_text(
                    _child_text(item, "description")
                    or _child_text(item, "summary")
                    or _child_text(item, "content")
                ),
                weight=source.weight,
            )
        )
    return articles


def _matching_articles(articles: Iterable[Article], aliases: Iterable[str]) -> list[Article]:
    alias_list = [alias.lower() for alias in aliases if alias]
    if not alias_list:
        return list(articles)
    matched = []
    for article in articles:
        haystack = f"{article.title}\n{article.summary}".lower()
        if any(alias.lower() in haystack for alias in alias_list):
            matched.append(article)
    return matched


def _dedupe_articles(articles: Iterable[Article]) -> list[Article]:
    seen = set()
    deduped = []
    for article in articles:
        key = (article.title, article.link)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(article)
    return deduped


def _format_articles(articles: Iterable[Article]) -> str:
    lines = []
    for article in articles:
        published = f", {article.published}" if article.published else ""
        lines.append(f"### {article.title} (source: {article.source}{published})")
        if article.summary:
            lines.append(article.summary[:500])
        if article.link:
            lines.append(f"Link: {article.link}")
        lines.append("")
    return "\n".join(lines)


def _format_notes(notes: Iterable[str]) -> str:
    unique = list(dict.fromkeys(note for note in notes if note))
    if not unique:
        return ""
    return "\nFetch notes: " + " | ".join(unique[:10]) + "\n"


def _parse_date(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _in_range(published: str, start: datetime, end: datetime) -> bool:
    parsed = _parse_feed_date(published)
    if parsed is None:
        return True
    end_inclusive = end + timedelta(days=1)
    return start <= parsed <= end_inclusive


def _parse_feed_date(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        pass
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        pass
    return None


def _child_text(parent: ET.Element, child_name: str) -> str:
    for child in parent:
        if _local_name(child.tag) == child_name:
            return child.text or ""
    return ""


def _first_link(item: ET.Element) -> str:
    text_link = _child_text(item, "link").strip()
    if text_link:
        return text_link
    for child in item:
        if _local_name(child.tag) == "link":
            return child.attrib.get("href", "")
    return ""


def _published_text(item: ET.Element) -> str:
    return (
        _child_text(item, "pubDate")
        or _child_text(item, "published")
        or _child_text(item, "updated")
        or _child_text(item, "date")
    ).strip()


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _clean_text(value: str) -> str:
    value = html.unescape(value or "")
    value = _TAGS_RE.sub(" ", value)
    return " ".join(value.split())


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


_SESSION: requests.Session | None = None


def _session() -> requests.Session:
    global _SESSION
    if _SESSION is None:
        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT})
        _SESSION = session
    # A tiny pause is enough to avoid bursting several feeds at once.
    time.sleep(float(os.getenv("TRADINGAGENTS_CHINA_NEWS_DELAY", "0.15")))
    return _SESSION
