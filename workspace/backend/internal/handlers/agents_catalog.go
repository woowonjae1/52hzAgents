package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

// GetAgentCatalog 返回本地支持的 Agent 客户端类型列表
func GetAgentCatalog(c *gin.Context) {
	c.JSON(http.StatusOK, []gin.H{
		{
			"name":            "claude",
			"label":           "Claude Code",
			"description":     "Anthropic's official terminal agent for code generation and shell execution.",
			"install_command": "wwj install claude",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
		},
		{
			"name":            "openclaw",
			"label":           "OpenClaw",
			"description":     "A community-driven coding agent with autonomous task execution capabilities.",
			"install_command": "wwj install openclaw",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
		},
		{
			"name":            "codex",
			"label":           "Codex CLI",
			"description":     "OpenAI Codex terminal assistant for natural language shell scripting.",
			"install_command": "wwj install codex",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
		},
		{
			"name":            "aider",
			"label":           "Aider",
			"description":     "A developer-focused command line tool for coding with LLMs in git repositories.",
			"install_command": "wwj install aider",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
		},
		{
			"name":            "goose",
			"label":           "Goose",
			"description":     "Block's open-source tool-using agent specialized in coding tasks.",
			"install_command": "wwj install goose",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
		},
		{
			"name":            "cline",
			"label":           "Cline",
			"description":     "An autonomous developer agent that can run commands, edit files, and build apps.",
			"install_command": "wwj install cline",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
		},
		{
			"name":            "hermes",
			"label":           "Hermes",
			"description":     "A fast and lightweight agent built for rapid software maintenance.",
			"install_command": "wwj install hermes",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
		},
		{
			"name":            "kilo",
			"label":           "Kilo",
			"description":     "A distributed container agent tailored for orchestration and monitoring.",
			"install_command": "wwj install kilo",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
		},
		{
			"name":            "pi",
			"label":           "Pi Agent",
			"description":     "A mathematical and reasoning agent designed for algorithmic challenges.",
			"install_command": "wwj install pi",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
		},
		{
			"name":            "custom",
			"label":           "Custom",
			"description":     "Define and connect your own custom agent client using our protocol wrapper.",
			"install_command": "wwj create my-agent --type custom",
			"homepage":        "https://openagents.org",
			"tags":            []string{"custom"},
			"builtin":         false,
		},
	})
}

// GetCloudAgentProviders 返回支持的云端 Agent 厂商与模型列表
func GetCloudAgentProviders(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"providers": []gin.H{
			{
				"name":  "openai",
				"label": "OpenAI",
				"models": []gin.H{
					{"name": "gpt-4o", "label": "GPT-4o", "max_tokens": 4096},
					{"name": "gpt-4-turbo", "label": "GPT-4 Turbo", "max_tokens": 4096},
				},
			},
			{
				"name":  "anthropic",
				"label": "Anthropic",
				"models": []gin.H{
					{"name": "claude-3-5-sonnet", "label": "Claude 3.5 Sonnet", "max_tokens": 8192},
					{"name": "claude-3-opus", "label": "Claude 3 Opus", "max_tokens": 4096},
				},
			},
		},
	})
}

// maskCloudAgentSecret returns a copy safe to serialize. The stored provider key
// is never echoed back to a client — only enough of it to recognise which key is
// configured. Takes its argument by value so the caller's record is untouched.
func maskCloudAgentSecret(cfg models.CloudAgentConfig) models.CloudAgentConfig {
	if len(cfg.APIKey) > 8 {
		cfg.APIKey = cfg.APIKey[:3] + "****" + cfg.APIKey[len(cfg.APIKey)-4:]
	} else if len(cfg.APIKey) > 0 {
		cfg.APIKey = "****"
	}
	return cfg
}

// ListCloudAgents 列出特定工作区下的云端 Agent 配置
func ListCloudAgents(c *gin.Context) {
	network := c.Query("network")
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network parameter is required"})
		return
	}

	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	token := c.GetHeader("X-Workspace-Token")
	if token == "" {
		token = c.Query("token")
	}
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	var configs []models.CloudAgentConfig
	if err := db.DB.Where("workspace_id = ?", workspace.ID).Find(&configs).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch cloud agent configurations"})
		return
	}

	maskedConfigs := make([]models.CloudAgentConfig, len(configs))
	for i, cfg := range configs {
		maskedConfigs[i] = maskCloudAgentSecret(cfg)
	}

	c.JSON(http.StatusOK, gin.H{
		"cloud_agents": maskedConfigs,
	})
}

// AddCloudAgentRequest 新增云端 Agent 的请求参数
type AddCloudAgentRequest struct {
	Network      string  `json:"network" binding:"required"`
	AgentName    string  `json:"agent_name" binding:"required"`
	Provider     string  `json:"provider" binding:"required"`
	Model        string  `json:"model" binding:"required"`
	APIKey       string  `json:"api_key" binding:"required"`
	BaseURL      *string `json:"base_url"`
	SystemPrompt *string `json:"system_prompt"`
	MaxTokens    *int    `json:"max_tokens"`
}

// AddCloudAgent 创建新的云端 Agent 配置
func AddCloudAgent(c *gin.Context) {
	var req AddCloudAgentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	token := c.GetHeader("X-Workspace-Token")
	if token == "" {
		token = c.Query("token")
	}
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	// 检查是否重名
	var existing models.CloudAgentConfig
	err = db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, req.AgentName).First(&existing).Error
	if err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Cloud agent with this name already exists"})
		return
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error checking agent name"})
		return
	}

	config := models.CloudAgentConfig{
		ID:           uuid.New().String(),
		WorkspaceID:  workspace.ID,
		AgentName:    req.AgentName,
		Provider:     req.Provider,
		Model:        req.Model,
		APIKey:       req.APIKey,
		BaseURL:      req.BaseURL,
		SystemPrompt: req.SystemPrompt,
		MaxTokens:    req.MaxTokens,
		Status:       "active",
	}

	if err := db.DB.Create(&config).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create cloud agent configuration"})
		return
	}

	// Masked on the way out: the key is persisted in full for the agent to use,
	// but echoing it back to the caller would re-expose it on every create/update.
	c.JSON(http.StatusOK, maskCloudAgentSecret(config))
}

// UpdateCloudAgentRequest 更新云端 Agent 的请求参数
type UpdateCloudAgentRequest struct {
	Network      string  `json:"network" binding:"required"`
	Model        *string `json:"model"`
	APIKey       *string `json:"api_key"`
	SystemPrompt *string `json:"system_prompt"`
	MaxTokens    *int    `json:"max_tokens"`
	Status       *string `json:"status"`
}

// UpdateCloudAgent 修改已有的云端 Agent 配置
func UpdateCloudAgent(c *gin.Context) {
	agentName := c.Param("agent_name")
	if agentName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "agent_name parameter is required"})
		return
	}

	var req UpdateCloudAgentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	token := c.GetHeader("X-Workspace-Token")
	if token == "" {
		token = c.Query("token")
	}
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	var config models.CloudAgentConfig
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).First(&config).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Cloud agent not found"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch cloud agent configuration"})
		}
		return
	}

	// 应用更新
	if req.Model != nil {
		config.Model = *req.Model
	}
	if req.APIKey != nil {
		config.APIKey = *req.APIKey
	}
	if req.SystemPrompt != nil {
		config.SystemPrompt = req.SystemPrompt
	}
	if req.MaxTokens != nil {
		config.MaxTokens = req.MaxTokens
	}
	if req.Status != nil {
		config.Status = *req.Status
	}

	if err := db.DB.Save(&config).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update cloud agent configuration"})
		return
	}

	// Masked on the way out: the key is persisted in full for the agent to use,
	// but echoing it back to the caller would re-expose it on every create/update.
	c.JSON(http.StatusOK, maskCloudAgentSecret(config))
}

// RemoveCloudAgent 删除指定的云端 Agent 配置
func RemoveCloudAgent(c *gin.Context) {
	agentName := c.Param("agent_name")
	if agentName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "agent_name parameter is required"})
		return
	}

	network := c.Query("network")
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network parameter is required"})
		return
	}

	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	token := c.GetHeader("X-Workspace-Token")
	if token == "" {
		token = c.Query("token")
	}
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	var config models.CloudAgentConfig
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).First(&config).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Cloud agent not found"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch cloud agent configuration"})
		}
		return
	}

	if err := db.DB.Delete(&config).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete cloud agent configuration"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
