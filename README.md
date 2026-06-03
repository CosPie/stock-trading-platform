# TradingAgents WebUI

一个面向中文散户用户的极简 WebUI，用来输入股票 ticker symbol 并调用 `tauricresearch/tradingagents` 进行多智能体分析。

## 功能

- 输入股票代码后启动 TradingAgents 分析
- 支持浅度、中度、深度三档分析深度
- 使用 TradingAgents 内置角色流程，不在页面暴露角色配置
- 实时显示 agent 进度和运行日志
- 左侧历史报告搜索和回看
- 左下角设置入口，保存 DeepSeek API Key 和模型配置
- 默认模型：
  - `deepseek-v4-flash`
  - `deepseek-v4-pro`

## 技术栈

- Go + Fiber v3
- 原生 HTML/CSS/JavaScript
- Python bridge 调用 `third_party/tradingagents`
- 本地 JSON 文件保存设置和历史报告

## 初始化 TradingAgents Python 环境

TradingAgents 已作为 git submodule 放在：

```bash
third_party/tradingagents
```

安装依赖：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e third_party/tradingagents
```

如果你使用 conda，建议按 TradingAgents README 使用 Python 3.13 环境。

安装完成后，WebUI 的“设置 -> 运行路径 -> Python 命令”建议填写：

```text
/Users/lili/Documents/Code/stock-trading-platform/.venv/bin/python
```

如果运行日志提示缺少 `yfinance` 或其他 Python 包，说明当前 WebUI 使用的不是这个虚拟环境。

如果运行日志出现 `curl: (35) TLS connect error ... OPENSSL_internal:invalid library`，WebUI 默认会给 TradingAgents 子进程设置 `YF_DISABLE_CURL_CFFI=1`，绕开 yfinance 的 `curl_cffi` TLS 路径。这个问题常见于 yfinance/curl_cffi 与本机 TLS/代理环境不兼容。AAPL、SPY 已验证可通过 fallback 读取；如果某个 ticker 仍出现 Yahoo 401/Invalid Crumb，通常是 Yahoo 对该 ticker 的接口响应或访问限制问题。

## 运行 WebUI

当前机器需要先安装 Go。安装后执行：

```bash
go mod tidy
go mod download
go run ./cmd/server
```

默认访问：

```text
http://localhost:8080
```

也可以指定监听地址：

```bash
APP_ADDR=:3000 go run ./cmd/server
```

如果看到 `missing go.sum entry for module providing package github.com/gofiber/fiber/v3`，说明 Go 依赖校验文件还没补完整。先执行：

```bash
go mod tidy
```

然后再执行：

```bash
go run ./cmd/server
```

## 更新 TradingAgents 子模块

```bash
git submodule update --remote third_party/tradingagents
```

## 数据保存

- WebUI 设置和 API Key 保存在 `data/app_state.json`
- TradingAgents 运行结果保存在 `data/runtime/tradingagents-results`

这是按可信内网环境设计的，无鉴权，不适合直接暴露到公网。

## 免责声明

页面和报告均仅供研究参考，不构成投资建议。
