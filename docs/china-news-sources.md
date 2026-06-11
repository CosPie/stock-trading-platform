# 国内新闻源扩展

目标：在不改动 `third_party/tradingagents` 上游源码的前提下，为 A 股、港股和中文市场分析补充国内新闻来源。

## 集成方式

外层启动脚本 `scripts/run_tradingagents.py` 会加载 `extensions/tradingagents_china_news`。扩展在运行时向 TradingAgents 的 vendor 路由注册 `china_finance`，并且仅在目标代码看起来是 A 股/港股时把 `news_data` 调整为：

```text
china_finance,yfinance
```

这样 `third_party/tradingagents` 仍可继续从上游 `git pull`。如果上游更新了默认 vendor，扩展也只是在运行时排到新闻 vendor 链最前面，失败后仍回退到上游来源。

## 当前来源选择

- 新浪财经 RSS：覆盖面广，适合做 A 股和中文宏观的快速 headline 层。
- 上海证券报 RSS：证券市场信息密度高，更适合 A 股个股、政策与市场制度变化。
- 中国证券报 RSS：偏权威媒体口径，适合交叉验证监管、海外市场和大类资产信息。
- 财新 RSS：原创和深度报道质量高，适合宏观、金融市场和产业风险判断。
- 东方财富 quote JSON：只用于把六位 A 股代码解析成股票简称，帮助 RSS 标题匹配；不把行情数据混入新闻判断。

没有默认接入股吧/雪球抓取。原因是这类页面反爬、登录态和噪声更重，直接抓取会让运行稳定性和合规风险变差。当前实现先用权威/主流财经源补齐新闻分析；如果后续要增加社区情绪，建议单独加可开关的来源并在报告里降低权重。

## 开关

- `TRADINGAGENTS_CHINA_NEWS_ENABLED=0`：完全关闭扩展。
- `TRADINGAGENTS_CHINA_NEWS_FORCE=1`：非 A 股/港股也强制使用国内新闻源优先。
- `TRADINGAGENTS_CHINA_NEWS_LIMIT=16`：个股新闻最大条数。
- `TRADINGAGENTS_CHINA_GLOBAL_NEWS_LIMIT=12`：宏观新闻最大条数。
- `TRADINGAGENTS_CHINA_NEWS_NAME_LOOKUP=0`：关闭东方财富股票简称解析。
