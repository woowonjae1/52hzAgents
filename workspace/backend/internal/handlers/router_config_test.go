package handlers

import (
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	// The pure-Go driver, deliberately, not gorm.io/driver/sqlite. That one
	// needs CGO, and on a machine without a C compiler its tests SKIP while the
	// package still reports "ok" — a green run that checked nothing. This
	// driver is already a direct dependency, so these tests actually execute.
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

/*
	Which router configuration is in force.

	The bug this guards is the original one: ROUTER_LLM_* was read once into
	config.GlobalConfig at process start, so a provider chosen in the UI could
	never take effect. resolveRouterSettings is now consulted on every routing
	decision, and these pin the precedence it applies.
*/

func setupRouterConfigDB(t *testing.T) string {
	t.Helper()
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	db.DB = database
	if err := db.DB.AutoMigrate(&models.RouterConfig{}); err != nil {
		t.Fatal(err)
	}
	return uuid.NewString()
}

func storeRouterConfig(t *testing.T, workspaceID string, cfg models.RouterConfig) {
	t.Helper()
	cfg.ID = uuid.NewString()
	cfg.WorkspaceID = workspaceID
	if err := db.DB.Create(&cfg).Error; err != nil {
		t.Fatal(err)
	}
}

func TestRouterSettingsFallBackToEnvWhenUnset(t *testing.T) {
	workspaceID := setupRouterConfigDB(t)
	config.GlobalConfig = &config.Config{
		RouterLLMEnabled: true,
		RouterLLMAPIKey:  "env-key",
		RouterLLMModel:   "env-model",
	}

	got := resolveRouterSettings(workspaceID)
	if got == nil || got.RouterLLMAPIKey != "env-key" {
		t.Fatalf("a workspace with no row keeps the environment behaviour, got %+v", got)
	}
}

func TestRouterSettingsPreferTheStoredRow(t *testing.T) {
	workspaceID := setupRouterConfigDB(t)
	config.GlobalConfig = &config.Config{
		RouterLLMEnabled:  true,
		RouterLLMProvider: "anthropic",
		RouterLLMAPIKey:   "env-key",
	}
	base := "https://my-gateway.internal/v1/"
	storeRouterConfig(t, workspaceID, models.RouterConfig{
		Enabled: true, Provider: "openai", Model: "my-model", APIKey: "ws-key", BaseURL: &base,
	})

	got := resolveRouterSettings(workspaceID)
	if got == nil {
		t.Fatal("a stored, enabled row must resolve")
	}
	if got.RouterLLMAPIKey != "ws-key" || got.RouterLLMProvider != "openai" || got.RouterLLMModel != "my-model" {
		t.Fatalf("the stored row must win outright, got %+v", got)
	}
	// A trailing slash would produce ".../v1//chat/completions".
	if got.RouterLLMBaseURL != "https://my-gateway.internal/v1" {
		t.Fatalf("base URL should be normalised, got %q", got.RouterLLMBaseURL)
	}
}

func TestDisabledRowDoesNotInheritTheEnvironmentKey(t *testing.T) {
	workspaceID := setupRouterConfigDB(t)
	config.GlobalConfig = &config.Config{
		RouterLLMEnabled: true,
		RouterLLMAPIKey:  "env-key",
	}
	storeRouterConfig(t, workspaceID, models.RouterConfig{Enabled: false, Provider: "openai", APIKey: "ws-key"})

	// Turning the router off in the UI must actually turn it off, rather than
	// falling through to whatever the process was started with.
	if got := resolveRouterSettings(workspaceID); got != nil {
		t.Fatalf("a disabled row must disable routing, got %+v", got)
	}
}

func TestRowWithoutAKeyIsNotUsable(t *testing.T) {
	workspaceID := setupRouterConfigDB(t)
	config.GlobalConfig = &config.Config{RouterLLMEnabled: true, RouterLLMAPIKey: "env-key"}
	storeRouterConfig(t, workspaceID, models.RouterConfig{Enabled: true, Provider: "openai", APIKey: "   "})

	if got := resolveRouterSettings(workspaceID); got != nil {
		t.Fatalf("an enabled row with no key must not borrow the env key, got %+v", got)
	}
}

func TestMaskedKeyIsRecognised(t *testing.T) {
	masked := maskRouterSecret(models.RouterConfig{APIKey: "sk-abcdefghijklmnop"}).APIKey
	if !strings.Contains(masked, "****") {
		t.Fatalf("key should be masked, got %q", masked)
	}
	// The UI reads this value back; saving it again must not overwrite the key.
	if !isMaskedRouterSecret(masked) {
		t.Fatal("a masked key must be recognised as masked")
	}
	if isMaskedRouterSecret("sk-realkey123") {
		t.Fatal("a real key must not be mistaken for a masked one")
	}
	if short := maskRouterSecret(models.RouterConfig{APIKey: "abc"}).APIKey; short != "****" {
		t.Fatalf("a short key must not leak, got %q", short)
	}
}

func TestSavingAKeyTurnsTheRouterOn(t *testing.T) {
	// The real failure: a user filled in provider, model, key and base URL,
	// saved, and got a router that did nothing, because a separate toggle in
	// the corner of the card was still off.
	workspaceID := setupRouterConfigDB(t)
	stored := models.RouterConfig{ID: uuid.NewString(), WorkspaceID: workspaceID, Provider: "openai"}
	if err := db.DB.Create(&stored).Error; err != nil {
		t.Fatal(err)
	}

	key := "sk-live-key"
	request := routerConfigRequest{APIKey: &key}
	applyRouterRequest(&stored, request)

	if !stored.Enabled {
		t.Fatal("saving a configuration with a key must enable the router")
	}
}

func TestExplicitlyTurningItOffIsRespected(t *testing.T) {
	workspaceID := setupRouterConfigDB(t)
	stored := models.RouterConfig{
		ID: uuid.NewString(), WorkspaceID: workspaceID, Provider: "openai",
		APIKey: "sk-live-key", Enabled: true,
	}
	off := false
	applyRouterRequest(&stored, routerConfigRequest{Enabled: &off})

	if stored.Enabled {
		t.Fatal("an explicit off must stay off even though a key is present")
	}
}

func TestOutcomeIsRecordedAndOnlyOnChange(t *testing.T) {
	workspaceID := setupRouterConfigDB(t)
	storeRouterConfig(t, workspaceID, models.RouterConfig{Enabled: true, Provider: "openai", APIKey: "k"})

	recordRouterOutcome(workspaceID, fmt.Errorf("router request failed: 401 Unauthorized"))

	var after models.RouterConfig
	if err := db.DB.Where("workspace_id = ?", workspaceID).First(&after).Error; err != nil {
		t.Fatal(err)
	}
	if after.LastStatus != "failed" || after.LastError == nil {
		t.Fatalf("a failure must be recorded, got %+v", after)
	}
	if !strings.Contains(*after.LastError, "401") {
		t.Fatalf("the reason must survive, got %q", *after.LastError)
	}

	firstCheck := after.LastCheckedAt
	// The same failure again must not rewrite the row on every message.
	recordRouterOutcome(workspaceID, fmt.Errorf("router request failed: 401 Unauthorized"))
	var second models.RouterConfig
	db.DB.Where("workspace_id = ?", workspaceID).First(&second)
	if firstCheck != nil && second.LastCheckedAt != nil && !second.LastCheckedAt.Equal(*firstCheck) {
		t.Fatal("an unchanged status must not be rewritten")
	}

	// Recovery is a change, so it is written.
	recordRouterOutcome(workspaceID, nil)
	var third models.RouterConfig
	db.DB.Where("workspace_id = ?", workspaceID).First(&third)
	if third.LastStatus != "ok" || third.LastError != nil {
		t.Fatalf("recovery must clear the failure, got %+v", third)
	}
}
