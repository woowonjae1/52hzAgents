package evaluator

import (
	"strings"
	"testing"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func TestExtractDeliverableAndFormatPrompt(t *testing.T) {
	step := models.PipelineStep{
		Agent:       "antigravity",
		Instruction: "检查当前项目中 Go 后端都覆盖了哪些核心知识点",
	}

	messages := []string{
		`我已对当前项目中的 Go 知识覆盖体系进行了全面检查。基于 lib/data.ts 的学习路线配置以及相关设计文档 docs/auth-design.md，我整理了一份详尽的分析报告。
总结核心要点：
* 基础篇覆盖基本类型与 Zero Value、指针、切片 slice 与 map
* 并发篇覆盖 GMP 调度模型、通道 channel、sync.WaitGroup 与显式 context
* Web与中间件覆盖 Gin 路由、GORM 事务与 go-redis
建议补充哪些进阶场景？`,
	}

	deliverable := ExtractDeliverable("antigravity", step, messages, "")
	if deliverable == nil {
		t.Fatalf("expected non-nil deliverable")
	}

	if deliverable.Summary == "" {
		t.Errorf("expected non-empty summary")
	}
	if len(deliverable.KeyFindings) == 0 {
		t.Errorf("expected key findings to be extracted, got 0")
	}
	if len(deliverable.Artifacts) == 0 {
		t.Errorf("expected artifacts (docs/auth-design.md or lib/data.ts) to be extracted, got %v", deliverable.Artifacts)
	}

	nextInstruction := "你认为对于 Java 转 Go 的工程师还可以补充哪些进阶场景？"
	relayPrompt := FormatRelayPrompt("claude", "antigravity", deliverable, nextInstruction)

	if !strings.Contains(relayPrompt, "@claude") {
		t.Errorf("expected prompt to target @claude")
	}
	if !strings.Contains(relayPrompt, "Prior Stage Deliverables (from @antigravity)") {
		t.Errorf("expected prompt to contain deliverable header")
	}
	if !strings.Contains(relayPrompt, "Next Hop Task & Directives") {
		t.Errorf("expected prompt to contain next instruction header")
	}
	if !strings.Contains(relayPrompt, nextInstruction) {
		t.Errorf("expected prompt to contain next instruction text")
	}
}
