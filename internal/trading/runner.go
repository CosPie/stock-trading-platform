package trading

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"stock-trading-platform/internal/storage"
)

type Runner struct {
	root string
}

type RunRequest struct {
	JobID       string
	Ticker      string
	Date        string
	DepthRounds int
	Settings    storage.Settings
}

type RunResult struct {
	Decision       string
	Summary        string
	ReportMarkdown string
}

type EmitFunc func(storage.Event)

type bridgeEvent struct {
	Type           string                 `json:"type"`
	Stage          string                 `json:"stage"`
	Message        string                 `json:"message"`
	Decision       string                 `json:"decision"`
	Summary        string                 `json:"summary"`
	ReportMarkdown string                 `json:"report_markdown"`
	Payload        map[string]interface{} `json:"payload"`
}

func NewRunner(root string) *Runner {
	return &Runner{root: root}
}

func (r *Runner) Run(ctx context.Context, req RunRequest, emit EmitFunc) (RunResult, error) {
	settings := req.Settings
	python := strings.TrimSpace(settings.Runtime.PythonPath)
	if python == "" {
		python = "python3"
	}
	bridge := filepath.Join(r.root, "scripts", "run_tradingagents.py")
	tradingAgentsDir := settings.Runtime.TradingAgentsDir
	if tradingAgentsDir == "" {
		tradingAgentsDir = filepath.Join(r.root, "third_party", "tradingagents")
	}
	resultsDir := settings.Runtime.ResultsDir
	if resultsDir == "" {
		resultsDir = filepath.Join(r.root, "data", "runtime", "tradingagents-results")
	}
	if err := os.MkdirAll(resultsDir, 0o755); err != nil {
		return RunResult{}, err
	}

	args := []string{
		bridge,
		"--ticker", req.Ticker,
		"--date", req.Date,
		"--depth-rounds", fmt.Sprintf("%d", req.DepthRounds),
		"--provider", settings.LLM.Provider,
		"--quick-model", settings.LLM.QuickModel,
		"--deep-model", settings.LLM.DeepModel,
		"--tradingagents-path", tradingAgentsDir,
		"--results-dir", resultsDir,
		"--output-language", "Simplified Chinese",
	}
	if settings.LLM.BackendURL != "" {
		args = append(args, "--backend-url", settings.LLM.BackendURL)
	}
	if settings.LLM.Temperature != nil && *settings.LLM.Temperature != "" {
		args = append(args, "--temperature", *settings.LLM.Temperature)
	}

	cmd := exec.CommandContext(ctx, python, args...)
	cmd.Dir = r.root
	cmd.Env = os.Environ()
	cmd.Env = append(cmd.Env,
		"PYTHONUNBUFFERED=1",
		"PYTHONPATH="+tradingAgentsDir,
		"YF_DISABLE_CURL_CFFI=1",
		"TRADINGAGENTS_LLM_PROVIDER="+settings.LLM.Provider,
		"TRADINGAGENTS_QUICK_THINK_LLM="+settings.LLM.QuickModel,
		"TRADINGAGENTS_DEEP_THINK_LLM="+settings.LLM.DeepModel,
		"TRADINGAGENTS_RESULTS_DIR="+resultsDir,
		"TRADINGAGENTS_OUTPUT_LANGUAGE=Simplified Chinese",
	)
	apiKey := strings.TrimSpace(settings.LLM.APIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY"))
	}
	if apiKey != "" {
		cmd.Env = append(cmd.Env, "DEEPSEEK_API_KEY="+apiKey)
	}
	if settings.LLM.BackendURL != "" {
		cmd.Env = append(cmd.Env, "TRADINGAGENTS_LLM_BACKEND_URL="+settings.LLM.BackendURL)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return RunResult{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return RunResult{}, err
	}
	if err := cmd.Start(); err != nil {
		return RunResult{}, err
	}

	var result RunResult
	var stderrLines []string
	var bridgeError string
	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var evt bridgeEvent
			if err := json.Unmarshal([]byte(line), &evt); err != nil {
				emit(newStorageEvent(req.JobID, "log", "运行日志", line, nil))
				continue
			}
			if evt.Payload == nil {
				evt.Payload = map[string]interface{}{}
			}
			emit(newStorageEvent(req.JobID, evt.Type, evt.Stage, evt.Message, evt.Payload))
			if evt.Type == "error" && evt.Message != "" {
				mu.Lock()
				bridgeError = evt.Message
				mu.Unlock()
			}
			if evt.Type == "complete" {
				mu.Lock()
				result.Decision = evt.Decision
				result.Summary = evt.Summary
				result.ReportMarkdown = evt.ReportMarkdown
				mu.Unlock()
			}
		}
	}()

	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			if strings.Contains(line, "curl_cffi not available; falling back to requests") {
				emit(newStorageEvent(req.JobID, "log", "数据源提示", "已使用备用行情连接方式读取 Yahoo Finance 数据", nil))
				continue
			}
			mu.Lock()
			stderrLines = append(stderrLines, line)
			mu.Unlock()
			emit(newStorageEvent(req.JobID, "log", "系统输出", line, nil))
		}
	}()

	waitErr := cmd.Wait()
	wg.Wait()
	if waitErr != nil {
		mu.Lock()
		detail := strings.Join(stderrLines, "\n")
		if bridgeError != "" {
			detail = bridgeError
		}
		mu.Unlock()
		if detail == "" {
			detail = waitErr.Error()
		}
		return RunResult{}, errors.New(detail)
	}
	if result.ReportMarkdown == "" {
		return RunResult{}, fmt.Errorf("TradingAgents 已结束，但没有返回报告内容")
	}
	return result, nil
}

func newStorageEvent(jobID string, typ string, stage string, message string, payload map[string]interface{}) storage.Event {
	return storage.Event{
		JobID:   jobID,
		Type:    typ,
		Stage:   stage,
		Message: message,
		Payload: payload,
	}
}
