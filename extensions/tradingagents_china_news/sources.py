"""China-focused public news sources for TradingAgents.

The implementation prefers RSS feeds and small public JSON endpoints because
they are less brittle than scraping rendered news pages. Every fetch degrades
to a short placeholder so a failed source never blocks a full analysis run.
"""

from __future__ import annotations

import html
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

GLOBAL_NEWS_SOURCES = (
    RSSSource("新浪财经-财经要闻", "https://rss.sina.com.cn/roll/finance/hot_roll.xml", 4, "macro"),
    RSSSource("财新-经济新闻", "https://economy.caixin.com/news/rss/100300184.xml", 5, "macro"),
    RSSSource("财新-金融市场", "https://finance.caixin.com/market/rss/100300179.xml", 5, "macro"),
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
        "Sources are China-focused public finance feeds. Treat exchange/regulatory "
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


def _fetch_rss(source: RSSSource, start: datetime, end: datetime) -> tuple[list[Article], str]:
    try:
        response = _session().get(source.url, timeout=DEFAULT_TIMEOUT)
        response.raise_for_status()
        articles = _parse_feed(response.content, source)
        return [item for item in articles if _in_range(item.published, start, end)], ""
    except Exception as exc:
        return [], f"{source.name}: {exc}"


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
    return "\nFetch notes: " + " | ".join(unique[:5]) + "\n"


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
