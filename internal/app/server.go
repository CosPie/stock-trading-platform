package app

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/static"

	"stock-trading-platform/internal/brief"
	"stock-trading-platform/internal/jobs"
	"stock-trading-platform/internal/storage"
)

type Options struct {
	Addr    string
	WebDir  string
	Store   *storage.Store
	Manager *jobs.Manager
	Brief   *brief.Generator
}

type Server struct {
	addr string
	app  *fiber.App
}

func New(opts Options) *Server {
	f := fiber.New(fiber.Config{
		AppName: "TradingAgents WebUI",
	})

	server := &Server{addr: opts.Addr, app: f}
	registerRoutes(f, opts)
	return server
}

func (s *Server) Addr() string {
	return s.addr
}

func (s *Server) Listen() error {
	return s.app.Listen(s.addr)
}

func registerRoutes(f *fiber.App, opts Options) {
	f.Get("/api/health", func(c fiber.Ctx) error {
		return c.JSON(fiber.Map{"ok": true, "time": time.Now()})
	})

	f.Get("/api/settings", func(c fiber.Ctx) error {
		return c.JSON(opts.Store.Settings())
	})

	f.Put("/api/settings", func(c fiber.Ctx) error {
		var settings storage.Settings
		if err := c.Bind().Body(&settings); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		}
		if err := opts.Store.SaveSettings(settings); err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(opts.Store.Settings())
	})

	f.Get("/api/reports", func(c fiber.Ctx) error {
		opts.Manager.MarkStaleAnalyses()
		return c.JSON(opts.Store.Reports(c.Query("q")))
	})

	f.Get("/api/reports/:id", func(c fiber.Ctx) error {
		opts.Manager.MarkStaleAnalyses()
		report, ok := opts.Store.Report(c.Params("id"))
		if !ok {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "报告不存在"})
		}
		return c.JSON(report)
	})

	f.Delete("/api/reports/:id", func(c fiber.Ctx) error {
		report, ok := opts.Store.Report(c.Params("id"))
		if !ok {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "报告不存在"})
		}
		if report.Status == "running" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "分析进行中的报告不能删除"})
		}
		if err := opts.Store.DeleteReport(report.ID); err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(fiber.Map{"ok": true})
	})

	f.Post("/api/reports/:id/brief", func(c fiber.Ctx) error {
		report, ok := opts.Store.Report(c.Params("id"))
		if !ok {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "报告不存在"})
		}
		if report.BriefHTML != "" {
			return c.JSON(report)
		}
		if report.Status != "complete" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "报告未完成，不能生成简报"})
		}

		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		html, err := opts.Brief.Generate(ctx, opts.Store.Settings(), report)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		}
		now := time.Now()
		updated, err := opts.Store.UpdateReport(report.ID, func(r *storage.Report) {
			r.BriefHTML = html
			r.BriefGeneratedAt = &now
		})
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(updated)
	})

	f.Post("/api/analyses", func(c fiber.Ctx) error {
		var req jobs.StartRequest
		if err := c.Bind().Body(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		}
		report, err := opts.Manager.Start(c, req)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusAccepted).JSON(report)
	})

	f.Get("/api/analyses/:id/events", func(c fiber.Ctx) error {
		jobID := c.Params("id")
		past, live, cancel, ok := opts.Manager.Subscribe(jobID)
		if !ok {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "任务不存在"})
		}

		c.Set("Content-Type", "text/event-stream; charset=utf-8")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")
		c.Set("Transfer-Encoding", "chunked")

		return c.SendStreamWriter(func(w *bufio.Writer) {
			defer cancel()
			terminal := false
			for _, event := range past {
				if err := writeSSE(w, event.Type, event); err != nil {
					return
				}
				if event.Type == "complete" || event.Type == "error" {
					terminal = true
				}
			}
			if terminal {
				return
			}

			heartbeat := time.NewTicker(15 * time.Second)
			defer heartbeat.Stop()
			for {
				select {
				case event, ok := <-live:
					if !ok {
						return
					}
					if err := writeSSE(w, event.Type, event); err != nil {
						return
					}
					if event.Type == "complete" || event.Type == "error" {
						return
					}
				case <-heartbeat.C:
					if err := writeRawSSE(w, "ping", `{"ok":true}`); err != nil {
						return
					}
				}
			}
		})
	})

	f.Get("/", func(c fiber.Ctx) error {
		return c.SendFile(filepath.Join(opts.WebDir, "index.html"))
	})
	f.Get("/report/:id", func(c fiber.Ctx) error {
		return c.SendFile(filepath.Join(opts.WebDir, "report.html"))
	})
	f.Get("/*", static.New(opts.WebDir))
}

func writeSSE(w *bufio.Writer, eventName string, value interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeRawSSE(w, eventName, string(data))
}

func writeRawSSE(w *bufio.Writer, eventName string, data string) error {
	if eventName == "" {
		eventName = "message"
	}
	if _, err := fmt.Fprintf(w, "event: %s\n", eventName); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
		return err
	}
	return w.Flush()
}
