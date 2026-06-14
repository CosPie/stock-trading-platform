import os
import sys
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "third_party", "tradingagents"))

from extensions.tradingagents_china_news.extension import install_china_news_extension
from extensions.tradingagents_china_news.sources import (
    _fetch_eastmoney_articles,
    _matches_alias,
)
from extensions.tradingagents_rapidapi_yahoo.extension import install_rapidapi_yahoo_extension


class ChinaNewsSourceTests(unittest.TestCase):
    def test_alias_matching_tolerates_markup_spacing(self):
        self.assertTrue(_matches_alias("云南锗业( 002 428 .SZ )", ["002428", "云南锗业"]))
        self.assertFalse(_matches_alias("ST长方 300301.SZ", ["002428", "云南锗业"]))

    def test_eastmoney_articles_filter_to_requested_symbol(self):
        payload = {
            "result": {
                "cmsArticleWebOld": [
                    {
                        "date": "2026-06-11 21:21:00",
                        "title": "炸板后回封涨停！<em>002428</em>单日狂揽百亿成交",
                        "content": "云南锗业（<em>002428</em>）龙虎榜净买入超9亿元。",
                        "mediaName": "上海证券报",
                        "url": "https://example.test/002428",
                    },
                    {
                        "date": "2026-06-12 18:17:05",
                        "title": "ST长方(300301.SZ)：新增债务逾期",
                        "content": "与目标股票无关。",
                        "mediaName": "界面新闻",
                        "url": "https://example.test/300301",
                    },
                ]
            }
        }
        with patch("extensions.tradingagents_china_news.sources._get_json", return_value=payload):
            articles, note = _fetch_eastmoney_articles(
                "002428",
                ["002428", "云南锗业"],
                datetime(2026, 6, 6, tzinfo=timezone.utc),
                datetime(2026, 6, 13, tzinfo=timezone.utc),
            )

        self.assertEqual(note, "")
        self.assertEqual([item.source for item in articles], ["上海证券报"])
        self.assertIn("002428", articles[0].title)


class VendorOrderTests(unittest.TestCase):
    def test_rapidapi_does_not_preempt_china_news_for_a_shares(self):
        config = {
            "data_vendors": {
                "core_stock_apis": "yfinance",
                "technical_indicators": "yfinance",
                "news_data": "yfinance",
            }
        }
        with patch.dict(os.environ, {"RAPIDAPI_YAHOO_KEY": "dummy"}, clear=False):
            config = install_china_news_extension(config, "002428.SZ")
            config = install_rapidapi_yahoo_extension(config, "002428.SZ")

        self.assertEqual(
            config["data_vendors"]["news_data"],
            "china_finance,public_rss,yfinance,rapidapi_yahoo",
        )


if __name__ == "__main__":
    unittest.main()
