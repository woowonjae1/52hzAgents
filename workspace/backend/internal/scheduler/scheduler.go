// Package scheduler 实现了周期和定时任务后台扫描与触发器。
package scheduler

// 导入包依赖，处理 JSON、日志以及数据库操作。
import (
	"encoding/json" // 编码事件负载。
	"fmt"
	"log"  // 打印到期任务触发日志。
	"time" // 控制轮询间隔与到期比对。

	"github.com/google/uuid" // 生成事件唯一 UUID 主键。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/compaction"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
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

		compactionCounter := 0

		// 无限循环监听计时器 Tick 信号，并带有 panic 容错恢复保护。
		for range ticker.C {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("Recovered from panic in background scheduler loop: %v", r)
					}
				}()
				expireStaleAgents()
				expirePendingApprovals()
				expireStalePipelineSteps()
				expireStaleCouncilSessions()
				fireDueTimers()   // 执行到期 Timers 触发扫描。
				fireDueRoutines() // 执行到期 Routines 触发扫描。

				// Auto-compact active channels every 60 seconds (12 ticks * 5s)
				compactionCounter++
				if compactionCounter >= 12 {
					compactionCounter = 0
					compactActiveChannels()
				}
			}()
		}
	}()
}

func expireStaleAgents() {
	if db.DB == nil {
		return
	}
	timeoutSec := 60
	if config.GlobalConfig != nil && config.GlobalConfig.AgentTimeoutSeconds > 0 {
		timeoutSec = config.GlobalConfig.AgentTimeoutSeconds
	}
	cutoff := time.Now().Add(-time.Duration(timeoutSec) * time.Second)
	cutoffUTC := time.Now().UTC().Add(-time.Duration(timeoutSec) * time.Second)
	db.DB.Model(&models.WorkspaceMember{}).
		Where("status IN ? AND (last_heartbeat IS NULL OR last_heartbeat < ? OR last_heartbeat < ?)", []string{"online", "launching"}, cutoff, cutoffUTC).
		Updates(map[string]interface{}{"status": "offline", "session_id": nil})
}

func fireDueTimers() {
	if db.DB == nil {
		return
	}
	now := time.Now().UTC()            // 获取当前的 UTC 时刻。
	var dueTimers []models.TimerRecord // 声明列表存放被捕获的到期定时器。

	// 检索状态为 active 且 fires_at 小于等于当前时间的前 50 条记录。
	//
	// 只按 UTC 比。这里曾经额外用本地时刻比了一遍，想把修复前存成本地时间的
	// 旧 timer 接回来 —— 那是个严重的错误：新数据存的是 UTC，而本地时刻比 UTC
	// 大一整个时区偏移（这里是 8 小时），于是任何 8 小时内的 timer 都会在创建
	// 后的第一个 tick 立刻触发。宁可让那几条从来没工作过的旧记录继续躺着，
	// 也不能让所有新提醒立即炸掉。
	err := db.DB.Where("status = ? AND fires_at <= ?", "active", now).
		Limit(50).Find(&dueTimers).Error
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

		// 解析创建智能体名字。
		//
		// 这里原本只剥离 openagents: 前缀，而 adapter 建 timer 时用的 source 是
		// 52hz:<agent>。于是 target_agents 里放的是 "52hz:antigravity"，而 agent
		// 侧比对的是裸名 "antigravity" —— 永远匹配不上。结果 timer 到期只是往
		// 频道里发了条消息给人看，负责它的 agent 从来没被唤醒，也就从来不会去
		// 真的执行那件事。
		agentName := handlers.AgentNameFromSource(timer.CreatedBy)

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

		if hub.GlobalHub != nil {
			hub.GlobalHub.Broadcast(hub.BroadcastMsg{
				WorkspaceID: timer.WorkspaceID,
				ChannelName: "channel/" + timer.ChannelName,
				Payload:     string(fullEventBytes),
			})
		}
		timer.Status = "fired"

		// 把看板上那条任务推进到 in_progress：定时已经把活交给 agent 了，
		// 它现在确实是在进行中，而不是还在等。
		if err := db.DB.Model(&models.TodoRecord{}).
			Where("timer_id = ? AND status = ?", timer.ID, "pending").
			Updates(map[string]interface{}{"status": "in_progress", "updated_at": time.Now()}).Error; err != nil {
			log.Printf("Timer %s fired but its task could not be advanced: %v", timer.ID, err)
		}
		if err := handlers.PublishWorkspaceStateEvent(timer.WorkspaceID, "workspace.todos.updated", "system:timer", timer.ChannelName, map[string]interface{}{
			"timer_id": timer.ID,
			"status":   "in_progress",
		}); err != nil {
			log.Printf("Timer %s task advanced but its state event could not be published: %v", timer.ID, err)
		}

		if err := handlers.PublishWorkspaceStateEvent(timer.WorkspaceID, "workspace.timer.fired", "system:timer", timer.ChannelName, map[string]interface{}{"timer": timer}); err != nil {
			log.Printf("Timer %s fired but its state event could not be published: %v", timer.ID, err)
		}

		log.Printf("Timer %s successfully fired in channel: %s", timer.ID, timer.ChannelName)
	}
}

// fireDueRoutines 扫描并触发周期性循环定时任务。
func fireDueRoutines() {
	if db.DB == nil {
		return
	}
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
			_ = json.Unmarshal(r.ScheduleDays, &days)
		}
		nextFire := handlers.ComputeNextFiresAt(r.ScheduleHour, r.ScheduleMinute, days, r.ScheduleIntervalMinutes, r.Timezone)

		// 开启原子事务抢占 Tick，避免并发重复触发
		tx := db.DB.Begin()
		res := tx.Model(&r).Where("next_fires_at = ? AND status = ?", r.NextFiresAt, "active").
			Updates(map[string]interface{}{
				"next_fires_at": nextFire,
				"last_fired_at": now,
			})

		if res.Error != nil || res.RowsAffected == 0 {
			tx.Rollback()
			continue
		}
		tx.Commit()

		// 统一调用执行器（生成 ShortID、RunID、运行状态、联动生成跟踪 Task 并广播事件）。
		// nextFire 已经在上面的抢占里写进库了，把它一并传下去：让执行器自己再算
		// 一次会在 interval 模式下得到一个晚几毫秒的时刻，并把刚写好的值覆盖掉。
		if err := handlers.ExecuteRoutineTriggerWithNext(&r, false, &nextFire); err != nil {
			log.Printf("Failed to execute routine trigger for %s: %v", r.ID, err)
		} else {
			log.Printf("Routine %s (%s, Name: %s) successfully triggered in channel: %s", r.ID, r.ShortID, r.Name, r.ChannelName)
		}
	}
}

func compactActiveChannels() {
	if db.DB == nil {
		return
	}
	var activeChannels []models.Channel
	// Scan active channels that have received events
	if err := db.DB.Where("status = ? AND last_event_at IS NOT NULL", "active").Limit(20).Find(&activeChannels).Error; err != nil {
		return
	}

	for _, ch := range activeChannels {
		res, err := compaction.CompactChannel(ch.WorkspaceID, ch.Name, nil)
		if err != nil {
			log.Printf("scheduler: compaction error on channel %s: %v", ch.Name, err)
			continue
		}
		if res != nil && !res.Skipped {
			log.Printf("scheduler: auto-compacted channel %s (%d msgs, %d tokens saved)", ch.Name, res.CompactedCount, res.TokensSaved)
		}
	}
}

// expireStalePipelineSteps checks running pipeline chains and halts any whose current step
// has exceeded AgentTimeoutSeconds (default 300s) without an agent reply.
// lastAgentActivityMs returns when this agent last emitted anything into the
// channel, which includes the status and thinking events a working agent streams
// and not just its final reply. An agent that has been silent throughout the
// step falls back to the step's start time.
func lastAgentActivityMs(workspaceID, target, agentName string, since int64) int64 {
	var rows []models.EventRecord
	if err := db.DB.
		Where("network_id = ? AND target = ? AND timestamp > ? AND source IN ?",
			workspaceID, target, since, []string{agentName, "openagents:" + agentName}).
		Order("timestamp desc").Limit(1).Find(&rows).Error; err != nil || len(rows) == 0 {
		return since
	}
	return rows[0].Timestamp
}

func expireStalePipelineSteps() {
	if db.DB == nil {
		return
	}
	// Never AgentTimeoutSeconds: that is the heartbeat liveness threshold, on the
	// order of a minute, and a coding step routinely runs far longer than that.
	timeoutSec := 1800
	if config.GlobalConfig != nil && config.GlobalConfig.PipelineStepTimeoutSeconds > 0 {
		timeoutSec = config.GlobalConfig.PipelineStepTimeoutSeconds
	}
	nowMs := time.Now().UnixMilli()
	var runningPipelines []models.ChannelPipeline
	if err := db.DB.Where("status = ?", "running").Find(&runningPipelines).Error; err != nil || len(runningPipelines) == 0 {
		return
	}

	for _, pipe := range runningPipelines {
		var steps []models.PipelineStep
		if err := json.Unmarshal(pipe.Steps, &steps); err != nil || len(steps) == 0 {
			continue
		}
		idx := pipe.CurrentIndex
		if idx < 0 || idx >= len(steps) {
			continue
		}
		if steps[idx].Status != "running" || steps[idx].StartedAt == nil {
			continue
		}

		if (nowMs-*steps[idx].StartedAt)/1000 < int64(timeoutSec) {
			continue
		}

		var ch models.Channel
		if err := db.DB.Where("id = ?", pipe.ChannelID).First(&ch).Error; err != nil {
			continue
		}
		target := "channel/" + ch.Name

		// The step has been open a long time, but that alone does not mean the
		// agent is gone: a coding agent emits status and thinking events all the
		// way through a long task. Reap on *silence*, not on duration, or the
		// deadline kills work that is visibly in progress.
		lastSeen := lastAgentActivityMs(pipe.WorkspaceID, target, steps[idx].Agent, *steps[idx].StartedAt)
		elapsedSec := (nowMs - lastSeen) / 1000
		if elapsedSec >= int64(timeoutSec) {
			// Mark this step and pipeline as failed
			steps[idx].Status = "failed"
			errStr := fmt.Sprintf("Step execution timed out after %d seconds without agent response", elapsedSec)
			steps[idx].LastError = &errStr
			steps[idx].FinishedAt = &nowMs

			encoded, _ := json.Marshal(steps)
			res := db.DB.Model(&models.ChannelPipeline{}).
				Where("id = ? AND current_index = ? AND status = ?", pipe.ID, idx, "running").
				Updates(map[string]interface{}{
					"steps":  encoded,
					"status": "failed",
				})

			if res.Error == nil && res.RowsAffected > 0 {
				haltMsg := fmt.Sprintf("⚠️ [Pipeline Halted: Timeout] Step %d (@%s) went silent for %d seconds.\nHuman intervention required.",
					idx+1, steps[idx].Agent, elapsedSec)
				handlers.RelayPipelineAlert(pipe.WorkspaceID, target, haltMsg)
				log.Printf("scheduler: pipeline %s step %d (@%s) silent for %ds and was halted", pipe.ID, idx+1, steps[idx].Agent, elapsedSec)
			}
		}
	}
}

// expirePendingApprovals marks expired human review approvals as 'expired'.
func expirePendingApprovals() {
	if db.DB == nil {
		return
	}
	now := time.Now().UTC()
	// 1. Approvals with explicit ExpiresAt
	db.DB.Model(&models.AgentApprovalRecord{}).
		Where("status = ? AND expires_at IS NOT NULL AND expires_at < ?", "pending", now).
		Updates(map[string]interface{}{"status": "expired"})

	// 2. Legacy pending approvals created > 24 hours ago
	cutoff24h := now.Add(-24 * time.Hour)
	db.DB.Model(&models.AgentApprovalRecord{}).
		Where("status = ? AND expires_at IS NULL AND created_at < ?", "pending", cutoff24h).
		Updates(map[string]interface{}{"status": "expired"})
}

// expireStaleCouncilSessions monitors active council sessions and transitions to budget_exhausted if challenger times out.
func expireStaleCouncilSessions() {
	if db.DB == nil {
		return
	}
	timeoutSec := 1800
	if config.GlobalConfig != nil && config.GlobalConfig.PipelineStepTimeoutSeconds > 0 {
		timeoutSec = config.GlobalConfig.PipelineStepTimeoutSeconds
	}
	nowMs := time.Now().UnixMilli()

	var sessions []models.CouncilSession
	if err := db.DB.Where("status = ? AND challenge_deadline_at IS NOT NULL", models.CouncilStatusDebating).Find(&sessions).Error; err != nil || len(sessions) == 0 {
		return
	}

	for _, sess := range sessions {
		if sess.ChallengeDeadlineAt == nil || nowMs < *sess.ChallengeDeadlineAt {
			continue
		}

		var lastAct models.SpeechActRecord
		var lastActivityMs int64 = sess.CreatedAt.UnixMilli()
		if err := db.DB.Where("session_id = ?", sess.ID).Order("created_at desc").First(&lastAct).Error; err == nil {
			lastActivityMs = lastAct.CreatedAt.UnixMilli()
		}

		elapsedSec := (nowMs - lastActivityMs) / 1000
		if elapsedSec >= int64(timeoutSec) {
			res := db.DB.Model(&models.CouncilSession{}).
				Where("id = ? AND status = ?", sess.ID, models.CouncilStatusDebating).
				Update("status", models.CouncilStatusBudgetExhausted)

			if res.RowsAffected > 0 {
				log.Printf("scheduler: council session %s timed out waiting for challenger @%s (%ds silent)", sess.ID, sess.MandatoryChallenger, elapsedSec)

				var ch models.Channel
				if err := db.DB.Where("id = ?", sess.ChannelID).First(&ch).Error; err == nil {
					targetChan := "channel/" + ch.Name
					eventID := uuid.New().String()
					alertPayload := map[string]interface{}{
						"content": fmt.Sprintf("⚠️ **[Council Alert] Challenger Timeout**\n\n"+
							"Mandatory Challenger @%s was silent for %d seconds without adversarial review.\n"+
							"Council session `%s` (%s) has halted and escalated to Human Chairman for arbitration.",
							sess.MandatoryChallenger, elapsedSec, sess.ID, sess.Topic),
						"sender_name":  "Council Supervisor",
						"sender_type":  "system",
						"message_type": "chat",
					}
					alertMetadata := map[string]interface{}{
						"speech_act":    true,
						"act_type":      "CHALLENGE_TIMEOUT",
						"session_id":    sess.ID,
						"target_agents": []string{sess.ProposerAgent},
					}

					payloadBytes, _ := json.Marshal(alertPayload)
					metaBytes, _ := json.Marshal(alertMetadata)
					eventRec := models.EventRecord{
						ID:         eventID,
						NetworkID:  sess.WorkspaceID,
						Type:       "workspace.message.posted",
						Source:     "system:council",
						Target:     targetChan,
						Payload:    payloadBytes,
						Metadata:   metaBytes,
						Timestamp:  nowMs,
						Visibility: "channel",
					}
					_ = db.DB.Create(&eventRec)

					if hub.GlobalHub != nil {
						fullEvent, _ := json.Marshal(map[string]interface{}{
							"id":        eventID,
							"event_id":  eventID,
							"network":   sess.WorkspaceID,
							"type":      "workspace.message.posted",
							"source":    "system:council",
							"target":    targetChan,
							"payload":   alertPayload,
							"metadata":  alertMetadata,
							"timestamp": nowMs,
							"status":    "confirmed",
						})
						hub.GlobalHub.Broadcast(hub.BroadcastMsg{
							WorkspaceID: sess.WorkspaceID,
							ChannelName: targetChan,
							Payload:     string(fullEvent),
						})
					}
				}
			}
		}
	}
}
