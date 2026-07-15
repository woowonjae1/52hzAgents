package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestGetConfigDirAndLoadConfigMigration 测试配置文件的只读复制迁移逻辑。
func TestGetConfigDirAndLoadConfigMigration(t *testing.T) {
	// 创建临时测试用主目录。
	tempHome, err := os.MkdirTemp("", "agn_config_test_home")
	if err != nil {
		t.Fatalf("failed to create temp home: %v", err)
	}
	defer os.RemoveAll(tempHome)

	// 备份并修改环境变量以模拟主目录。
	var homeEnvVar string
	if runtime.GOOS == "windows" {
		homeEnvVar = "USERPROFILE"
	} else {
		homeEnvVar = "HOME"
	}
	oldHome := os.Getenv(homeEnvVar)
	if err := os.Setenv(homeEnvVar, tempHome); err != nil {
		t.Fatalf("failed to mock home env: %v", err)
	}
	defer os.Setenv(homeEnvVar, oldHome)

	// 1. 在模拟的旧目录中创建配置数据。
	oldDir := filepath.Join(tempHome, ".openagents")
	if err := os.MkdirAll(oldDir, 0755); err != nil {
		t.Fatalf("failed to create old dir: %v", err)
	}

	mockConfig := GlobalConfig{
		DaemonPort: "127.0.0.1:9999",
		Workspaces: make(map[string]WorkspaceConfig),
		Agents:     make(map[string]AgentConfig),
	}
	mockConfig.Agents["test-mock-agent"] = AgentConfig{
		Name: "test-mock-agent",
		Type: "claude",
	}

	oldConfigPath := filepath.Join(oldDir, "config.json")
	data, err := json.MarshalIndent(mockConfig, "", "  ")
	if err != nil {
		t.Fatalf("failed to marshal mock config: %v", err)
	}
	if err := os.WriteFile(oldConfigPath, data, 0644); err != nil {
		t.Fatalf("failed to write old config: %v", err)
	}

	// 2. 执行配置加载，这应当触发只读迁移复制。
	if err := LoadConfig(); err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	// 3. 校验新目录下的配置是否已经成功生成，且配置值一致。
	newDir := filepath.Join(tempHome, ".52hzagents")
	newConfigPath := filepath.Join(newDir, "config.json")

	if _, err := os.Stat(newConfigPath); os.IsNotExist(err) {
		t.Fatal("new config file was not copied/created")
	}

	// 读取新配置文件。
	newData, err := os.ReadFile(newConfigPath)
	if err != nil {
		t.Fatalf("failed to read new config: %v", err)
	}

	var newConfig GlobalConfig
	if err := json.Unmarshal(newData, &newConfig); err != nil {
		t.Fatalf("failed to parse new config: %v", err)
	}

	if newConfig.DaemonPort != "127.0.0.1:9999" {
		t.Errorf("expected DaemonPort 127.0.0.1:9999, got %s", newConfig.DaemonPort)
	}

	if _, exists := newConfig.Agents["test-mock-agent"]; !exists {
		t.Error("expected mock agent 'test-mock-agent' to exist in copied config")
	}

	// 4. 确保旧的配置目录和文件依然完整存在（没有被破坏）。
	if _, err := os.Stat(oldConfigPath); os.IsNotExist(err) {
		t.Error("old config.json was deleted or renamed (should remain untouched)")
	}
}
