package handlers

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
	The router LLM, made configurable at runtime.

	Dynamic orchestration asks an LLM which agent should speak next. That LLM
	was configured only through ROUTER_LLM_* environment variables, read once
	into config.GlobalConfig at startup — so the setting could be shown in the
	UI but never take effect, and switching providers meant a server restart.

	These endpoints persist the choice per workspace. resolveRouterSettings
	below is the single place that decides which configuration wins.
*/

// maskRouterSecret hides all but the ends of the key, the same shape used for
// cloud agent configs. The masked value is what the UI round-trips back, which
// is why an update with a blank or masked key means "keep the stored one".
func maskRouterSecret(cfg models.RouterConfig) models.RouterConfig {
	if len(cfg.APIKey) > 8 {
		cfg.APIKey = cfg.APIKey[:3] + "****" + cfg.APIKey[len(cfg.APIKey)-4:]
	} else if len(cfg.APIKey) > 0 {
		cfg.APIKey = "****"
	}
	return cfg
}

func isMaskedRouterSecret(value string) bool {
	return strings.Contains(value, "****")
}

// resolveRouterSettings returns the router configuration in force for a
// workspace, or nil when routing by LLM is not usable.
//
// A stored row wins over the environment completely — a half-filled row must
// not silently inherit an environment key from a different provider. When no
// row exists the environment is used, so deployments that never open the
// settings page keep the behaviour they had.
func resolveRouterSettings(workspaceID string) *config.Config {
	var stored models.RouterConfig
	err := db.DB.Where("workspace_id = ?", workspaceID).First(&stored).Error
	if err == nil {
		if !stored.Enabled || strings.TrimSpace(stored.APIKey) == "" {
			return nil
		}
		baseURL := ""
		if stored.BaseURL != nil {
			baseURL = strings.TrimRight(strings.TrimSpace(*stored.BaseURL), "/")
		}
		return &config.Config{
			RouterLLMEnabled:  true,
			RouterLLMProvider: strings.ToLower(strings.TrimSpace(stored.Provider)),
			RouterLLMModel:    strings.TrimSpace(stored.Model),
			RouterLLMAPIKey:   strings.TrimSpace(stored.APIKey),
			RouterLLMBaseURL:  baseURL,
		}
	}

	settings := config.GlobalConfig
	if settings == nil || !settings.RouterLLMEnabled || settings.RouterLLMAPIKey == "" {
		return nil
	}
	return settings
}

// routerConfigRequest is intentionally all-pointer so that an omitted field is
// distinguishable from one deliberately cleared.
type routerConfigRequest struct {
	Enabled  *bool   `json:"enabled"`
	Provider *string `json:"provider"`
	Model    *string `json:"model"`
	APIKey   *string `json:"api_key"`
	BaseURL  *string `json:"base_url"`
}

func routerConfigWorkspace(c *gin.Context) (*models.Workspace, bool) {
	network := c.Query("network")
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network parameter is required"})
		return nil, false
	}
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return nil, false
	}
	token := c.GetHeader("X-Workspace-Token")
	if token == "" {
		token = c.Query("token")
	}
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return nil, false
	}
	return workspace, true
}

// GetRouterConfig returns the stored configuration, masked. When no row exists
// it reports what the environment provides, flagged with source "env", so the
// settings page can show what is actually in force rather than an empty form
// next to a router that is quietly running.
func GetRouterConfig(c *gin.Context) {
	workspace, ok := routerConfigWorkspace(c)
	if !ok {
		return
	}

	var stored models.RouterConfig
	if err := db.DB.Where("workspace_id = ?", workspace.ID).First(&stored).Error; err == nil {
		c.JSON(http.StatusOK, gin.H{"source": "workspace", "config": maskRouterSecret(stored)})
		return
	}

	settings := config.GlobalConfig
	fallback := models.RouterConfig{WorkspaceID: workspace.ID, Provider: "openai"}
	if settings != nil {
		fallback.Enabled = settings.RouterLLMEnabled && settings.RouterLLMAPIKey != ""
		if settings.RouterLLMProvider != "" {
			fallback.Provider = settings.RouterLLMProvider
		}
		fallback.Model = settings.RouterLLMModel
		fallback.APIKey = settings.RouterLLMAPIKey
		if settings.RouterLLMBaseURL != "" {
			base := settings.RouterLLMBaseURL
			fallback.BaseURL = &base
		}
	}
	c.JSON(http.StatusOK, gin.H{"source": "env", "config": maskRouterSecret(fallback)})
}

// UpdateRouterConfig upserts the workspace's router configuration.
func UpdateRouterConfig(c *gin.Context) {
	workspace, ok := routerConfigWorkspace(c)
	if !ok {
		return
	}

	var request routerConfigRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	var stored models.RouterConfig
	existing := db.DB.Where("workspace_id = ?", workspace.ID).First(&stored).Error == nil
	if !existing {
		stored = models.RouterConfig{
			ID:          uuid.New().String(),
			WorkspaceID: workspace.ID,
			Provider:    "openai",
		}
	}

	if err := applyRouterRequest(&stored, request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var err error
	if existing {
		err = db.DB.Save(&stored).Error
	} else {
		err = db.DB.Create(&stored).Error
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save router configuration"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"source": "workspace", "config": maskRouterSecret(stored)})
}

// recordRouterOutcome remembers whether the last routing call actually worked.
//
// Only writes when the status changes. A healthy router routes every message,
// and persisting "ok" each time would add a write per message for information
// that has not changed; the interesting event is the transition.
func recordRouterOutcome(workspaceID string, callErr error) {
	status := "ok"
	var detail *string
	if callErr != nil {
		status = "failed"
		message := callErr.Error()
		if len(message) > 300 {
			message = message[:300]
		}
		detail = &message
	}

	var stored models.RouterConfig
	if err := db.DB.Where("workspace_id = ?", workspaceID).First(&stored).Error; err != nil {
		// Running from environment configuration: there is no row to annotate.
		return
	}
	if stored.LastStatus == status {
		if status == "ok" {
			return
		}
		if stored.LastError != nil && detail != nil && *stored.LastError == *detail {
			return
		}
	}

	now := time.Now()
	db.DB.Model(&stored).Updates(map[string]interface{}{
		"last_status":     status,
		"last_error":      detail,
		"last_checked_at": &now,
	})
}

// TestRouterConfig makes one real call with the stored settings and reports
// what happened, so a wrong key or an unreachable gateway is discovered here
// rather than as messages silently going to the wrong agent.
func TestRouterConfig(c *gin.Context) {
	workspace, ok := routerConfigWorkspace(c)
	if !ok {
		return
	}

	settings := resolveRouterSettings(workspace.ID)
	if settings == nil {
		c.JSON(http.StatusOK, gin.H{
			"ok":     false,
			"reason": "The router is off, or has no API key. Save a key to turn it on.",
		})
		return
	}

	// A question shaped like a real routing call, small enough to be cheap.
	probe := "Participants:\n- alpha\n- beta\nMaster: (none)\n\nRecent conversation:\n(no prior messages)\n\n" +
		"Latest message from human:user:\nhello @alpha\n\nOutput exactly one line: next:<agent-name> or stop"

	decision, err := requestRouterDecision(settings, probe)
	recordRouterOutcome(workspace.ID, err)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ok": false, "reason": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "reply": strings.TrimSpace(decision)})
}

// applyRouterRequest merges an update into the stored configuration.
//
// Separate from the handler because these are the rules worth testing: which
// field wins, what a masked key means, and when the router ends up on.
func applyRouterRequest(stored *models.RouterConfig, request routerConfigRequest) error {
	if request.Enabled != nil {
		stored.Enabled = *request.Enabled
	}
	if request.Provider != nil {
		provider := strings.ToLower(strings.TrimSpace(*request.Provider))
		if provider != "openai" && provider != "anthropic" {
			return fmt.Errorf("provider must be 'openai' or 'anthropic'")
		}
		stored.Provider = provider
	}
	if request.Model != nil {
		stored.Model = strings.TrimSpace(*request.Model)
	}
	if request.BaseURL != nil {
		base := strings.TrimRight(strings.TrimSpace(*request.BaseURL), "/")
		if base == "" {
			stored.BaseURL = nil
		} else {
			stored.BaseURL = &base
		}
	}
	// A blank or masked key means "leave the stored one alone" — the UI reads
	// back a masked key, and saving an unrelated field must not erase it.
	if request.APIKey != nil {
		key := strings.TrimSpace(*request.APIKey)
		if key != "" && !isMaskedRouterSecret(key) {
			stored.APIKey = key
		}
	}

	/*
		A SAVED KEY MEANS ON, UNLESS TURNING IT OFF WAS THE POINT.

		The first version made `enabled` a toggle in the corner of the card, and
		a real user filled in provider, model, key and base URL, saved, and got
		a router that did nothing — because that toggle was still off and
		nothing said so. Filling in a configuration IS the request to use it;
		"off" is a deliberate later act, so it has to be sent explicitly.
	*/
	if request.Enabled == nil && strings.TrimSpace(stored.APIKey) != "" {
		stored.Enabled = true
	}

	if stored.Enabled && strings.TrimSpace(stored.APIKey) == "" {
		return fmt.Errorf("an API key is required to enable the router")
	}

	// A changed configuration invalidates whatever the last call reported.
	stored.LastStatus = ""
	stored.LastError = nil
	stored.LastCheckedAt = nil
	return nil
}
