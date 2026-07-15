// Package registry 负责加载与解析智能体注册表数据（包括预置参数与默认启动命令）。
package registry

// 导入必要的系统与嵌入库。
import (
	_ "embed"       // 引入 Go 内置的静态文件嵌入机制。
	"encoding/json" // 解析 JSON。
	"log"           // 打印异常。
)

// RegistryEntry 代表单个 Agent 在注册表中的属性。
type RegistryEntry struct {
	Name        string `json:"name"`        // 智能体类型名称 (如 claude)
	Label       string `json:"label"`       // 显示标签
	Description string `json:"description"` // 描述

	Install struct {
		Binary string `json:"binary"` // 安装后的可执行二进制名称 (如 claude)
	} `json:"install"`

	Launch struct {
		Args []string `json:"args"` // 默认启动命令行参数
	} `json:"launch"`
}

// 嵌入项目内的 registry.json 作为静态二进制数据，编译后随主程序一起打包，免除外部依赖分发。
//go:embed registry.json
var registryJSON []byte

// catalog 缓存加载解析后的所有注册表项。
var catalog []RegistryEntry

// init 在包加载时自动运行，执行 JSON 解析。
func init() {
	if err := json.Unmarshal(registryJSON, &catalog); err != nil {
		log.Printf("Warning: failed to parse embedded registry.json: %v", err)
		catalog = make([]RegistryEntry, 0)
	}
}

// GetEntry 根据智能体类型名称检索获取对应的注册表项信息。
func GetEntry(agentType string) *RegistryEntry {
	for _, entry := range catalog {
		if entry.Name == agentType {
			return &entry
		}
	}
	return nil
}
