package jobs

import "testing"

func TestDepthProfile(t *testing.T) {
	tests := []struct {
		name       string
		depth      string
		wantLabel  string
		wantRounds int
		wantMode   string
	}{
		{name: "default shallow", depth: "", wantLabel: "浅度", wantRounds: 1, wantMode: "report"},
		{name: "medium", depth: "medium", wantLabel: "中度", wantRounds: 3, wantMode: "report"},
		{name: "deep Chinese", depth: "深度", wantLabel: "深度", wantRounds: 5, wantMode: "report"},
		{name: "intraday", depth: "intraday", wantLabel: "日内", wantRounds: 1, wantMode: "intraday"},
		{name: "intraday Chinese", depth: "日内", wantLabel: "日内", wantRounds: 1, wantMode: "intraday"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotLabel, gotRounds, gotMode := depthProfile(tt.depth)
			if gotLabel != tt.wantLabel || gotRounds != tt.wantRounds || gotMode != tt.wantMode {
				t.Fatalf("depthProfile(%q) = (%q, %d, %q), want (%q, %d, %q)", tt.depth, gotLabel, gotRounds, gotMode, tt.wantLabel, tt.wantRounds, tt.wantMode)
			}
		})
	}
}

func TestNormalizeTickerAddsChinaExchangeSuffix(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "002428", want: "002428.SZ"},
		{input: "600519", want: "600519.SS"},
		{input: "688981", want: "688981.SS"},
		{input: "300750", want: "300750.SZ"},
		{input: "830799", want: "830799.BJ"},
		{input: "600519.SH", want: "600519.SS"},
		{input: "0700.HK", want: "0700.HK"},
		{input: "aapl", want: "AAPL"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := normalizeTicker(tt.input); got != tt.want {
				t.Fatalf("normalizeTicker(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
