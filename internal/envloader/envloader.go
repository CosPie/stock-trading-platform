package envloader

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
)

var (
	zshrcOnce sync.Once
	zshrcEnv  map[string]string
)

func Lookup(key string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return strings.TrimSpace(loadZshrc()[key])
}

func loadZshrc() map[string]string {
	zshrcOnce.Do(func() {
		zshrcEnv = map[string]string{}
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		data, err := os.ReadFile(filepath.Join(home, ".zshrc"))
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(data), "\n") {
			key, value, ok := parseAssignment(line)
			if ok {
				zshrcEnv[key] = value
			}
		}
	})
	return zshrcEnv
}

func parseAssignment(line string) (string, string, bool) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return "", "", false
	}
	line = strings.TrimPrefix(line, "export ")
	parts := strings.SplitN(line, "=", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	key := strings.TrimSpace(parts[0])
	if !validEnvKey(key) {
		return "", "", false
	}
	value := strings.TrimSpace(parts[1])
	if value == "" {
		return key, "", true
	}
	if quote := value[0]; quote == '\'' || quote == '"' {
		if end := strings.LastIndexByte(value[1:], quote); end >= 0 {
			return key, value[1 : end+1], true
		}
		return key, strings.Trim(value[1:], string(quote)), true
	}
	if idx := strings.Index(value, " #"); idx >= 0 {
		value = value[:idx]
	}
	return key, strings.TrimSpace(value), true
}

func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		if i == 0 && !(r == '_' || unicode.IsLetter(r)) {
			return false
		}
		if !(r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r)) {
			return false
		}
	}
	return true
}
