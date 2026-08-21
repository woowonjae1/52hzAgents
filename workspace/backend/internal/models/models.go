package models

import (
	"time"
)

// ---------------------------------------------------------------------------
// Core Event Store
// ---------------------------------------------------------------------------

type EventRecord struct {
	ID              string    `gorm:"primaryKey;type:text"`
	NetworkID       string    `gorm:"type:uuid;not null;index:idx_events_network_type;index:idx_events_network_target;index:idx_events_network_timestamp;index:uq_events_network_client_message,unique"`
	ClientMessageID *string   `gorm:"type:text;index:uq_events_network_client_message,unique"`
	Type            string    `gorm:"type:text;not null;index:idx_events_network_type"`
	Source          string    `gorm:"type:text;not null"`
	Target          string    `gorm:"type:text;not null;index:idx_events_network_target"`
	Payload         []byte    `gorm:"type:jsonb"`
	Metadata        []byte    `gorm:"type:jsonb;column:metadata"`
	Timestamp       int64     `gorm:"type:bigint;not null;index:idx_events_network_timestamp"`
	Visibility      string    `gorm:"type:text;default:channel"`
	CreatedAt       time.Time `gorm:"autoCreateTime"`
}

func (EventRecord) TableName() string {
	return "events"
}

// ---------------------------------------------------------------------------
// Materialized State Tables
// ---------------------------------------------------------------------------

type Workspace struct {
	ID             string    `gorm:"primaryKey;type:uuid"`
	Slug           string    `gorm:"type:text;unique"`
	Name           string    `gorm:"type:text;not null"`
	CreatorEmail   *string   `gorm:"type:text"`
	PasswordHash   *string   `gorm:"type:text"`
	Settings       []byte    `gorm:"type:jsonb"`
	Status         string    `gorm:"type:text;default:active"`
	CreatedAt      time.Time `gorm:"autoCreateTime"`
	LastActivityAt time.Time `gorm:"autoCreateTime"`
}

func (Workspace) TableName() string {
	return "workspaces"
}

type WorkspaceMember struct {
	WorkspaceID      string     `gorm:"primaryKey;type:uuid" json:"workspace_id"`
	AgentName        string     `gorm:"primaryKey;type:text" json:"agent_name"`
	Role             string     `gorm:"type:text;default:member" json:"role"`
	AgentType        *string    `gorm:"type:text" json:"agent_type"`
	ServerHost       *string    `gorm:"type:text" json:"server_host"`
	WorkingDir       *string    `gorm:"type:text" json:"working_dir"`
	Description      *string    `gorm:"type:text" json:"description"`
	EnabledSkills    []byte     `gorm:"type:jsonb" json:"enabled_skills"`
	Status           string     `gorm:"type:text;default:offline" json:"status"`
	LastHeartbeat    *time.Time `gorm:"" json:"last_heartbeat"`
	JoinedAt         time.Time  `gorm:"autoCreateTime" json:"joined_at"`
	SessionID        *string    `gorm:"type:text" json:"session_id"`
	SessionStartedAt *time.Time `gorm:"" json:"session_started_at"`
}

func (WorkspaceMember) TableName() string {
	return "workspace_members"
}

type Channel struct {
	ID                       string    `gorm:"primaryKey;type:uuid" json:"id"`
	WorkspaceID              string    `gorm:"type:uuid;not null;index:uq_channels_ws_name,unique;index:idx_channels_workspace_status" json:"workspace_id"`
	Name                     string    `gorm:"type:text;not null;index:uq_channels_ws_name,unique" json:"name"`
	Title                    *string   `gorm:"type:text" json:"title"`
	TitleManuallySet         bool      `gorm:"type:boolean;default:false" json:"title_manually_set"`
	CreatedBy                *string   `gorm:"type:text" json:"created_by"`
	MasterAgent              *string   `gorm:"type:text" json:"master_agent"`
	ResumeFrom               *string   `gorm:"type:text" json:"resume_from"`
	OrchestrationMode        string    `gorm:"type:text;default:dynamic" json:"orchestration_mode"`
	OrchestrationInstruction *string   `gorm:"type:text" json:"orchestration_instruction"`
	Status                   string    `gorm:"type:text;default:active;index:idx_channels_workspace_status;index:idx_channels_status_last_event" json:"status"`
	Starred                  bool      `gorm:"type:boolean;default:false" json:"starred"`
	LastEventAt              *int64    `gorm:"type:bigint;index:idx_channels_status_last_event" json:"last_event_at"`
	WorkingDir               *string   `gorm:"type:text" json:"working_dir"`
	CreatedAt                time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (Channel) TableName() string {
	return "channels"
}

type ChannelMember struct {
	ChannelID string `gorm:"primaryKey;type:uuid"`
	AgentName string `gorm:"primaryKey;type:text"`
}

func (ChannelMember) TableName() string {
	return "channel_members"
}

// PipelineStep is one hop of a multi-agent relay chain. Steps are stored as
// JSON inside ChannelPipeline.Steps rather than in their own table because a
// chain is always read and written whole.
type PipelineStep struct {
	Agent       string  `json:"agent"`
	Instruction string  `json:"instruction"`
	Status      string  `json:"status"` // pending | running | done | failed | retrying
	StartedAt   *int64  `json:"started_at,omitempty"`
	FinishedAt  *int64  `json:"finished_at,omitempty"`
	MaxRetries  int     `json:"max_retries,omitempty"` // Maximum self-correction retry attempts (default 3)
	RetryCount  int     `json:"retry_count,omitempty"` // Number of retry attempts made so far
	LastError   *string `json:"last_error,omitempty"`  // Diagnostic error string extracted on failure
}

// ChannelPipeline persists the relay chain a human starts with a multi-agent
// message ("@a analyse @b refactor @c review"). It replaces an in-memory map
// which lost every in-flight chain on restart and, more importantly, did not
// record which agent the current step was waiting on -- so any agent's chat
// message advanced the chain.
type ChannelPipeline struct {
	ID          string `gorm:"primaryKey;type:uuid" json:"id"`
	WorkspaceID string `gorm:"type:uuid;not null;index:idx_channel_pipelines_workspace" json:"workspace_id"`
	ChannelID   string `gorm:"type:uuid;not null;uniqueIndex:uq_channel_pipelines_channel" json:"channel_id"`
	// Steps is a JSON-encoded []PipelineStep. Kept out of JSON responses so it
	// is never emitted as base64; callers decode it and expose parsed steps.
	Steps        []byte    `gorm:"type:jsonb" json:"-"`
	CurrentIndex int       `gorm:"type:integer;not null;default:0" json:"current_index"`
	Status       string    `gorm:"type:text;not null;default:running" json:"status"` // running | completed
	StartedBy    string    `gorm:"type:text" json:"started_by"`
	CreatedAt    time.Time `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt    time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

func (ChannelPipeline) TableName() string {
	return "channel_pipelines"
}

type ChannelHumanMember struct {
	ChannelID string    `gorm:"primaryKey;type:uuid"`
	UserEmail string    `gorm:"primaryKey;type:text;index:idx_channel_human_members_email"`
	JoinedAt  time.Time `gorm:"autoCreateTime"`
}

func (ChannelHumanMember) TableName() string {
	return "channel_human_members"
}

// ChannelCompactionRecord stores a compressed summary checkpoint for a channel's
// conversation history, allowing long-running multi-agent sessions without token exhaustion.
type ChannelCompactionRecord struct {
	ID                    string    `gorm:"primaryKey;type:uuid" json:"id"`
	WorkspaceID           string    `gorm:"type:uuid;not null;index:idx_channel_compactions_ws" json:"workspace_id"`
	ChannelID             string    `gorm:"type:uuid;not null;index:idx_channel_compactions_ch" json:"channel_id"`
	ChannelName           string    `gorm:"type:text;not null" json:"channel_name"`
	Summary               string    `gorm:"type:text;not null" json:"summary"`
	FromEventID           string    `gorm:"type:text" json:"from_event_id"`
	ToEventID             string    `gorm:"type:text" json:"to_event_id"`
	CompactedCount        int       `gorm:"type:integer;not null" json:"compacted_count"`
	EstimatedTokensBefore int       `gorm:"type:integer" json:"tokens_before"`
	EstimatedTokensAfter  int       `gorm:"type:integer" json:"tokens_after"`
	CreatedAt             time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (ChannelCompactionRecord) TableName() string {
	return "channel_compactions"
}

type Invitation struct {
	ID          string    `gorm:"primaryKey;type:uuid"`
	WorkspaceID string    `gorm:"type:uuid;not null"`
	TargetAgent string    `gorm:"type:text;not null"`
	InviteToken string    `gorm:"type:text;not null;unique"`
	Status      string    `gorm:"type:text;default:pending"`
	CreatedAt   time.Time `gorm:"autoCreateTime"`
	ExpiresAt   time.Time `gorm:"not null"`
}

func (Invitation) TableName() string {
	return "invitations"
}

type WorkspaceCollaborator struct {
	ID          string    `gorm:"primaryKey;type:uuid" json:"id"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_collaborators_workspace;uniqueIndex:uq_collaborator_workspace_email" json:"workspace_id"`
	Email       string    `gorm:"type:text;not null;index:idx_collaborators_email;uniqueIndex:uq_collaborator_workspace_email" json:"email"`
	Role        string    `gorm:"type:text;default:editor" json:"role"`
	AddedBy     *string   `gorm:"type:text" json:"added_by"`
	AddedAt     time.Time `gorm:"autoCreateTime" json:"added_at"`
	DisplayName *string   `gorm:"type:text" json:"display_name"`
}

func (WorkspaceCollaborator) TableName() string {
	return "workspace_collaborators"
}

// ---------------------------------------------------------------------------
// Knowledge Base
// ---------------------------------------------------------------------------

type KnowledgeEntry struct {
	ID          string    `gorm:"primaryKey;type:text"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_knowledge_workspace_status;uniqueIndex:uq_knowledge_workspace_slug"`
	Slug        string    `gorm:"type:text;not null;uniqueIndex:uq_knowledge_workspace_slug"`
	Title       string    `gorm:"type:text;not null"`
	Description *string   `gorm:"type:text"`
	StorageKey  *string   `gorm:"type:text"`
	ContentSize *int      `gorm:"type:integer"`
	CreatedBy   string    `gorm:"type:text;not null"`
	UpdatedBy   *string   `gorm:"type:text"`
	Status      string    `gorm:"type:text;not null;default:active;index:idx_knowledge_workspace_status"`
	CreatedAt   time.Time `gorm:"autoCreateTime"`
	UpdatedAt   time.Time `gorm:"autoCreateTime"`
}

func (KnowledgeEntry) TableName() string {
	return "knowledge_entries"
}

// ---------------------------------------------------------------------------
// File Storage
// ---------------------------------------------------------------------------

type FileRecord struct {
	ID          string    `gorm:"primaryKey;type:text" json:"id"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_files_workspace_status" json:"workspace_id"`
	Filename    string    `gorm:"type:text;not null" json:"filename"`
	ContentType string    `gorm:"type:text;not null;default:application/octet-stream" json:"content_type"`
	Size        int       `gorm:"type:integer;not null" json:"size"`
	StorageKey  string    `gorm:"type:text;not null" json:"storage_key"`
	UploadedBy  string    `gorm:"type:text;not null" json:"uploaded_by"`
	ChannelName *string   `gorm:"type:text" json:"channel_name"`
	Status      string    `gorm:"type:text;not null;default:active;index:idx_files_workspace_status" json:"status"`
	CreatedAt   time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (FileRecord) TableName() string {
	return "files"
}

// ---------------------------------------------------------------------------
// Browser Support
// ---------------------------------------------------------------------------

type BrowserTab struct {
	ID           string    `gorm:"primaryKey;type:text"`
	WorkspaceID  string    `gorm:"type:uuid;not null;index:idx_browser_tabs_workspace_status"`
	URL          string    `gorm:"type:text;not null;default:about:blank"`
	Title        *string   `gorm:"type:text"`
	Status       string    `gorm:"type:text;not null;default:active;index:idx_browser_tabs_workspace_status"`
	CreatedBy    string    `gorm:"type:text;not null"`
	SharedWith   []byte    `gorm:"type:jsonb"`
	ContextID    *string   `gorm:"type:text"`
	SessionID    *string   `gorm:"type:text"`
	LiveURL      *string   `gorm:"type:text"`
	CreatedAt    time.Time `gorm:"autoCreateTime"`
	LastActiveAt time.Time `gorm:"autoCreateTime"`
}

func (BrowserTab) TableName() string {
	return "browser_tabs"
}

type BrowserContext struct {
	ID          string    `gorm:"primaryKey;type:text"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_browser_contexts_workspace_status;uniqueIndex:uq_browser_context_workspace_name"`
	Name        string    `gorm:"type:text;not null;uniqueIndex:uq_browser_context_workspace_name"`
	BbContextID *string   `gorm:"type:text"`
	Domain      *string   `gorm:"type:text"`
	Status      string    `gorm:"type:text;not null;default:active;index:idx_browser_contexts_workspace_status"`
	CreatedBy   string    `gorm:"type:text;not null"`
	SharedWith  []byte    `gorm:"type:jsonb"`
	CreatedAt   time.Time `gorm:"autoCreateTime"`
	LastUsedAt  time.Time `gorm:"autoCreateTime"`
}

func (BrowserContext) TableName() string {
	return "browser_contexts"
}

type BrowserUsage struct {
	ID              string     `gorm:"primaryKey;type:text"`
	WorkspaceID     string     `gorm:"type:uuid;not null;index:idx_browser_usage_workspace"`
	TabID           string     `gorm:"type:text;not null"`
	SessionID       *string    `gorm:"type:text"`
	OpenedBy        string     `gorm:"type:text;not null;index:idx_browser_usage_opened_by"`
	StartedAt       time.Time  `gorm:"autoCreateTime;index:idx_browser_usage_started"`
	EndedAt         *time.Time `gorm:""`
	DurationSeconds *int       `gorm:"type:integer"`
}

func (BrowserUsage) TableName() string {
	return "browser_usage"
}

type DeviceToken struct {
	ID          string    `gorm:"primaryKey;type:uuid"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_device_tokens_workspace;index:idx_device_tokens_workspace_user;uniqueIndex:uq_device_token_workspace_fcm"`
	FCMToken    string    `gorm:"type:text;not null;uniqueIndex:uq_device_token_workspace_fcm"`
	DeviceType  string    `gorm:"type:text;not null"`
	BundleID    *string   `gorm:"type:text"`
	UserEmail   *string   `gorm:"type:text;index:idx_device_tokens_workspace_user"`
	CreatedAt   time.Time `gorm:"autoCreateTime"`
	LastSeenAt  time.Time `gorm:"autoCreateTime"`
}

func (DeviceToken) TableName() string {
	return "device_tokens"
}

// ---------------------------------------------------------------------------
// Planning & Timers
// ---------------------------------------------------------------------------

type TodoRecord struct {
	ID          string    `gorm:"primaryKey;type:text" json:"id"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_todos_workspace_channel" json:"workspace_id"`
	ChannelName string    `gorm:"type:text;not null;index:idx_todos_workspace_channel" json:"channel_name"`
	ThreadID    *string   `gorm:"type:text" json:"thread_id"`
	CreatedBy   string    `gorm:"type:text;not null;index:idx_todos_workspace_created_by" json:"created_by"`
	Assignee    string    `gorm:"type:text;not null" json:"assignee"`
	Content     string    `gorm:"type:text;not null" json:"content"`
	Status      string    `gorm:"type:text;not null;default:pending" json:"status"`
	Position    int       `gorm:"type:integer;not null;default:0" json:"position"`
	CreatedAt   time.Time `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt   time.Time `gorm:"autoCreateTime" json:"updated_at"`
}

func (TodoRecord) TableName() string {
	return "todos"
}

type TimerRecord struct {
	ID           string    `gorm:"primaryKey;type:text" json:"id"`
	WorkspaceID  string    `gorm:"type:uuid;not null;index:idx_timers_workspace_channel" json:"workspace_id"`
	ChannelName  string    `gorm:"type:text;not null;index:idx_timers_workspace_channel" json:"channel_name"`
	ThreadID     *string   `gorm:"type:text" json:"thread_id"`
	CreatedBy    string    `gorm:"type:text;not null" json:"created_by"`
	Message      string    `gorm:"type:text;not null" json:"message"`
	DelaySeconds int       `gorm:"type:integer;not null" json:"delay_seconds"`
	FiresAt      time.Time `gorm:"not null;index:idx_timers_fires_at_status" json:"fires_at"`
	Status       string    `gorm:"type:text;not null;default:active;index:idx_timers_fires_at_status" json:"status"`
	CreatedAt    time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (TimerRecord) TableName() string {
	return "timers"
}

type RoutineRecord struct {
	ID                      string     `gorm:"primaryKey;type:text" json:"id"`
	WorkspaceID             string     `gorm:"type:uuid;not null;index:idx_routines_workspace_channel" json:"workspace_id"`
	ChannelName             string     `gorm:"type:text;not null;index:idx_routines_workspace_channel" json:"channel_name"`
	ThreadID                *string    `gorm:"type:text" json:"thread_id"`
	CreatedBy               string     `gorm:"type:text;not null" json:"created_by"`
	Name                    string     `gorm:"type:text;not null" json:"name"`
	Message                 string     `gorm:"type:text;not null" json:"message"`
	Context                 *string    `gorm:"type:text" json:"context"`
	ScheduleHour            *int       `gorm:"type:integer" json:"schedule_hour"`
	ScheduleMinute          *int       `gorm:"type:integer" json:"schedule_minute"`
	ScheduleDays            []byte     `gorm:"type:jsonb" json:"schedule_days"`
	ScheduleIntervalMinutes *int       `gorm:"type:integer" json:"schedule_interval_minutes"`
	Timezone                string     `gorm:"type:text;default:UTC" json:"timezone"`
	NextFiresAt             time.Time  `gorm:"not null;index:idx_routines_next_fires_status" json:"next_fires_at"`
	LastFiredAt             *time.Time `gorm:"" json:"last_fired_at"`
	Status                  string     `gorm:"type:text;not null;default:active;index:idx_routines_next_fires_status" json:"status"`
	CreatedAt               time.Time  `gorm:"autoCreateTime" json:"created_at"`
}

func (RoutineRecord) TableName() string {
	return "routines"
}

// ---------------------------------------------------------------------------
// Inbox & Notifications
// ---------------------------------------------------------------------------

type NotificationRecord struct {
	ID          string     `gorm:"primaryKey;type:text" json:"id"`
	WorkspaceID string     `gorm:"type:uuid;not null;index:idx_notifications_workspace_status;index:idx_notifications_workspace_read" json:"workspace_id"`
	CreatedBy   string     `gorm:"type:text;not null" json:"created_by"`
	Title       string     `gorm:"type:text;not null" json:"title"`
	Message     string     `gorm:"type:text;not null" json:"message"`
	Priority    string     `gorm:"type:text;not null;default:normal" json:"priority"`
	IsRead      bool       `gorm:"type:boolean;default:false;index:idx_notifications_workspace_read" json:"is_read"`
	ChannelName *string    `gorm:"type:text" json:"channel_name"`
	ThreadID    *string    `gorm:"type:text" json:"thread_id"`
	LinkURL     *string    `gorm:"type:text" json:"link_url"`
	Status      string     `gorm:"type:text;not null;default:active;index:idx_notifications_workspace_status" json:"status"`
	CreatedAt   time.Time  `gorm:"autoCreateTime;index:idx_notifications_created_at" json:"created_at"`
	ReadAt      *time.Time `gorm:"" json:"read_at"`
}

func (NotificationRecord) TableName() string {
	return "notifications"
}

// AgentRuntimeRecord is the latest health and process report sent by an
// authenticated agent bridge. It intentionally stores no host credentials.
type AgentRuntimeRecord struct {
	WorkspaceID   string    `gorm:"primaryKey;type:uuid" json:"workspace_id"`
	AgentName     string    `gorm:"primaryKey;type:text" json:"agent_name"`
	SessionID     string    `gorm:"type:text;not null" json:"session_id"`
	ProcessStatus string    `gorm:"type:text;not null" json:"process_status"`
	HealthStatus  string    `gorm:"type:text;not null" json:"health_status"`
	PID           *int      `gorm:"type:integer" json:"pid"`
	RestartCount  int       `gorm:"type:integer;not null;default:0" json:"restart_count"`
	LastError     *string   `gorm:"type:text" json:"last_error"`
	UpdatedAt     time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

func (AgentRuntimeRecord) TableName() string {
	return "agent_runtimes"
}

type AgentLogRecord struct {
	ID          string    `gorm:"primaryKey;type:text" json:"id"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_agent_logs_workspace_agent_created" json:"workspace_id"`
	AgentName   string    `gorm:"type:text;not null;index:idx_agent_logs_workspace_agent_created" json:"agent_name"`
	Level       string    `gorm:"type:text;not null;default:info" json:"level"`
	Message     string    `gorm:"type:text;not null" json:"message"`
	CreatedAt   time.Time `gorm:"autoCreateTime;index:idx_agent_logs_workspace_agent_created" json:"created_at"`
}

func (AgentLogRecord) TableName() string {
	return "agent_logs"
}

// AgentUsageRecord stores subscription quota, rate limits and 5-hour/weekly usage.
type AgentUsageRecord struct {
	WorkspaceID        string    `gorm:"primaryKey;type:uuid" json:"workspace_id"`
	AgentName          string    `gorm:"primaryKey;type:text" json:"agent_name"`
	SessionUsedPercent int       `gorm:"type:integer;not null;default:0" json:"session_used_percent"`
	SessionResetsAt    *string   `gorm:"type:text" json:"session_resets_at"`
	WeekUsedPercent    int       `gorm:"type:integer;not null;default:0" json:"week_used_percent"`
	WeekResetsAt       *string   `gorm:"type:text" json:"week_resets_at"`
	Last24hSummary     *string   `gorm:"type:text" json:"last_24h_summary"`
	Last7dSummary      *string   `gorm:"type:text" json:"last_7d_summary"`
	CurrentModel       *string   `gorm:"type:text" json:"current_model"`
	AvailableModels    *string   `gorm:"type:text" json:"available_models"`
	RawText            *string   `gorm:"type:text" json:"raw_text"`
	UpdatedAt          time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

func (AgentUsageRecord) TableName() string {
	return "agent_usages"
}

type AgentApprovalRecord struct {
	ID          string     `gorm:"primaryKey;type:text" json:"id"`
	WorkspaceID string     `gorm:"type:uuid;not null;index:idx_agent_approvals_workspace_status" json:"workspace_id"`
	AgentName   string     `gorm:"type:text;not null;index:idx_agent_approvals_workspace_status" json:"agent_name"`
	RequestedBy string     `gorm:"type:text;not null" json:"requested_by"`
	Action      string     `gorm:"type:text;not null" json:"action"`
	Details     []byte     `gorm:"type:jsonb" json:"details"`
	Status      string     `gorm:"type:text;not null;default:pending;index:idx_agent_approvals_workspace_status" json:"status"`
	ResolvedBy  *string    `gorm:"type:text" json:"resolved_by"`
	ResolvedAt  *time.Time `gorm:"" json:"resolved_at"`
	CreatedAt   time.Time  `gorm:"autoCreateTime" json:"created_at"`
}

// AuditRecord contains request metadata only. Bodies and credentials are never
// stored so auditability does not create a second secret store.
type AuditRecord struct {
	ID          string    `gorm:"primaryKey;type:text" json:"id"`
	RequestID   string    `gorm:"type:text;not null;index" json:"request_id"`
	WorkspaceID *string   `gorm:"type:text;index" json:"workspace_id"`
	Method      string    `gorm:"type:text;not null" json:"method"`
	Path        string    `gorm:"type:text;not null" json:"path"`
	StatusCode  int       `gorm:"type:integer;not null" json:"status_code"`
	ClientIP    string    `gorm:"type:text;not null" json:"client_ip"`
	CreatedAt   time.Time `gorm:"autoCreateTime;index" json:"created_at"`
}

func (AuditRecord) TableName() string { return "audit_records" }

func (AgentApprovalRecord) TableName() string {
	return "agent_approvals"
}

// ---------------------------------------------------------------------------
// Cloud Agent Configs
// ---------------------------------------------------------------------------

type CloudAgentConfig struct {
	ID           string    `gorm:"primaryKey;type:text" json:"id"`
	WorkspaceID  string    `gorm:"type:uuid;not null;index:idx_cloud_agent_workspace;uniqueIndex:uq_cloud_agent_workspace_name" json:"workspace_id"`
	AgentName    string    `gorm:"type:text;not null;uniqueIndex:uq_cloud_agent_workspace_name" json:"agent_name"`
	Provider     string    `gorm:"type:text;not null" json:"provider"`
	Model        string    `gorm:"type:text;not null" json:"model"`
	Category     string    `gorm:"type:text;not null;default:chat" json:"category"`
	APIKey       string    `gorm:"type:text;not null" json:"api_key"`
	BaseURL      *string   `gorm:"type:text" json:"base_url"`
	SystemPrompt *string   `gorm:"type:text" json:"system_prompt"`
	MaxTokens    *int      `gorm:"type:integer" json:"max_tokens"`
	Status       string    `gorm:"type:text;not null;default:active" json:"status"`
	CreatedAt    time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (CloudAgentConfig) TableName() string {
	return "cloud_agent_configs"
}

// ---------------------------------------------------------------------------
// Share Snapshots
// ---------------------------------------------------------------------------

type ShareSnapshot struct {
	ID           string    `gorm:"primaryKey;type:text"`
	WorkspaceID  string    `gorm:"type:uuid;not null;index:idx_share_snapshots_workspace"`
	ChannelName  string    `gorm:"type:text;not null"`
	Title        *string   `gorm:"type:text"`
	CreatedBy    string    `gorm:"type:text;not null"`
	SnapshotData []byte    `gorm:"type:jsonb;not null"`
	ShareToken   string    `gorm:"type:text;not null;unique;index:idx_share_snapshots_token"`
	MessageCount int       `gorm:"type:integer;not null;default:0"`
	Status       string    `gorm:"type:text;not null;default:active"`
	CreatedAt    time.Time `gorm:"autoCreateTime"`
}

func (ShareSnapshot) TableName() string {
	return "share_snapshots"
}

// ---------------------------------------------------------------------------
// Standalone Local Identities
// ---------------------------------------------------------------------------

type Agent struct {
	AgentName   string    `gorm:"primaryKey;type:text"`
	DisplayName *string   `gorm:"type:text"`
	AgentType   *string   `gorm:"type:text"`
	CreatedAt   time.Time `gorm:"autoCreateTime"`
}

func (Agent) TableName() string {
	return "agents"
}
