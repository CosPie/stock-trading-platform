package jobs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"stock-trading-platform/internal/storage"
	"stock-trading-platform/internal/trading"
)

type StartRequest struct {
	Ticker   string `json:"ticker"`
	Depth    string `json:"depth"`
	Date     string `json:"date"`
	ReportID string `json:"reportId"`
}

type Manager struct {
	mu          sync.Mutex
	store       *storage.Store
	runner      *trading.Runner
	slots       chan struct{}
	subscribers map[string]map[chan storage.Event]struct{}
}

func NewManager(store *storage.Store, runner *trading.Runner) *Manager {
	return &Manager{
		store:       store,
		runner:      runner,
		slots:       make(chan struct{}, maxConcurrentAnalyses()),
		subscribers: make(map[string]map[chan storage.Event]struct{}),
	}
}

func (m *Manager) Start(ctx context.Context, req StartRequest) (storage.Report, error) {
	var retryReport storage.Report
	retrying := strings.TrimSpace(req.ReportID) != ""
	if retrying {
		found, ok := m.store.Report(strings.TrimSpace(req.ReportID))
		if !ok {
			return storage.Report{}, fmt.Errorf("要重新分析的历史报告不存在")
		}
		retryReport = found
		if strings.TrimSpace(req.Ticker) == "" {
			req.Ticker = retryReport.Ticker
		}
		if strings.TrimSpace(req.Depth) == "" {
			req.Depth = retryReport.Depth
		}
		if strings.TrimSpace(req.Date) == "" {
			req.Date = retryReport.AnalysisDate
		}
	}

	ticker := normalizeTicker(req.Ticker)
	if ticker == "" {
		return storage.Report{}, fmt.Errorf("请输入股票代码")
	}
	if !validTicker(ticker) {
		return storage.Report{}, fmt.Errorf("股票代码只能包含字母、数字、点、横线、下划线和 ^")
	}

	depthLabel, rounds, analysisMode := depthProfile(req.Depth)
	analysisDate := strings.TrimSpace(req.Date)
	if analysisDate == "" {
		analysisDate = time.Now().Format("2006-01-02")
	}

	now := time.Now()
	id := fmt.Sprintf("%s-%s", now.Format("20060102150405"), sanitizeID(ticker))
	createdAt := now
	if retrying {
		id = retryReport.ID
		createdAt = retryReport.CreatedAt
	}
	report := storage.Report{
		ID:           id,
		Ticker:       ticker,
		AnalysisDate: analysisDate,
		Depth:        depthLabel,
		DepthRounds:  rounds,
		Status:       "running",
		CreatedAt:    createdAt,
		UpdatedAt:    now,
		Logs:         nil,
	}
	if err := m.store.UpsertReport(report); err != nil {
		return storage.Report{}, err
	}

	settings := m.store.Settings()
	taskLabel := "分析任务"
	if analysisMode == "intraday" {
		taskLabel = "日内交易分析任务"
	}
	m.emit(id, newEvent(id, "queued", "准备", taskLabel+"已创建，正在启动 TradingAgents", map[string]interface{}{"analysis_mode": analysisMode}))

	go m.run(context.Background(), report, settings)
	return report, nil
}

func (m *Manager) Subscribe(jobID string) ([]storage.Event, <-chan storage.Event, func(), bool) {
	m.MarkStaleAnalyses()

	report, ok := m.store.Report(jobID)
	if !ok {
		return nil, nil, nil, false
	}

	ch := make(chan storage.Event, 64)
	m.mu.Lock()
	if m.subscribers[jobID] == nil {
		m.subscribers[jobID] = make(map[chan storage.Event]struct{})
	}
	m.subscribers[jobID][ch] = struct{}{}
	m.mu.Unlock()

	cancel := func() {
		m.mu.Lock()
		if subs := m.subscribers[jobID]; subs != nil {
			delete(subs, ch)
			if len(subs) == 0 {
				delete(m.subscribers, jobID)
			}
		}
		m.mu.Unlock()
		close(ch)
	}
	return report.Logs, ch, cancel, true
}

func (m *Manager) run(ctx context.Context, report storage.Report, settings storage.Settings) {
	startedAt := time.Now()
	timeout := analysisTimeout()
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	select {
	case m.slots <- struct{}{}:
		defer func() { <-m.slots }()
		m.emit(report.ID, newEvent(report.ID, "stage", "运行环境", "已获得分析执行资源，启动 TradingAgents", nil))
	case <-runCtx.Done():
		msg := runCtx.Err().Error()
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			msg = analysisTimeoutMessage(timeout)
		}
		_, _ = m.store.UpdateReport(report.ID, func(r *storage.Report) {
			r.Status = "error"
			r.Error = msg
			r.DurationSeconds = int64(time.Since(startedAt).Seconds())
		})
		m.emit(report.ID, newEvent(report.ID, "error", "失败", msg, nil))
		return
	}

	start := time.Now()
	req := trading.RunRequest{
		JobID:        report.ID,
		Ticker:       report.Ticker,
		Date:         report.AnalysisDate,
		DepthRounds:  report.DepthRounds,
		AnalysisMode: analysisModeFromDepthLabel(report.Depth),
		Settings:     settings,
	}

	result, err := m.runner.Run(runCtx, req, func(event storage.Event) {
		if event.JobID == "" {
			event.JobID = report.ID
		}
		if event.ID == 0 {
			event.ID = time.Now().UnixNano()
		}
		m.emit(report.ID, event)
	})

	if err != nil {
		msg := err.Error()
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			msg = analysisTimeoutMessage(timeout)
		}
		_, _ = m.store.UpdateReport(report.ID, func(r *storage.Report) {
			r.Status = "error"
			r.Error = msg
			r.DurationSeconds = int64(time.Since(start).Seconds())
		})
		m.emit(report.ID, newEvent(report.ID, "error", "失败", msg, nil))
		return
	}

	_, _ = m.store.UpdateReport(report.ID, func(r *storage.Report) {
		r.Status = "complete"
		r.Decision = result.Decision
		r.Summary = result.Summary
		r.ReportMarkdown = result.ReportMarkdown
		r.DurationSeconds = int64(time.Since(start).Seconds())
	})
	m.emit(report.ID, newEvent(report.ID, "complete", "完成", "分析完成，报告已保存", map[string]interface{}{"decision": result.Decision}))
}

func (m *Manager) MarkStaleAnalyses() {
	timeout := analysisTimeout()
	cutoff := time.Now().Add(-timeout)
	msg := analysisTimeoutMessage(timeout)
	for _, report := range m.store.Reports("") {
		if report.Status != "running" || report.UpdatedAt.After(cutoff) {
			continue
		}
		updated, err := m.store.UpdateReport(report.ID, func(r *storage.Report) {
			if r.Status != "running" {
				return
			}
			r.Status = "error"
			r.Error = msg
			if r.DurationSeconds == 0 {
				r.DurationSeconds = int64(time.Since(r.CreatedAt).Seconds())
			}
		})
		if err == nil && updated.Status == "error" && updated.Error == msg {
			m.emit(report.ID, newEvent(report.ID, "error", "失败", msg, nil))
		}
	}
}

func (m *Manager) emit(jobID string, event storage.Event) {
	if event.ID == 0 {
		event.ID = eventSeq.Add(1)
	}
	if event.At.IsZero() {
		event.At = time.Now()
	}
	_ = m.store.AppendEvent(jobID, event)

	m.mu.Lock()
	defer m.mu.Unlock()
	for ch := range m.subscribers[jobID] {
		select {
		case ch <- event:
		default:
		}
	}
}

func normalizeTicker(ticker string) string {
	return strings.ToUpper(strings.TrimSpace(ticker))
}

func validTicker(ticker string) bool {
	return regexp.MustCompile(`^[A-Z0-9._\-\^]{1,32}$`).MatchString(ticker)
}

func depthProfile(depth string) (string, int, string) {
	switch strings.ToLower(strings.TrimSpace(depth)) {
	case "intraday", "daytrade", "day-trade", "日内":
		return "日内", 1, "intraday"
	case "medium", "中度":
		return "中度", 3, "report"
	case "deep", "depth", "深度":
		return "深度", 5, "report"
	default:
		return "浅度", 1, "report"
	}
}

func analysisModeFromDepthLabel(depth string) string {
	_, _, mode := depthProfile(depth)
	return mode
}

func sanitizeID(value string) string {
	replacer := strings.NewReplacer(".", "-", "_", "-", "^", "idx")
	return strings.ToLower(replacer.Replace(value))
}

func maxConcurrentAnalyses() int {
	value := strings.TrimSpace(os.Getenv("APP_MAX_CONCURRENT_ANALYSES"))
	if value == "" {
		return 2
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 {
		return 1
	}
	return n
}

func analysisTimeout() time.Duration {
	value := strings.TrimSpace(os.Getenv("APP_ANALYSIS_TIMEOUT"))
	if value == "" {
		return time.Hour
	}
	timeout, err := time.ParseDuration(value)
	if err != nil || timeout <= 0 {
		return time.Hour
	}
	return timeout
}

func analysisTimeoutMessage(timeout time.Duration) string {
	if timeout%time.Hour == 0 {
		hours := int(timeout / time.Hour)
		return fmt.Sprintf("分析超过 %d 小时仍未完成，已自动标记为失败。", hours)
	}
	if timeout%time.Minute == 0 {
		minutes := int(timeout / time.Minute)
		return fmt.Sprintf("分析超过 %d 分钟仍未完成，已自动标记为失败。", minutes)
	}
	return fmt.Sprintf("分析超过 %d 秒仍未完成，已自动标记为失败。", int(timeout/time.Second))
}
