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

