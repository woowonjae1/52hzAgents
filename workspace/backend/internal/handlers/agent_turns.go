package handlers

import (
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm/clause"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

const (
	agentTurnEventType = "workspace.agent.turn.updated"
	maxTurnErrorLen    = 1000
	// A rejoin gives the adapter this long to re-assert the turns it is still
	// running before the sweep treats them as left behind by a dead process.
	turnRestartGrace = 15 * time.Second
)

type ReportAgentTurnRequest struct {
	Channel string `json:"channel" binding:"required"`
	State   string `json:"state" binding:"required"`
	Error   string `json:"error"`
}

/*
ReportAgentTurn records what the agent itself says about its turn in one
channel: it started one (running), finished it (idle), or it failed (error).

The UI used to infer this from the message stream -- a trailing thinking event
meant "working" -- so a turn cut off by a crash looked busy forever. This row is
the agent's own word instead, and the scheduler keeps it honest when the agent
disappears without saying anything (ExpireOrphanedAgentTurns).
*/
func ReportAgentTurn(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req ReportAgentTurnRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	agentName := agentNameFromSource(c.Param("agent_name"))
	channel := strings.TrimPrefix(strings.TrimSpace(req.Channel), "channel/")
	state := strings.ToLower(strings.TrimSpace(req.State))
	if agentName == "" || channel == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "agent and channel are required"})
		return
	}
	if state != models.AgentTurnIdle && state != models.AgentTurnRunning && state != models.AgentTurnError {
		c.JSON(http.StatusBadRequest, gin.H{"error": "state must be idle, running or error"})
		return
	}

	record, err := saveAgentTurn(workspace.ID, agentName, channel, state, req.Error)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save agent turn"})
		return
	}
	_ = PublishWorkspaceStateEvent(workspace.ID, agentTurnEventType, "52hz:"+agentName, channel, gin.H{"turn": record})
	c.JSON(http.StatusOK, record)
}

func saveAgentTurn(workspaceID, agentName, channel, state, errText string) (models.AgentTurnState, error) {
	var existing models.AgentTurnState
	found := db.DB.Where("workspace_id = ? AND agent_name = ? AND channel_name = ?",
		workspaceID, agentName, channel).Limit(1).Find(&existing).RowsAffected > 0

	// UTC throughout: the sweep compares updated_at in SQL, and a mix of local
	// and UTC strings does not order correctly in SQLite.
	now := time.Now().UTC()
	record := models.AgentTurnState{
		WorkspaceID: workspaceID,
		AgentName:   agentName,
		ChannelName: channel,
		State:       state,
		UpdatedAt:   now,
	}
	if found {
		record.StartedAt = existing.StartedAt
		record.EndedAt = existing.EndedAt
	}
	switch state {
	case models.AgentTurnRunning:
		// Re-asserting a turn already running (after a rejoin) keeps its start.
		if !found || existing.State != models.AgentTurnRunning || existing.StartedAt == nil {
			record.StartedAt = &now
		}
		record.EndedAt = nil
	case models.AgentTurnIdle:
		if !found || existing.State == models.AgentTurnRunning {
			record.EndedAt = &now
		}
	case models.AgentTurnError:
		record.EndedAt = &now
		record.Error = strings.TrimSpace(errText)
		if record.Error == "" {
			record.Error = "turn failed"
		}
		if len(record.Error) > maxTurnErrorLen {
			record.Error = record.Error[:maxTurnErrorLen]
		}
	}

	err := db.DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "workspace_id"}, {Name: "agent_name"}, {Name: "channel_name"}},
		DoUpdates: clause.AssignmentColumns([]string{"state", "error", "started_at", "ended_at", "updated_at"}),
	}).Create(&record).Error
	return record, err
}

// ListAgentTurns returns every (agent, channel) turn row in the workspace,
// newest first; `?channel=` and `?agent=` narrow it.
func ListAgentTurns(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	q := db.DB.Where("workspace_id = ?", workspace.ID)
	if ch := strings.TrimPrefix(strings.TrimSpace(c.Query("channel")), "channel/"); ch != "" {
		q = q.Where("channel_name = ?", ch)
	}
	if agent := agentNameFromSource(strings.TrimSpace(c.Query("agent"))); agent != "" {
		q = q.Where("agent_name = ?", agent)
	}
	var records []models.AgentTurnState
	if err := q.Order("updated_at DESC").Find(&records).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load agent turns"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"turns": records})
}

/*
ExpireOrphanedAgentTurns lands every `running` turn whose agent is gone in
`error`. A runtime that dies must not keep looking healthy: nobody will ever
report the end of that turn, so without this the UI shows it working forever.

Gone means: the member row is missing, its status is anything but
online/launching (the heartbeat watchdog sets offline, adapters report
crashed), its heartbeat is older than heartbeatTimeout, or it has joined again
since the turn was last reported -- a new session is a new process, and the
old one's turn died with it. The adapter re-asserts its live turns after a
rejoin, which is why that last rule waits turnRestartGrace.

Returns how many turns were moved.
*/
func ExpireOrphanedAgentTurns(heartbeatTimeout time.Duration) int {
	if db.DB == nil {
		return 0
	}
	var running []models.AgentTurnState
	if err := db.DB.Where("state = ?", models.AgentTurnRunning).Find(&running).Error; err != nil || len(running) == 0 {
		return 0
	}

	now := time.Now().UTC()
	members := map[string]*models.WorkspaceMember{}
	moved := 0
	for _, turn := range running {
		key := turn.WorkspaceID + "\x00" + turn.AgentName
		member, cached := members[key]
		if !cached {
			var m models.WorkspaceMember
			if db.DB.Where("workspace_id = ? AND agent_name = ?", turn.WorkspaceID, turn.AgentName).Limit(1).Find(&m).RowsAffected > 0 {
				member = &m
			}
			members[key] = member
		}

		reason := ""
		switch {
		case member == nil:
			reason = "agent left the workspace mid-turn"
		case member.Status == "crashed":
			reason = "agent crashed mid-turn"
		case member.Status != "online" && member.Status != "launching":
			reason = "agent went offline mid-turn"
		case heartbeatTimeout > 0 && (member.LastHeartbeat == nil || now.Sub(*member.LastHeartbeat) > heartbeatTimeout):
			reason = "agent went offline mid-turn"
		case member.SessionStartedAt != nil && member.SessionStartedAt.After(turn.UpdatedAt) &&
			now.Sub(*member.SessionStartedAt) > turnRestartGrace:
			reason = "agent restarted mid-turn"
		}
		if reason == "" {
			continue
		}

		// Conditional on the row not having moved since it was read, so a turn
		// the agent reported in the meantime is never overwritten.
		res := db.DB.Model(&models.AgentTurnState{}).
			Where("workspace_id = ? AND agent_name = ? AND channel_name = ? AND state = ? AND updated_at <= ?",
				turn.WorkspaceID, turn.AgentName, turn.ChannelName, models.AgentTurnRunning, turn.UpdatedAt).
			Updates(map[string]interface{}{
				"state":      models.AgentTurnError,
				"error":      reason,
				"ended_at":   now,
				"updated_at": now,
			})
		if res.Error != nil || res.RowsAffected == 0 {
			continue
		}
		moved++
		turn.State = models.AgentTurnError
		turn.Error = reason
		turn.EndedAt = &now
		turn.UpdatedAt = now
		_ = PublishWorkspaceStateEvent(turn.WorkspaceID, agentTurnEventType, "system:watchdog", turn.ChannelName, gin.H{"turn": turn})
		log.Printf("scheduler: @%s turn in %s marked error: %s", turn.AgentName, turn.ChannelName, reason)
	}
	return moved
}
