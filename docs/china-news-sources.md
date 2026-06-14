# 国内新闻源扩展

目标：在不改动 `third_party/tradingagents` 上游源码的前提下，为 A 股、港股和中文市场分析补充国内新闻来源。

## 集成方式

外层启动脚本 `scripts/run_tradingagents.py` 会加载 `extensions/tradingagents_china_news`。扩展在运行时向 TradingAgents 的 vendor 路由注册 `china_finance`，并且仅在目标代码看起来是 A 股/港股时把 `news_data` 调整为：

```text
china_finance,yfinance
```

这样 `third_party/tradingagents` 仍可继续从上游 `git pull`。如果上游更新了默认 vendor，扩展也只是在运行时排到新闻 vendor 链最前面，失败后仍回退到上游来源。

注意：RapidAPI Yahoo fallback 会在国内源之后安装。A 股/港股场景下，RapidAPI 只会追加到 `news_data` 链尾，不会抢走 `china_finance` 的第一优先级；否则会出现“装了国内源但新闻优先走 Yahoo”的现象。

## 当前来源选择

- 新浪财经 RSS：覆盖面广，适合做 A 股和中文宏观的快速 headline 层。
- 上海证券报 RSS：证券市场信息密度高，更适合 A 股个股、政策与市场制度变化。
- 中国证券报 RSS：偏权威媒体口径，适合交叉验证监管、海外市场和大类资产信息。
- 财新 RSS：原创和深度报道质量高，适合宏观、金融市场和产业风险判断。
- 东方财富 quote JSON：解析股票简称，并提供本土行情快照，帮助报告识别 A 股真实标的、涨跌幅、成交额、换手率、市值等。
- 东方财富公告 API：补充上市公司公告、投资者关系活动、担保/股权变更等正式披露。
- 东方财富文章搜索：补充东方财富站内聚合的证券时报、上海证券报、Choice 数据等个股新闻。
- 东方财富股吧：作为低权重社区情绪源尝试抓取。若接口返回繁忙、空列表或被限制，报告会保留 fetch note，不把静默误读成无情绪。
- 雪球搜索：作为低权重社区情绪源尝试抓取。雪球常有 WAF/登录态限制，失败时降级为 fetch note。
- 同花顺搜索：作为低权重本土财经搜索源尝试抓取。当前同花顺问财多数页面为 JS 渲染，无法解析时降级为 fetch note。

社区源默认开启，但在报告提示中明确降低权重。权威媒体、交易所/公司公告和结构化行情快照优先级高；股吧、雪球、同花顺等来源主要用于捕捉本土关注度和叙事方向，不作为事实依据单独支撑交易结论。

## 开关

- `TRADINGAGENTS_CHINA_NEWS_ENABLED=0`：完全关闭扩展。
- `TRADINGAGENTS_CHINA_NEWS_FORCE=1`：非 A 股/港股也强制使用国内新闻源优先。
- `TRADINGAGENTS_CHINA_NEWS_LIMIT=16`：个股新闻最大条数。
- `TRADINGAGENTS_CHINA_GLOBAL_NEWS_LIMIT=12`：宏观新闻最大条数。
- `TRADINGAGENTS_CHINA_NEWS_NAME_LOOKUP=0`：关闭东方财富股票简称解析。
- `TRADINGAGENTS_CHINA_LOCAL_SOURCES_ENABLED=0`：关闭东方财富公告/文章/股吧、雪球、同花顺等本土个股扩展源，仅保留 RSS。
- `TRADINGAGENTS_CHINA_ANN_LIMIT=8`：东方财富公告最大条数。
- `TRADINGAGENTS_CHINA_EASTMONEY_ARTICLE_LIMIT=8`：东方财富文章搜索最大条数。
- `TRADINGAGENTS_CHINA_GUBA_LIMIT=8`：东方财富股吧最大条数。
- `TRADINGAGENTS_CHINA_XUEQIU_LIMIT=8`：雪球搜索最大条数。
- `TRADINGAGENTS_CHINA_THS_LIMIT=5`：同花顺搜索最大条数。
