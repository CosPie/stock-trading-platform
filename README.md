# TradingAgents WebUI

一个面向中文散户用户的极简 WebUI，用来输入股票 ticker symbol 并调用 `tauricresearch/tradingagents` 进行多智能体分析。

## 功能

- 输入股票代码后启动 TradingAgents 分析
- 支持浅度、中度、深度三档分析深度
- 使用 TradingAgents 内置角色流程，不在页面暴露角色配置
- 实时显示 agent 进度和运行日志
- 左侧历史报告搜索和回看
- 左下角设置入口，可在官方 DeepSeek 与本地 37 Provider 间切换
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
http://localhost:16666
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

## Docker 部署

项目根目录已提供 `Dockerfile` 与 `docker-compose.yml`，镜像内同时包含 Go WebUI 与 TradingAgents Python 环境。

### 前置条件

克隆仓库时需要带上 submodule：

```bash
git clone --recurse-submodules <repo-url>
cd stock-trading-platform
```

如果已经克隆过，可执行：

```bash
git submodule update --init --recursive
```

### 本地 Docker Compose

复制环境变量示例并填写 DeepSeek Key：

```bash
cp .env.example .env
# 编辑 .env，设置 DEEPSEEK_API_KEY
docker compose up -d --build
```

默认访问：

```text
http://localhost:16666
```

数据会持久化到 Docker volume `app-data`（挂载到容器内 `/app/data`）。

### Coolify 部署

1. 在 Coolify 新建 **Application**，选择 Git 仓库部署
2. 构建方式选 **Dockerfile**，路径填 `./Dockerfile`
3. 暴露端口设为 `16666`（Coolify 会自动注入 `PORT`，服务已兼容）
4. 挂载持久化卷到 `/app/data`，保存设置与历史报告
5. 在环境变量中配置：
   - `DEEPSEEK_API_KEY`：DeepSeek API Key（首次启动会自动写入本地设置）
   - 可选 `APP_ADDR`：监听地址，默认 `:16666`
6. 健康检查路径建议设为 `/api/health`

> 本服务无鉴权，部署到公网前请自行加反向代理认证或 VPN 访问控制。

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `APP_ADDR` | HTTP 监听地址 | `:16666` |
| `PORT` | Coolify 等平台注入的端口 | 未设置时使用 `16666` |
| `APP_DATA_DIR` | 数据目录 | `/app/data`（容器内） |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | 空（也可在 WebUI 设置页保存） |
| `ANTHROPIC_AUTH_TOKEN` | 本地 37 Provider 访问 token，可从 `~/.zshrc` 读取 | 空 |
| `ANTHROPIC_BASE_URL` | 本地 37 Provider API 地址，可从 `~/.zshrc` 读取 | 空 |

### 本地 37 Provider

设置页的 **LLM 模型** 可切换到“本地 37”。该模式使用模型 `deepseek-v4-pro`，不会使用保存的 DeepSeek API Key，而是从当前环境或 `~/.zshrc` 读取：

```bash
export ANTHROPIC_AUTH_TOKEN=...
export ANTHROPIC_BASE_URL=...
```

## 免责声明

页面和报告均仅供研究参考，不构成投资建议。
