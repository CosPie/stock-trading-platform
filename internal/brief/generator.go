package brief

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"stock-trading-platform/internal/storage"
)

type Generator struct {
	client *http.Client
}

func NewGenerator() *Generator {
	return &Generator{
		client: &http.Client{Timeout: 180 * time.Second},
	}
}

func (g *Generator) Generate(ctx context.Context, settings storage.Settings, report storage.Report) (string, error) {
	apiKey := strings.TrimSpace(settings.LLM.APIKey)
	if apiKey == "" {
		return "", fmt.Errorf("DeepSeek API Key 为空，请先在设置中保存 API Key")
	}
	if strings.TrimSpace(report.ReportMarkdown) == "" {
		return "", fmt.Errorf("原始报告为空，无法生成分析简报")
	}

	model := strings.TrimSpace(settings.LLM.DeepModel)
	if model == "" {
		model = "deepseek-v4-pro"
	}

	body := chatRequest{
		Model: model,
		Messages: []chatMessage{
			{
				Role: "system",
				Content: `你是给中国普通散户阅读的投资研究编辑。请用大白话、短句、清楚分区，把复杂的 TradingAgents 原始股票报告改写成一份可阅读的中文 HTML 分析简报。

要求：
- 只输出 HTML 片段，不要输出 Markdown，不要用代码围栏。
- 不要输出 script、外链 CSS、图片、iframe。
- 用内联 <style> 写简洁样式，白底、深色文字、大字号、清晰间距。
- 面向 50 岁以上投资小白，少用术语；必要术语必须解释。
- 必须保留免责声明：仅供研究参考，不构成投资建议。
- 结构包括：一句话结论、适合谁看、关键理由、主要风险、接下来观察什么、原始报告依据摘要。
- 如果原始报告缺数据或有错误，要如实说明，不要编造。`,
			},
			{
				Role: "user",
				Content: fmt.Sprintf("股票：%s\n分析日期：%s\n原始报告如下：\n\n%s",
					report.Ticker,
					report.AnalysisDate,
					trimReport(report.ReportMarkdown),
				),
			},
		},
		Temperature: 0.2,
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, chatURL(settings.LLM.BackendURL), bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := g.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("调用 DeepSeek 失败：%w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("DeepSeek 返回错误 %d：%s", resp.StatusCode, string(respBody))
	}

	var parsed chatResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("解析 DeepSeek 返回失败：%w", err)
	}
	if len(parsed.Choices) == 0 || strings.TrimSpace(parsed.Choices[0].Message.Content) == "" {
		return "", fmt.Errorf("DeepSeek 没有返回简报内容")
	}
	return sanitizeHTML(parsed.Choices[0].Message.Content), nil
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
}

func chatURL(base string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		base = "https://api.deepseek.com"
	}
	if strings.HasSuffix(base, "/chat/completions") {
		return base
	}
	if strings.HasSuffix(base, "/v1") {
		return base + "/chat/completions"
	}
	return base + "/chat/completions"
}

func trimReport(markdown string) string {
	const limit = 60000
	markdown = strings.TrimSpace(markdown)
	if len(markdown) <= limit {
		return markdown
	}
	return markdown[:limit] + "\n\n[原始报告过长，后续内容已截断用于生成简报。]"
}

func sanitizeHTML(html string) string {
	html = strings.TrimSpace(html)
	html = strings.TrimPrefix(html, "```html")
	html = strings.TrimPrefix(html, "```")
	html = strings.TrimSuffix(html, "```")
	html = regexp.MustCompile(`(?is)<script.*?>.*?</script>`).ReplaceAllString(html, "")
	html = regexp.MustCompile(`(?is)<iframe.*?>.*?</iframe>`).ReplaceAllString(html, "")
	html = regexp.MustCompile(`(?i)\son\w+\s*=\s*(['"]).*?\1`).ReplaceAllString(html, "")
	return strings.TrimSpace(html)
}
