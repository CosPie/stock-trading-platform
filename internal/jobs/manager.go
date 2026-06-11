package jobs

import (
	"context"
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

	depthLabel, rounds := depthRounds(req.Depth)
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
	m.emit(id, newEvent(id, "queued", "准备", "分析任务已创建，正在启动 TradingAgents", nil))

	go m.run(context.Background(), report, settings)
	return report, nil
}

func (m *Manager) Subscribe(jobID string) ([]storage.Event, <-chan storage.Event, func(), bool) {
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
	select {
	case m.slots <- struct{}{}:
		defer func() { <-m.slots }()
		m.emit(report.ID, newEvent(report.ID, "stage", "运行环境", "已获得分析执行资源，启动 TradingAgents", nil))
	case <-ctx.Done():
		_, _ = m.store.UpdateReport(report.ID, func(r *storage.Report) {
			r.Status = "error"
			r.Error = ctx.Err().Error()
		})
		m.emit(report.ID, newEvent(report.ID, "error", "失败", ctx.Err().Error(), nil))
		return
	}

	start := time.Now()
	req := trading.RunRequest{
		JobID:       report.ID,
		Ticker:      report.Ticker,
		Date:        report.AnalysisDate,
		DepthRounds: report.DepthRounds,
		Settings:    settings,
	}

	result, err := m.runner.Run(ctx, req, func(event storage.Event) {
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

func depthRounds(depth string) (string, int) {
	switch strings.ToLower(strings.TrimSpace(depth)) {
	case "medium", "中度":
		return "中度", 3
	case "deep", "depth", "深度":
		return "深度", 5
	default:
		return "浅度", 1
	}
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
