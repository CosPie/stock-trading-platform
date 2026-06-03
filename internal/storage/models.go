package storage

import "time"

type Settings struct {
	LLM          LLMSettings `json:"llm"`
	Runtime      Runtime     `json:"runtime"`
	Interface    Interface   `json:"interface"`
	LastModified time.Time   `json:"lastModified"`
}

type LLMSettings struct {
	Provider    string  `json:"provider"`
	APIKey      string  `json:"apiKey"`
	QuickModel  string  `json:"quickModel"`
	DeepModel   string  `json:"deepModel"`
	BackendURL  string  `json:"backendUrl"`
	Temperature *string `json:"temperature"`
}

type Runtime struct {
	PythonPath       string `json:"pythonPath"`
	TradingAgentsDir string `json:"tradingAgentsDir"`
	ResultsDir       string `json:"resultsDir"`
}

type Interface struct {
	LargeText bool `json:"largeText"`
}

type Report struct {
	ID               string     `json:"id"`
	Ticker           string     `json:"ticker"`
	AnalysisDate     string     `json:"analysisDate"`
	Depth            string     `json:"depth"`
	DepthRounds      int        `json:"depthRounds"`
	Status           string     `json:"status"`
	Decision         string     `json:"decision"`
	Summary          string     `json:"summary"`
	ReportMarkdown   string     `json:"reportMarkdown"`
	BriefHTML        string     `json:"briefHtml"`
	BriefGeneratedAt *time.Time `json:"briefGeneratedAt,omitempty"`
	Error            string     `json:"error"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
	DurationSeconds  int64      `json:"durationSeconds"`
	Logs             []Event    `json:"logs"`
}

type Event struct {
	ID      int64                  `json:"id"`
	JobID   string                 `json:"jobId"`
	Type    string                 `json:"type"`
	Stage   string                 `json:"stage"`
	Message string                 `json:"message"`
	At      time.Time              `json:"at"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

type AppState struct {
	Settings Settings `json:"settings"`
	Reports  []Report `json:"reports"`
}
