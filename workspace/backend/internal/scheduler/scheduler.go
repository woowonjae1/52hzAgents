// Package scheduler 实现了周期和定时任务后台扫描与触发器。
package scheduler

// 导入包依赖，处理 JSON、日志以及数据库操作。
import (
	"encoding/json" // 编码事件负载。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"log"  // 打印到期任务触发日志。
	"time" // 控制轮询间隔与到期比对。

	"github.com/google/uuid"                                               // 生成事件唯一 UUID 主键。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"       // 数据库操作。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/handlers" // 引入 ComputeNextFiresAt 算法。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"      // 内存广播 Hub。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"   // 表模型结构体。
)

// StartScheduler 启动定时任务常驻协程，每 5 秒进行一次库扫描。
func StartScheduler() {
	// 开启异步协程。
	go func() {
		log.Println("Starting background scheduler loop...")
		// 设定 5 秒的心跳计时器。
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop() // 方法结束时释放计时器。

		// 无限循环监听计时器 Tick 信号。
		for range ticker.C {
			expireStaleAgents()
			fireDueTimers()   // 执行到期 Timers 触发扫描。
			fireDueRoutines() // 执行到期 Routines 触发扫描。
		}
	}()
}

// fireDueTimers 扫描并触发到期的单次定时消息提醒。
func expireStaleAgents() {
	cutoff := time.Now().UTC().Add(-time.Duration(config.GlobalConfig.AgentTimeoutSeconds) * time.Second)
	db.DB.Model(&models.WorkspaceMember{}).
		Where("status = ? AND last_heartbeat IS NOT NULL AND last_heartbeat < ?", "online", cutoff).
		Updates(map[string]interface{}{"status": "offline", "session_id": nil})
}

func fireDueTimers() {
	now := time.Now().UTC()            // 获取当前的 UTC 时刻。
	var dueTimers []models.TimerRecord // 声明列表存放被捕获的到期定时器。

	// 检索状态为 active 且 fires_at 小于等于当前时间的前 50 条记录。
	err := db.DB.Where("status = ? AND fires_at <= ?", "active", now).Limit(50).Find(&dueTimers).Error
	if err != nil {
		return // 发生查询错误时安全跳过本周期。
	}

	// 遍历每个到期的定时器进行触发处理。
	for _, timer := range dueTimers {
		// 开启事务保护。
		tx := db.DB.Begin()

		// 原子更新定时器状态为已触发 fired。
		claim := tx.Model(&models.TimerRecord{}).
			Where("id = ? AND status = ?", timer.ID, "active").
			Update("status", "fired")
		if claim.Error != nil || claim.RowsAffected == 0 {
			tx.Rollback() // 异常回滚。
			continue
		}

		// 解析创建智能体名字（去除 openagents: 前缀）。
		agentName := timer.CreatedBy
		if len(agentName) > 11 && agentName[:11] == "openagents:" {
			agentName = agentName[11:]
		}

		// 格式化输出消息内容。
		content := "⏰ Timer fired (set by @" + agentName + "): " + timer.Message
		eventID := uuid.New().String()
		nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)

		// 组装 Payload 数据。
		payloadData := map[string]interface{}{
			"content":      content,
			"message_type": "chat",
		}
		payloadBytes, _ := json.Marshal(payloadData)

		metadataData := map[string]interface{}{
			"target_agents": []string{agentName},
		}
		metadataBytes, _ := json.Marshal(metadataData)

		// 组装持久化的 EventRecord 数据。
		eventRec := models.EventRecord{
			ID:         eventID,
			NetworkID:  timer.WorkspaceID,
			Type:       "workspace.message.posted",
			Source:     "system:timer",
			Target:     "channel/" + timer.ChannelName,
			Payload:    payloadBytes,
			Metadata:   metadataBytes,
			Timestamp:  nowUnixMs,
			Visibility: "channel",
		}

		// 持久化保存写入事件表。
		if err := tx.Create(&eventRec).Error; err != nil {
			tx.Rollback() // 回滚。
			continue
		}

		// 提交事务。
		if err := tx.Commit().Error; err != nil {
			continue
		}

		// 序列化后推送广播。
		fullEventBytes, _ := json.Marshal(map[string]interface{}{
			"id":         eventRec.ID,
			"network":    eventRec.NetworkID,
			"type":       eventRec.Type,
			"source":     eventRec.Source,
			"target":     eventRec.Target,
			"payload":    payloadData,
			"metadata":   metadataData,
			"timestamp":  eventRec.Timestamp,
			"visibility": eventRec.Visibility,
		})

		hub.GlobalHub.Broadcast(hub.BroadcastMsg{
			WorkspaceID: timer.WorkspaceID,
			ChannelName: "channel/" + timer.ChannelName,
			Payload:     string(fullEventBytes),
		})
		timer.Status = "fired"
		if err := handlers.PublishWorkspaceStateEvent(timer.WorkspaceID, "workspace.timer.fired", "system:timer", timer.ChannelName, map[string]interface{}{"timer": timer}); err != nil {
			log.Printf("Timer %s fired but its state event could not be published: %v", timer.ID, err)
		}

		log.Printf("Timer %s successfully fired in channel: %s", timer.ID, timer.ChannelName)
	}
}

// fireDueRoutines 扫描并触发周期性循环定时任务。
func fireDueRoutines() {
	now := time.Now().UTC()                // 当前 UTC 时间。
	var dueRoutines []models.RoutineRecord // 存储临时结果。

	// 检索状态为 active 且下一次触发时间小于当前时间的前 50 条周期任务。
	err := db.DB.Where("status = ? AND next_fires_at <= ?", "active", now).Limit(50).Find(&dueRoutines).Error
	if err != nil {
		return
	}

	// 遍历处理。
	for _, r := range dueRoutines {
		// 计算下一次触发时刻。
		var days []int
		if len(r.ScheduleDays) > 0 {
			_ = json.Unmarshal(r.ScheduleDays, &days) // 反序列化出周期星期数组。
		}
		nextFire := handlers.ComputeNextFiresAt(r.ScheduleHour, r.ScheduleMinute, days, r.ScheduleIntervalMinutes)

		// 开启原子事务。
		tx := db.DB.Begin()

		// 试图更新 next_fires_at 声明抢占此 Tick。
		// 在高并发多副本运行下，只有 GORM 影响行数大于 0 的才算抢占成功，避免重复触发。
		res := tx.Model(&r).Where("next_fires_at = ? AND status = ?", r.NextFiresAt, "active").
			Updates(map[string]interface{}{
				"next_fires_at": nextFire,
				"last_fired_at": now,
			})

		if res.Error != nil || res.RowsAffected == 0 {
			tx.Rollback() // 抢占失败（已被其他工作线程更新），回滚跳过。
			continue
		}

		// 拼接周期背景上下文和触发消息。
		content := "Routine \"" + r.Name + "\" fired: " + r.Message
		if r.Context != nil && *r.Context != "" {
			content = "**Routine Context for \"" + r.Name + "\"**\n\n" + *r.Context + "\n\n---\n\n" + content
		}

		eventID := uuid.New().String()
		nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)

		payloadData := map[string]interface{}{
			"content":      content,
			"message_type": "chat",
		}
		payloadBytes, _ := json.Marshal(payloadData)

		metadataData := map[string]interface{}{
			"target_agents": []string{r.CreatedBy},
		}
		metadataBytes, _ := json.Marshal(metadataData)

		// 组装 EventRecord。
		eventRec := models.EventRecord{
			ID:         eventID,
			NetworkID:  r.WorkspaceID,
			Type:       "workspace.message.posted",
			Source:     "system:routine",
			Target:     "channel/" + r.ChannelName,
			Payload:    payloadBytes,
			Metadata:   metadataBytes,
			Timestamp:  nowUnixMs,
			Visibility: "channel",
		}

		// 写入事件表中持久化。
		if err := tx.Create(&eventRec).Error; err != nil {
			tx.Rollback()
			continue
		}

		// 提交抢占成功后的所有数据写入。
		if err := tx.Commit().Error; err != nil {
			continue
		}

		// 广播给前端或 Agent 连接器。
		fullEventBytes, _ := json.Marshal(map[string]interface{}{
			"id":         eventRec.ID,
			"network":    eventRec.NetworkID,
			"type":       eventRec.Type,
			"source":     eventRec.Source,
			"target":     eventRec.Target,
			"payload":    payloadData,
			"metadata":   metadataData,
			"timestamp":  eventRec.Timestamp,
			"visibility": eventRec.Visibility,
		})

		hub.GlobalHub.Broadcast(hub.BroadcastMsg{
			WorkspaceID: r.WorkspaceID,
			ChannelName: "channel/" + r.ChannelName,
			Payload:     string(fullEventBytes),
		})
		r.NextFiresAt = nextFire
		r.LastFiredAt = &now
		if err := handlers.PublishWorkspaceStateEvent(r.WorkspaceID, "workspace.routine.fired", "system:routine", r.ChannelName, map[string]interface{}{"routine": r}); err != nil {
			log.Printf("Routine %s fired but its state event could not be published: %v", r.ID, err)
		}

		log.Printf("Routine %s (Name: %s) successfully fired in channel: %s", r.ID, r.Name, r.ChannelName)
	}
}
