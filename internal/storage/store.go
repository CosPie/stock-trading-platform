package storage

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Store struct {
	mu    sync.Mutex
	path  string
	root  string
	state AppState
}

func Open(path string, root string) (*Store, error) {
	store := &Store{path: path, root: root}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}

	if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
		if err := json.Unmarshal(data, &store.state); err != nil {
			return nil, err
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	if store.state.Settings.LLM.Provider == "" {
		store.state.Settings = DefaultSettings(root)
	}
	applyEnvDefaults(&store.state.Settings, root)
	return store, store.saveLocked()
}

func DefaultSettings(root string) Settings {
	now := time.Now()
	return Settings{
		LLM: LLMSettings{
			Provider:   "deepseek",
			QuickModel: "deepseek-v4-flash",
			DeepModel:  "deepseek-v4-pro",
			BackendURL: "https://api.deepseek.com",
		},
		Runtime: Runtime{
			PythonPath:       defaultPythonPath(root),
			TradingAgentsDir: filepath.Join(root, "third_party", "tradingagents"),
			ResultsDir:       filepath.Join(root, "data", "runtime", "tradingagents-results"),
		},
		Interface:    Interface{LargeText: true},
		LastModified: now,
	}
}

func defaultPythonPath(root string) string {
	candidates := []string{
		filepath.Join(root, ".venv", "bin", "python"),
		"/opt/venv/bin/python",
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "python3"
}

func applyEnvDefaults(settings *Settings, root string) {
	if settings.LLM.APIKey == "" {
		if key := os.Getenv("DEEPSEEK_API_KEY"); key != "" {
			settings.LLM.APIKey = key
		}
	}
	if settings.Runtime.PythonPath == "" || settings.Runtime.PythonPath == "python3" {
		settings.Runtime.PythonPath = defaultPythonPath(root)
	}
}

func (s *Store) Settings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.Settings
}

func (s *Store) SaveSettings(settings Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	settings.LastModified = time.Now()
	if settings.LLM.Provider == "" {
		settings.LLM.Provider = "deepseek"
	}
	if settings.LLM.QuickModel == "" {
		settings.LLM.QuickModel = "deepseek-v4-flash"
	}
	if settings.LLM.DeepModel == "" {
		settings.LLM.DeepModel = "deepseek-v4-pro"
	}
	if settings.Runtime.PythonPath == "" {
		settings.Runtime.PythonPath = defaultPythonPath(s.root)
	}
	if settings.Runtime.TradingAgentsDir == "" {
		settings.Runtime.TradingAgentsDir = filepath.Join(s.root, "third_party", "tradingagents")
	}
	if settings.Runtime.ResultsDir == "" {
		settings.Runtime.ResultsDir = filepath.Join(s.root, "data", "runtime", "tradingagents-results")
	}
	s.state.Settings = settings
	return s.saveLocked()
}

func (s *Store) UpsertReport(report Report) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	report.UpdatedAt = time.Now()
	for i := range s.state.Reports {
		if s.state.Reports[i].ID == report.ID {
			s.state.Reports[i] = report
			return s.saveLocked()
		}
	}
	s.state.Reports = append(s.state.Reports, report)
	return s.saveLocked()
}

func (s *Store) UpdateReport(id string, update func(*Report)) (Report, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Reports {
		if s.state.Reports[i].ID == id {
			update(&s.state.Reports[i])
			s.state.Reports[i].UpdatedAt = time.Now()
			report := s.state.Reports[i]
			return report, s.saveLocked()
		}
	}
	return Report{}, os.ErrNotExist
}

func (s *Store) AppendEvent(id string, event Event) error {
	_, err := s.UpdateReport(id, func(report *Report) {
		report.Logs = append(report.Logs, event)
	})
	return err
}

func (s *Store) Report(id string) (Report, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, report := range s.state.Reports {
		if report.ID == id {
			return report, true
		}
	}
	return Report{}, false
}

func (s *Store) DeleteReport(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Reports {
		if s.state.Reports[i].ID == id {
			s.state.Reports = append(s.state.Reports[:i], s.state.Reports[i+1:]...)
			return s.saveLocked()
		}
	}
	return os.ErrNotExist
}

func (s *Store) Reports(query string) []Report {
	s.mu.Lock()
	defer s.mu.Unlock()
	query = strings.ToUpper(strings.TrimSpace(query))
	reports := make([]Report, 0, len(s.state.Reports))
	for _, report := range s.state.Reports {
		if query == "" ||
			strings.Contains(strings.ToUpper(report.Ticker), query) ||
			strings.Contains(report.AnalysisDate, query) {
			copyReport := report
			copyReport.Logs = nil
			reports = append(reports, copyReport)
		}
	}
	sort.Slice(reports, func(i, j int) bool {
		return reports[i].CreatedAt.After(reports[j].CreatedAt)
	})
	return reports
}

func (s *Store) saveLocked() error {
	tmp := s.path + ".tmp"
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
