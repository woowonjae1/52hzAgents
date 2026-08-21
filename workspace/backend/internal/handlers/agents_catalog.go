package handlers

import (
	"errors"
	"net/http"
	"os/exec"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func detectLocalBinary(name string, aliases ...string) (bool, string) {
	if p, err := exec.LookPath(name); err == nil {
		return true, p
	}
	for _, alias := range aliases {
		if p, err := exec.LookPath(alias); err == nil {
			return true, p
		}
	}
	return false, ""
}

// GetAgentCatalog 返回本地支持的 Agent 客户端类型列表（附带本地 PATH 探测状态）
func GetAgentCatalog(c *gin.Context) {
	claudeDetected, claudePath := detectLocalBinary("claude")
	antigravityDetected, antigravityPath := detectLocalBinary("agy", "antigravity")
	openclawDetected, openclawPath := detectLocalBinary("openclaw")
	hermesDetected, hermesPath := detectLocalBinary("hermes")
	piDetected, piPath := detectLocalBinary("pi")
	codexDetected, codexPath := detectLocalBinary("codex", "chatgpt")
	cursorDetected, cursorPath := detectLocalBinary("cursor")
	aiderDetected, aiderPath := detectLocalBinary("aider")

	c.JSON(http.StatusOK, []gin.H{
		{
			"name":            "claude",
			"label":           "Claude Code",
			"description":     "Anthropic's official terminal agent for code generation and shell execution.",
			"install_command": "wwj install claude",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
			"detected":        claudeDetected,
			"binary_path":     claudePath,
		},
		{
			"name":            "antigravity",
			"label":           "Google Antigravity",
			"description":     "Google Antigravity (AGY) agentic coding platform with Gemini 3.5 models.",
			"install_command": "wwj connect antigravity",
			"homepage":        "https://antigravity.google",
			"tags":            []string{"coding", "cli", "gemini"},
			"builtin":         true,
			"detected":        antigravityDetected,
			"binary_path":     antigravityPath,
		},
		{
			"name":            "openclaw",
			"label":           "OpenClaw",
			"description":     "A community-driven coding agent with autonomous task execution capabilities.",
			"install_command": "wwj install openclaw",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
			"detected":        openclawDetected,
			"binary_path":     openclawPath,
		},
		{
			"name":            "hermes",
			"label":           "Hermes",
			"description":     "A fast and lightweight agent built for rapid software maintenance.",
			"install_command": "wwj install hermes",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
			"detected":        hermesDetected,
			"binary_path":     hermesPath,
		},
		{
			"name":            "pi",
			"label":           "Pi Agent",
			"description":     "Multi-provider coding agent CLI with read/bash/edit/write tools.",
			"install_command": "wwj install pi",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
			"detected":        piDetected,
			"binary_path":     piPath,
		},
		{
			"name":            "chatgpt",
			"label":           "ChatGPT / Codex",
			"description":     "OpenAI GPT-4o & Codex terminal assistant for intelligent software development.",
			"install_command": "wwj install chatgpt",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
			"detected":        codexDetected,
			"binary_path":     codexPath,
		},
		{
			"name":            "cursor",
			"label":           "Cursor Agent",
			"description":     "Cursor AI code editor agent CLI bridge.",
			"install_command": "wwj install cursor",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "ide"},
			"builtin":         true,
			"detected":        cursorDetected,
			"binary_path":     cursorPath,
		},
		{
			"name":            "aider",
			"label":           "Aider",
			"description":     "AI pair programming in your terminal.",
			"install_command": "wwj install aider",
			"homepage":        "https://openagents.org",
			"tags":            []string{"coding", "cli"},
			"builtin":         true,
			"detected":        aiderDetected,
			"binary_path":     aiderPath,
		},
	})
}

// GetCloudAgentProviders 返回支持的云端 Agent 厂商与模型列表
func GetCloudAgentProviders(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"providers": []gin.H{
			{
				"id": "openai", "name": "openai", "label": "OpenAI", "category": "global",
				"description": "GPT-4o, o1, and OpenAI official models",
				"doc_url":     "https://platform.openai.com/docs",
				"models": []gin.H{
					{"name": "gpt-4o", "label": "GPT-4o", "max_tokens": 4096},
					{"name": "gpt-4o-mini", "label": "GPT-4o Mini", "max_tokens": 4096},
					{"name": "o1-preview", "label": "o1 Preview", "max_tokens": 32768},
					{"name": "o1-mini", "label": "o1 Mini", "max_tokens": 65536},
					{"name": "gpt-4-turbo", "label": "GPT-4 Turbo", "max_tokens": 4096},
				},
			},
			{
				"id": "anthropic", "name": "anthropic", "label": "Anthropic", "category": "global",
				"description": "Claude 3.5 Sonnet, Claude 3 Opus, and Claude 3 Haiku",
				"doc_url":     "https://docs.anthropic.com/",
				"models": []gin.H{
					{"name": "claude-3-5-sonnet-20241022", "label": "Claude 3.5 Sonnet", "max_tokens": 8192},
					{"name": "claude-3-5-haiku-20241022", "label": "Claude 3.5 Haiku", "max_tokens": 8192},
					{"name": "claude-3-opus-20240229", "label": "Claude 3 Opus", "max_tokens": 4096},
				},
			},
			{
				"id": "openrouter", "name": "openrouter", "label": "OpenRouter", "category": "global",
				"description": "Unified API for 100+ LLMs across all major providers",
				"doc_url":     "https://openrouter.ai/docs",
				"models": []gin.H{
					{"name": "auto", "label": "Auto Best Model", "max_tokens": 8192},
					{"name": "anthropic/claude-3.5-sonnet", "label": "Claude 3.5 Sonnet (OpenRouter)", "max_tokens": 8192},
					{"name": "openai/gpt-4o", "label": "GPT-4o (OpenRouter)", "max_tokens": 4096},
					{"name": "deepseek/deepseek-chat", "label": "DeepSeek V3 (OpenRouter)", "max_tokens": 8192},
					{"name": "meta-llama/llama-3.3-70b-instruct", "label": "Llama 3.3 70B (OpenRouter)", "max_tokens": 8192},
				},
			},
			{
				"id": "google", "name": "google", "label": "Google Gemini", "category": "global",
				"description": "Gemini 1.5 Pro and Gemini 1.5 Flash",
				"doc_url":     "https://ai.google.dev/docs",
				"models": []gin.H{
					{"name": "gemini-1.5-pro", "label": "Gemini 1.5 Pro", "max_tokens": 8192},
					{"name": "gemini-1.5-flash", "label": "Gemini 1.5 Flash", "max_tokens": 8192},
					{"name": "gemini-2.0-flash-exp", "label": "Gemini 2.0 Flash Exp", "max_tokens": 8192},
				},
			},
			{
				"id": "deepseek", "name": "deepseek", "label": "DeepSeek", "category": "china",
				"description": "DeepSeek V3 & DeepSeek R1 reasoning models",
				"doc_url":     "https://platform.deepseek.com/",
				"models": []gin.H{
					{"name": "deepseek-chat", "label": "DeepSeek V3", "max_tokens": 8192},
					{"name": "deepseek-reasoner", "label": "DeepSeek R1 Reasoning", "max_tokens": 8192},
				},
			},
			{
				"id": "azure_openai", "name": "azure_openai", "label": "Azure OpenAI", "category": "enterprise",
				"description": "Microsoft Azure OpenAI Service deployments",
				"doc_url":     "https://learn.microsoft.com/azure/ai-services/openai/",
				"models": []gin.H{
					{"name": "gpt-4o", "label": "GPT-4o Deployment", "max_tokens": 4096},
					{"name": "gpt-4", "label": "GPT-4 Deployment", "max_tokens": 4096},
				},
			},
			{
				"id": "groq", "name": "groq", "label": "Groq LPU", "category": "global",
				"description": "Ultra high-speed Llama 3 & Mixtral inference",
				"doc_url":     "https://console.groq.com/docs",
				"models": []gin.H{
					{"name": "llama-3.3-70b-versatile", "label": "Llama 3.3 70B Versatile", "max_tokens": 8192},
					{"name": "mixtral-8x7b-32768", "label": "Mixtral 8x7B", "max_tokens": 8192},
				},
			},
			{
				"id": "siliconflow", "name": "siliconflow", "label": "SiliconFlow", "category": "china",
				"description": "SiliconCloud API for DeepSeek, Qwen, Yi & Hunyuan",
				"doc_url":     "https://siliconflow.cn/docs",
				"models": []gin.H{
					{"name": "deepseek-ai/DeepSeek-V3", "label": "DeepSeek V3 (SiliconFlow)", "max_tokens": 8192},
					{"name": "Qwen/Qwen2.5-72B-Instruct", "label": "Qwen 2.5 72B (SiliconFlow)", "max_tokens": 8192},
				},
			},
			{
				"id": "dashscope", "name": "dashscope", "label": "Qwen / DashScope", "category": "china",
				"description": "Alibaba Cloud DashScope Qwen Max, Plus & Turbo",
				"doc_url":     "https://help.aliyun.com/document_detail/2712195.html",
				"models": []gin.H{
					{"name": "qwen-max", "label": "Qwen Max", "max_tokens": 8192},
					{"name": "qwen-plus", "label": "Qwen Plus", "max_tokens": 8192},
					{"name": "qwen-turbo", "label": "Qwen Turbo", "max_tokens": 8192},
				},
			},
			{
				"id": "zhipu", "name": "zhipu", "label": "Zhipu GLM", "category": "china",
				"description": "Zhipu AI BigModel GLM-4 Plus & Flash",
				"doc_url":     "https://open.bigmodel.cn/dev/howuse/introduction",
				"models": []gin.H{
					{"name": "glm-4-plus", "label": "GLM-4 Plus", "max_tokens": 8192},
					{"name": "glm-4-flash", "label": "GLM-4 Flash", "max_tokens": 8192},
				},
			},
			{
				"id": "moonshot", "name": "moonshot", "label": "Moonshot / Kimi", "category": "china",
				"description": "Kimi long-context chat models",
				"doc_url":     "https://platform.moonshot.cn/docs",
				"models": []gin.H{
					{"name": "moonshot-v1-8k", "label": "Kimi Moonshot v1 8K", "max_tokens": 8192},
					{"name": "moonshot-v1-32k", "label": "Kimi Moonshot v1 32K", "max_tokens": 8192},
					{"name": "moonshot-v1-128k", "label": "Kimi Moonshot v1 128K", "max_tokens": 8192},
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
