package main

import (
	"log"
	"os"
	"path/filepath"

	"stock-trading-platform/internal/app"
	"stock-trading-platform/internal/brief"
	"stock-trading-platform/internal/jobs"
	"stock-trading-platform/internal/storage"
	"stock-trading-platform/internal/trading"
)

func main() {
	root, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}

	dataDir := env("APP_DATA_DIR", filepath.Join(root, "data"))
	store, err := storage.Open(filepath.Join(dataDir, "app_state.json"), root)
	if err != nil {
		log.Fatal(err)
	}

	runner := trading.NewRunner(root)
	manager := jobs.NewManager(store, runner)

	srv := app.New(app.Options{
		Addr:    listenAddr(),
		WebDir:  filepath.Join(root, "web"),
		Store:   store,
		Manager: manager,
		Brief:   brief.NewGenerator(),
	})

	log.Printf("TradingAgents WebUI listening on http://localhost%s", srv.Addr())
	if err := srv.Listen(); err != nil {
		log.Fatal(err)
	}
}

func env(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func listenAddr() string {
	if addr := os.Getenv("APP_ADDR"); addr != "" {
		return addr
	}
	if port := os.Getenv("PORT"); port != "" {
		return ":" + port
	}
	return ":16666"
}
