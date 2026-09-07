package models

import (
	"time"
)

// Speech Act Type constants
const (
	ActProposal   = "PROPOSAL"
	ActChallenge  = "CHALLENGE"
	ActDefense    = "DEFENSE"
	ActSupport    = "SUPPORT"
	ActResolution = "RESOLUTION"
)

// Council Session Status constants
const (
	CouncilStatusDebating        = "debating"
	CouncilStatusConverged       = "converged"
	CouncilStatusApproved        = "approved"
	CouncilStatusExecuting       = "executing"
	CouncilStatusVetoed          = "vetoed"
	CouncilStatusBudgetExhausted = "budget_exhausted"
)

// CouncilSession represents a first-class deliberation blackboard session.
type CouncilSession struct {
	ID                  string    `gorm:"primaryKey;type:uuid" json:"id"`
	WorkspaceID         string    `gorm:"type:uuid;not null;index:idx_council_ws_channel" json:"workspace_id"`
	ChannelID           string    `gorm:"type:uuid;not null;index:idx_council_ws_channel" json:"channel_id"`
	Topic               string    `gorm:"type:text;not null" json:"topic"`
	Status              string    `gorm:"type:text;not null;default:debating" json:"status"`
	InitiatedBy         string    `gorm:"type:text;not null" json:"initiated_by"`
	ProposerAgent       string    `gorm:"type:text" json:"proposer_agent"`
	MandatoryChallenger string    `gorm:"type:text" json:"mandatory_challenger"`
	CurrentRound        int       `gorm:"type:integer;not null;default:1" json:"current_round"`
	MaxRounds           int       `gorm:"type:integer;not null;default:3" json:"max_rounds"`
	ChallengeDeadlineAt *int64    `gorm:"type:bigint" json:"challenge_deadline_at"` // Epoch ms timeout for mandatory challenge
	Resolution          []byte    `gorm:"type:jsonb" json:"resolution,omitempty"`   // Sealed, immutable resolution document
	CreatedAt           time.Time `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt           time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

func (CouncilSession) TableName() string {
	return "council_sessions"
}

// SpeechActRecord is a first-class structured discourse entity on the blackboard.
type SpeechActRecord struct {
	ID          string    `gorm:"primaryKey;type:uuid" json:"id"`
	SessionID   string    `gorm:"type:uuid;not null;index:idx_acts_session_round" json:"session_id"`
	Round       int       `gorm:"type:integer;not null;index:idx_acts_session_round" json:"round"`
	Author      string    `gorm:"type:text;not null" json:"author"`
	ActType     string    `gorm:"type:text;not null" json:"act_type"` // PROPOSAL | CHALLENGE | DEFENSE | SUPPORT | RESOLUTION
	TargetActID *string   `gorm:"type:uuid" json:"target_act_id"`
	Summary     string    `gorm:"type:text;not null" json:"summary"`
	Payload     []byte    `gorm:"type:jsonb" json:"payload"`
	CreatedAt   time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (SpeechActRecord) TableName() string {
	return "speech_act_records"
}
