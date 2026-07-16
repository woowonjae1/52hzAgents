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
	CreatedAt       time.Time `gorm:"autoCreateTime;type:timestamptz"`
}

func (EventRecord) TableName() string {
	return "events"
}

// ---------------------------------------------------------------------------
// Materialized State Tables
// ---------------------------------------------------------------------------

type Workspace struct {
	ID             string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()"`
	Slug           string    `gorm:"type:text;unique"`
	Name           string    `gorm:"type:text;not null"`
	CreatorEmail   *string   `gorm:"type:text"`
	PasswordHash   *string   `gorm:"type:text"`
	Settings       []byte    `gorm:"type:jsonb"`
	Status         string    `gorm:"type:text;default:active"`
	CreatedAt      time.Time `gorm:"autoCreateTime;type:timestamptz"`
	LastActivityAt time.Time `gorm:"autoCreateTime;type:timestamptz"`
}

func (Workspace) TableName() string {
	return "workspaces"
}

type WorkspaceMember struct {
	WorkspaceID      string     `gorm:"primaryKey;type:uuid"`
	AgentName        string     `gorm:"primaryKey;type:text"`
	Role             string     `gorm:"type:text;default:member"`
	AgentType        *string    `gorm:"type:text"`
	ServerHost       *string    `gorm:"type:text"`
	WorkingDir       *string    `gorm:"type:text"`
	Description      *string    `gorm:"type:text"`
	EnabledSkills    []byte     `gorm:"type:jsonb"`
	Status           string     `gorm:"type:text;default:offline"`
	LastHeartbeat    *time.Time `gorm:"type:timestamptz"`
	JoinedAt         time.Time  `gorm:"autoCreateTime;type:timestamptz"`
	SessionID        *string    `gorm:"type:text"`
	SessionStartedAt *time.Time `gorm:"type:timestamptz"`
}

func (WorkspaceMember) TableName() string {
	return "workspace_members"
}

type Channel struct {
	ID                       string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()"`
	WorkspaceID              string    `gorm:"type:uuid;not null;index:uq_channels_ws_name,unique;index:idx_channels_workspace_status"`
	Name                     string    `gorm:"type:text;not null;index:uq_channels_ws_name,unique"`
	Title                    *string   `gorm:"type:text"`
	TitleManuallySet         bool      `gorm:"type:boolean;default:false"`
	CreatedBy                *string   `gorm:"type:text"`
	MasterAgent              *string   `gorm:"type:text"`
	ResumeFrom               *string   `gorm:"type:text"`
	OrchestrationMode        string    `gorm:"type:text;default:dynamic"`
	OrchestrationInstruction *string   `gorm:"type:text"`
	Status                   string    `gorm:"type:text;default:active;index:idx_channels_workspace_status;index:idx_channels_status_last_event"`
	Starred                  bool      `gorm:"type:boolean;default:false"`
	LastEventAt              *int64    `gorm:"type:bigint;index:idx_channels_status_last_event"`
	CreatedAt                time.Time `gorm:"autoCreateTime;type:timestamptz"`
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

type ChannelHumanMember struct {
	ChannelID string    `gorm:"primaryKey;type:uuid"`
	UserEmail string    `gorm:"primaryKey;type:text;index:idx_channel_human_members_email"`
	JoinedAt  time.Time `gorm:"autoCreateTime;type:timestamptz"`
}

func (ChannelHumanMember) TableName() string {
	return "channel_human_members"
}

type Invitation struct {
	ID          string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()"`
	WorkspaceID string    `gorm:"type:uuid;not null"`
	TargetAgent string    `gorm:"type:text;not null"`
	InviteToken string    `gorm:"type:text;not null;unique"`
	Status      string    `gorm:"type:text;default:pending"`
	CreatedAt   time.Time `gorm:"autoCreateTime;type:timestamptz"`
	ExpiresAt   time.Time `gorm:"type:timestamptz;not null"`
}

func (Invitation) TableName() string {
	return "invitations"
}

type WorkspaceCollaborator struct {
	ID          string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_collaborators_workspace;uniqueIndex:uq_collaborator_workspace_email"`
	Email       string    `gorm:"type:text;not null;index:idx_collaborators_email;uniqueIndex:uq_collaborator_workspace_email"`
	Role        string    `gorm:"type:text;default:editor"`
	AddedBy     *string   `gorm:"type:text"`
	AddedAt     time.Time `gorm:"autoCreateTime;type:timestamptz"`
	DisplayName *string   `gorm:"type:text"`
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
	CreatedAt   time.Time `gorm:"autoCreateTime;type:timestamptz"`
	UpdatedAt   time.Time `gorm:"autoCreateTime;type:timestamptz"`
}

func (KnowledgeEntry) TableName() string {
	return "knowledge_entries"
}

// ---------------------------------------------------------------------------
// File Storage
// ---------------------------------------------------------------------------

type FileRecord struct {
	ID          string    `gorm:"primaryKey;type:text"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_files_workspace_status"`
	Filename    string    `gorm:"type:text;not null"`
	ContentType string    `gorm:"type:text;not null;default:application/octet-stream"`
	Size        int       `gorm:"type:integer;not null"`
	StorageKey  string    `gorm:"type:text;not null"`
	UploadedBy  string    `gorm:"type:text;not null"`
	ChannelName *string   `gorm:"type:text"`
	Status      string    `gorm:"type:text;not null;default:active;index:idx_files_workspace_status"`
	CreatedAt   time.Time `gorm:"autoCreateTime;type:timestamptz"`
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
	CreatedAt    time.Time `gorm:"autoCreateTime;type:timestamptz"`
	LastActiveAt time.Time `gorm:"autoCreateTime;type:timestamptz"`
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
	CreatedAt   time.Time `gorm:"autoCreateTime;type:timestamptz"`
	LastUsedAt  time.Time `gorm:"autoCreateTime;type:timestamptz"`
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
	StartedAt       time.Time  `gorm:"autoCreateTime;type:timestamptz;index:idx_browser_usage_started"`
	EndedAt         *time.Time `gorm:"type:timestamptz"`
	DurationSeconds *int       `gorm:"type:integer"`
}

func (BrowserUsage) TableName() string {
	return "browser_usage"
}

type DeviceToken struct {
	ID          string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_device_tokens_workspace;index:idx_device_tokens_workspace_user;uniqueIndex:uq_device_token_workspace_fcm"`
	FCMToken    string    `gorm:"type:text;not null;uniqueIndex:uq_device_token_workspace_fcm"`
	DeviceType  string    `gorm:"type:text;not null"`
	BundleID    *string   `gorm:"type:text"`
	UserEmail   *string   `gorm:"type:text;index:idx_device_tokens_workspace_user"`
	CreatedAt   time.Time `gorm:"autoCreateTime;type:timestamptz"`
	LastSeenAt  time.Time `gorm:"autoCreateTime;type:timestamptz"`
}

func (DeviceToken) TableName() string {
	return "device_tokens"
}

// ---------------------------------------------------------------------------
// Planning & Timers
// ---------------------------------------------------------------------------

type TodoRecord struct {
	ID          string    `gorm:"primaryKey;type:text"`
	WorkspaceID string    `gorm:"type:uuid;not null;index:idx_todos_workspace_channel"`
	ChannelName string    `gorm:"type:text;not null;index:idx_todos_workspace_channel"`
	ThreadID    *string   `gorm:"type:text"`
	CreatedBy   string    `gorm:"type:text;not null;index:idx_todos_workspace_created_by"`
	Assignee    string    `gorm:"type:text;not null"`
	Content     string    `gorm:"type:text;not null"`
	Status      string    `gorm:"type:text;not null;default:pending"`
	Position    int       `gorm:"type:integer;not null;default:0"`
	CreatedAt   time.Time `gorm:"autoCreateTime;type:timestamptz"`
	UpdatedAt   time.Time `gorm:"autoCreateTime;type:timestamptz"`
}

func (TodoRecord) TableName() string {
	return "todos"
}

type TimerRecord struct {
	ID           string    `gorm:"primaryKey;type:text"`
	WorkspaceID  string    `gorm:"type:uuid;not null;index:idx_timers_workspace_channel"`
	ChannelName  string    `gorm:"type:text;not null;index:idx_timers_workspace_channel"`
	ThreadID     *string   `gorm:"type:text"`
	CreatedBy    string    `gorm:"type:text;not null"`
	Message      string    `gorm:"type:text;not null"`
	DelaySeconds int       `gorm:"type:integer;not null"`
	FiresAt      time.Time `gorm:"type:timestamptz;not null;index:idx_timers_fires_at_status"`
	Status       string    `gorm:"type:text;not null;default:active;index:idx_timers_fires_at_status"`
	CreatedAt    time.Time `gorm:"autoCreateTime;type:timestamptz"`
}

func (TimerRecord) TableName() string {
	return "timers"
}

type RoutineRecord struct {
	ID                      string     `gorm:"primaryKey;type:text"`
	WorkspaceID             string     `gorm:"type:uuid;not null;index:idx_routines_workspace_channel"`
	ChannelName             string     `gorm:"type:text;not null;index:idx_routines_workspace_channel"`
	ThreadID                *string    `gorm:"type:text"`
	CreatedBy               string     `gorm:"type:text;not null"`
	Name                    string     `gorm:"type:text;not null"`
	Message                 string     `gorm:"type:text;not null"`
	Context                 *string    `gorm:"type:text"`
	ScheduleHour            *int       `gorm:"type:integer"`
	ScheduleMinute          *int       `gorm:"type:integer"`
	ScheduleDays            []byte     `gorm:"type:jsonb"`
	ScheduleIntervalMinutes *int       `gorm:"type:integer"`
	Timezone                string     `gorm:"type:text;default:UTC"`
	NextFiresAt             time.Time  `gorm:"type:timestamptz;not null;index:idx_routines_next_fires_status"`
	LastFiredAt             *time.Time `gorm:"type:timestamptz"`
	Status                  string     `gorm:"type:text;not null;default:active;index:idx_routines_next_fires_status"`
	CreatedAt               time.Time  `gorm:"autoCreateTime;type:timestamptz"`
}

func (RoutineRecord) TableName() string {
	return "routines"
}

// ---------------------------------------------------------------------------
// Inbox & Notifications
// ---------------------------------------------------------------------------

type NotificationRecord struct {
	ID          string     `gorm:"primaryKey;type:text"`
	WorkspaceID string     `gorm:"type:uuid;not null;index:idx_notifications_workspace_status;index:idx_notifications_workspace_read"`
	CreatedBy   string     `gorm:"type:text;not null"`
	Title       string     `gorm:"type:text;not null"`
	Message     string     `gorm:"type:text;not null"`
	Priority    string     `gorm:"type:text;not null;default:normal"`
	IsRead      bool       `gorm:"type:boolean;default:false;index:idx_notifications_workspace_read"`
	ChannelName *string    `gorm:"type:text"`
	ThreadID    *string    `gorm:"type:text"`
	LinkURL     *string    `gorm:"type:text"`
	Status      string     `gorm:"type:text;not null;default:active;index:idx_notifications_workspace_status"`
	CreatedAt   time.Time  `gorm:"autoCreateTime;type:timestamptz;index:idx_notifications_created_at"`
	ReadAt      *time.Time `gorm:"type:timestamptz"`
}

func (NotificationRecord) TableName() string {
	return "notifications"
}

// ---------------------------------------------------------------------------
// Cloud Agent Configs
// ---------------------------------------------------------------------------

type CloudAgentConfig struct {
	ID           string    `gorm:"primaryKey;type:text"`
	WorkspaceID  string    `gorm:"type:uuid;not null;index:idx_cloud_agent_workspace;uniqueIndex:uq_cloud_agent_workspace_name"`
	AgentName    string    `gorm:"type:text;not null;uniqueIndex:uq_cloud_agent_workspace_name"`
	Provider     string    `gorm:"type:text;not null"`
	Model        string    `gorm:"type:text;not null"`
	Category     string    `gorm:"type:text;not null;default:chat"`
	APIKey       string    `gorm:"type:text;not null"`
	BaseURL      *string   `gorm:"type:text"`
	SystemPrompt *string   `gorm:"type:text"`
	MaxTokens    *int      `gorm:"type:integer"`
	Status       string    `gorm:"type:text;not null;default:active"`
	CreatedAt    time.Time `gorm:"autoCreateTime;type:timestamptz"`
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
	CreatedAt    time.Time `gorm:"autoCreateTime;type:timestamptz"`
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
	CreatedAt   time.Time `gorm:"autoCreateTime;type:timestamptz"`
}

func (Agent) TableName() string {
	return "agents"
}
