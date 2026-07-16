package handlers

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// PublishWorkspaceStateEvent records a collaboration-state transition before
// delivering it to connected clients. Keeping the event in the normal event
// store lets clients that reconnect recover state transitions they missed.
func PublishWorkspaceStateEvent(workspaceID, eventType, source, channelName string, payload interface{}) error {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	timestamp := time.Now().UnixMilli()
	target := "workspace"
	if channelName != "" {
		target = "channel/" + channelName
	}
	record := models.EventRecord{
		ID:         uuid.NewString(),
		NetworkID:  workspaceID,
		Type:       eventType,
		Source:     source,
		Target:     target,
		Payload:    payloadBytes,
		Timestamp:  timestamp,
		Visibility: "workspace",
	}
	if err := db.DB.Create(&record).Error; err != nil {
		return err
	}

	if hub.GlobalHub != nil {
		fullEventBytes, err := json.Marshal(eventResponse(record))
		if err != nil {
			return err
		}
		hub.GlobalHub.Broadcast(hub.BroadcastMsg{
			WorkspaceID: workspaceID,
			ChannelName: channelName,
			Payload:     string(fullEventBytes),
		})
	}
	return nil
}
