package install

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/config"
)

// TestInstallMarkersAndCheck 测试安装标记的读写与安装检测逻辑。
func TestInstallMarkersAndCheck(t *testing.T) {
	// 创建临时测试用主目录。
	tempHome, err := os.MkdirTemp("", "agn_install_test_home")
	if err != nil {
		t.Fatalf("failed to create temp home: %v", err)
	}
	defer os.RemoveAll(tempHome)

	// 修改环境变量以使 config 模块指向我们的临时主目录。
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

	// 1. 初始化，应该未安装。
	if IsAgentInstalled("nonexistent-test-agent") {
		t.Error("expected 'nonexistent-test-agent' to not be installed")
	}

	// 2. 写入安装标记。
	markInstalled("nonexistent-test-agent")

	// 3. 校验列表与是否安装状态。
	list := ListInstalledAgents()
	if len(list) != 1 || list[0] != "nonexistent-test-agent" {
		t.Errorf("expected list to contain only 'nonexistent-test-agent', got %v", list)
	}

	if !IsAgentInstalled("nonexistent-test-agent") {
		t.Error("expected 'nonexistent-test-agent' to be reported as installed after marking")
	}

	// 4. 验证兼容的空文件标记。
	configDir, _ := config.GetConfigDir()
	emptyMarkerPath := filepath.Join(configDir, "installed", "nonexistent-test-agent")
	if _, err := os.Stat(emptyMarkerPath); os.IsNotExist(err) {
		t.Error("compatibility empty marker file was not created")
	}
}
