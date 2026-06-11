#!/usr/bin/env python3
import argparse
import json
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

os.environ.setdefault("YF_DISABLE_CURL_CFFI", "1")

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

try:
    import requests as _plain_requests

    if not hasattr(_plain_requests.exceptions, "DNSError"):
        _plain_requests.exceptions.DNSError = _plain_requests.exceptions.ConnectionError
except Exception:
    pass

REPORT_STAGES = {
    "market_report": "市场分析",
    "sentiment_report": "情绪分析",
    "news_report": "新闻分析",
    "fundamentals_report": "基本面分析",
    "investment_plan": "研究团队",
    "trader_investment_plan": "交易员",
    "final_trade_decision": "组合经理",
}


def emit(event_type, stage="", message="", **extra):
    payload = {
        "type": event_type,
        "stage": stage,
        "message": message,
    }
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False, default=str), flush=True)


def detect_asset_type(ticker):
    normalized = ticker.strip().upper()
    if normalized.endswith(("-USD", "-USDT", "-USDC", "-BTC", "-ETH")):
        return "crypto"
    return "stock"


def selected_analysts(asset_type):
    analysts = ["market", "social", "news", "fundamentals"]
    if asset_type == "crypto":
        analysts.remove("fundamentals")
    return analysts


def message_text(message):
    content = getattr(message, "content", None)
    if content is None and isinstance(message, (tuple, list)) and len(message) >= 2:
        content = message[1]
    if content is None:
        content = str(message)
    if isinstance(content, list):
        content = " ".join(str(item) for item in content)
    return str(content).strip()


def first_text(value):
    if isinstance(value, dict):
        for key in ("judge_decision", "history", "bull_history", "bear_history"):
            if value.get(key):
                return str(value[key])
    return str(value or "")


def build_report_markdown(ticker, date, final_state, decision):
    sections = [
        f"# {ticker} 股票分析报告",
        f"分析日期：{date}",
        "",
        "> 仅供研究参考，不构成投资建议。",
        "",
        "## 综合结论",
        str(decision or final_state.get("final_trade_decision", "")).strip(),
    ]

    ordered = [
        ("市场分析", final_state.get("market_report")),
        ("情绪分析", final_state.get("sentiment_report")),
        ("新闻分析", final_state.get("news_report")),
        ("基本面分析", final_state.get("fundamentals_report")),
        ("研究团队", first_text(final_state.get("investment_debate_state"))),
        ("交易员计划", final_state.get("trader_investment_plan")),
        ("风控团队", first_text(final_state.get("risk_debate_state"))),
        ("最终决策", final_state.get("final_trade_decision")),
    ]
    for title, content in ordered:
        text = str(content or "").strip()
        if not text:
            continue
        sections.extend(["", f"## {title}", text])
    return "\n".join(sections).strip() + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--depth-rounds", type=int, required=True)
    parser.add_argument("--provider", default="deepseek")
    parser.add_argument("--quick-model", default="deepseek-v4-flash")
    parser.add_argument("--deep-model", default="deepseek-v4-pro")
    parser.add_argument("--backend-url", default="")
    parser.add_argument("--temperature", default="")
    parser.add_argument("--tradingagents-path", required=True)
    parser.add_argument("--results-dir", required=True)
    parser.add_argument("--output-language", default="Simplified Chinese")
    args = parser.parse_args()

    sys.path.insert(0, args.tradingagents_path)

    try:
        from tradingagents.default_config import DEFAULT_CONFIG
        from tradingagents.graph.trading_graph import TradingAgentsGraph
    except Exception as exc:
        if isinstance(exc, ModuleNotFoundError):
            missing = getattr(exc, "name", "") or str(exc)
            message = (
                f"缺少 Python 包：{missing}。请安装 TradingAgents 依赖："
                "python3 -m venv .venv；source .venv/bin/activate；"
                "pip install -e third_party/tradingagents。"
                "安装后在设置里把 Python 命令改为 .venv/bin/python，或重启服务前设置好运行路径。"
            )
        else:
            message = (
                "无法导入 TradingAgents。请确认 third_party/tradingagents 子模块存在，"
                "并已安装 Python 依赖：pip install -e third_party/tradingagents"
            )
        emit(
            "error",
            "Python 环境",
            message,
            payload={"error": str(exc), "traceback": traceback.format_exc()},
        )
        return 2

    if args.provider == "deepseek" and not os.environ.get("DEEPSEEK_API_KEY"):
        emit("error", "LLM 设置", "DeepSeek API Key 为空，请先在设置中保存 API Key")
        return 2

    try:
        config = DEFAULT_CONFIG.copy()
        config["llm_provider"] = args.provider
        config["quick_think_llm"] = args.quick_model
        config["deep_think_llm"] = args.deep_model
        config["backend_url"] = args.backend_url or None
        config["max_debate_rounds"] = args.depth_rounds
        config["max_risk_discuss_rounds"] = args.depth_rounds
        config["results_dir"] = args.results_dir
        config["output_language"] = args.output_language
        config["checkpoint_enabled"] = False
        if args.temperature:
            config["temperature"] = float(args.temperature)

        asset_type = detect_asset_type(args.ticker)
        try:
            from extensions.tradingagents_china_news import install_china_news_extension

            config = install_china_news_extension(config, args.ticker)
        except Exception as exc:
            emit(
                "log",
                "国内新闻源",
                f"国内新闻源扩展未启用，继续使用 TradingAgents 默认新闻源：{exc}",
            )

        analysts = selected_analysts(asset_type)
        emit(
            "start",
            "准备",
            f"启动 TradingAgents：{args.ticker}，深度轮数 {args.depth_rounds}",
            payload={"analysts": analysts, "asset_type": asset_type},
        )

        graph = TradingAgentsGraph(selected_analysts=analysts, debug=True, config=config)
        graph.ticker = args.ticker
        graph._resolve_pending_entries(args.ticker)

        past_context = graph.memory_log.get_past_context(args.ticker)
        instrument_context = graph.resolve_instrument_context(args.ticker, asset_type)
        init_state = graph.propagator.create_initial_state(
            args.ticker,
            args.date,
            asset_type=asset_type,
            past_context=past_context,
            instrument_context=instrument_context,
        )
        graph_args = graph.propagator.get_graph_args()

        final_state = {}
        completed = set()
        emit("stage", "市场分析", "分析师团队开始读取行情、新闻和基本面数据")
        for chunk in graph.graph.stream(init_state, **graph_args):
            if not isinstance(chunk, dict):
                continue
            final_state.update(chunk)

            messages = chunk.get("messages") or []
            if messages:
                text = message_text(messages[-1])
                if text:
                    emit("log", "Agent 输出", text[:1200])

            for key, stage in REPORT_STAGES.items():
                value = final_state.get(key)
                if value and key not in completed:
                    completed.add(key)
                    emit("stage", stage, f"{stage} 已完成", payload={"report_key": key})

            risk = final_state.get("risk_debate_state") or {}
            if isinstance(risk, dict) and risk.get("judge_decision") and "risk_done" not in completed:
                completed.add("risk_done")
                emit("stage", "风控团队", "风控团队已完成风险讨论")

        if not final_state.get("final_trade_decision"):
            raise RuntimeError("TradingAgents 没有生成 final_trade_decision")

        graph.curr_state = final_state
        graph._log_state(args.date, final_state)
        graph.memory_log.store_decision(
            ticker=args.ticker,
            trade_date=args.date,
            final_trade_decision=final_state["final_trade_decision"],
        )
        decision = graph.process_signal(final_state["final_trade_decision"])
        report = build_report_markdown(args.ticker, args.date, final_state, decision)
        summary = str(decision or final_state["final_trade_decision"]).strip()

        emit(
            "complete",
            "完成",
            "TradingAgents 分析完成",
            decision=str(decision),
            summary=summary[:500],
            report_markdown=report,
        )
        return 0
    except Exception as exc:
        emit(
            "error",
            "运行失败",
            str(exc),
            payload={"traceback": traceback.format_exc(), "time": datetime.now().isoformat()},
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
