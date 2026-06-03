package jobs

import (
	"fmt"
	"sync/atomic"
	"time"

	"stock-trading-platform/internal/storage"
)

var eventSeq atomic.Int64

func newEvent(jobID string, typ string, stage string, message string, payload map[string]interface{}) storage.Event {
	return storage.Event{
		ID:      eventSeq.Add(1),
		JobID:   jobID,
		Type:    typ,
		Stage:   stage,
		Message: message,
		At:      time.Now(),
		Payload: payload,
	}
}

func statusMessage(stage string, status string) string {
	if stage == "" {
		return status
	}
	return fmt.Sprintf("%s：%s", stage, status)
}
