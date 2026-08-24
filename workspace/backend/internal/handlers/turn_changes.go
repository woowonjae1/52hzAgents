package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/evaluator"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// Turn-change attribution answers a question plain git status cannot: of the
// files that are dirty right now, which ones did *this* agent touch during
// *this* task, and which were already dirty before it started.
//
// The mechanism is deliberately non-perturbing. It shells out to read-only git
// commands and stats files, and the one thing it does write -- a pre-turn
// snapshot commit plus the ref that pins it -- lands in the object database and
// a private ref namespace, never in the index, the working tree, or the stash
// stack. The human and the agent are both editing that directory live, so an
// attribution feature must not disturb what it measures.

const (
	// turnGitTimeout bounds fingerprinting. The dispatch-side snapshot runs
	// before the message is broadcast to the agent, so it sits on the user's
	// send latency; a slow or huge repository must degrade to "unavailable"
	// rather than stall the channel.
	turnGitTimeout = 3 * time.Second

	// Dirty files are read once per snapshot to hash their content, and, when
	// untracked, to count their lines. Both budgets keep a directory full of
	// large generated files from turning a snapshot into a full-tree scan; a
	// file past the per-file cap keeps only its size and mtime.
	maxFingerprintFileBytes  = 4 << 20
	maxFingerprintTotalBytes = 64 << 20

	// A turn whose agent never reports back would otherwise stay open forever
	// and make every later turn on that directory look contended.
	turnStaleAfter = 6 * time.Hour

	// checkpointRetention bounds how long a pre-turn snapshot stays restorable.
	// Every dispatch pins one commit, so without a window the refs -- and the
	// whole trees they keep alive -- would accumulate for the life of the repo.
	checkpointRetention = 7 * 24 * time.Hour

	// checkpointPruneBatch bounds the pruning work one dispatch may do.
	checkpointPruneBatch = 50
)

// checkpointRefPrefix namespaces the refs that keep pre-turn snapshots alive.
// A private namespace keeps them out of `git branch`, `git tag`, and pushes.
const checkpointRefPrefix = "refs/52hz/checkpoints/"

// turnFileFingerprint identifies the state of one dirty path precisely enough to
// tell "the agent edited this file further" from "the file was already like
// this". Neither numstat nor size is enough on its own: replacing a line leaves
// the +/- counts and the byte length identical, so content is hashed. Files past
// the per-file read cap fall back to size and mtime, which is why both are kept.
type turnFileFingerprint struct {
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Size      int64  `json:"size"`
	ModNanos  int64  `json:"mod_nanos"`
	Hash      uint64 `json:"hash,omitempty"`
}

func (f turnFileFingerprint) differsFrom(other turnFileFingerprint) bool {
	return f.Status != other.Status ||
		f.Additions != other.Additions ||
		f.Deletions != other.Deletions ||
		f.Size != other.Size ||
		f.ModNanos != other.ModNanos ||
		f.Hash != other.Hash
}

// turnSnapshot is the state of a working directory at one instant: HEAD plus a
// fingerprint of every path git considers dirty.
type turnSnapshot struct {
	Head  string                         `json:"head"`
	Files map[string]turnFileFingerprint `json:"files"`
}

// turnFileChange is one attributed file. Additions/Deletions are the file's
// total current diff against the turn's base commit, with the portion that
// already existed at dispatch reported separately in BaseAdditions and
// BaseDeletions. Subtracting the two to synthesise "the agent's share" would be
// a fabrication -- a rewritten hunk can shrink the total -- so both are
// surfaced and the presentation layer decides how to phrase it.
type turnFileChange struct {
	Path          string `json:"path"`
	Status        string `json:"status"`
	Additions     int    `json:"additions"`
	Deletions     int    `json:"deletions"`
	BaseAdditions int    `json:"base_additions,omitempty"`
	BaseDeletions int    `json:"base_deletions,omitempty"`
	// PreExisting marks a file that was already dirty when the turn started.
	PreExisting bool `json:"pre_existing,omitempty"`
	// Committed marks a file whose change landed in a commit made during the
	// turn, so it is no longer visible in git status.
	Committed bool `json:"committed,omitempty"`
	// Reverted marks a file that was dirty at dispatch and is clean now: the
	// agent undid an edit the human had not committed. Silently dropping this
	// is the most damaging thing an attribution panel can do.
	Reverted bool `json:"reverted,omitempty"`
}

// Snapshots of one directory are serialised so a close and a subsequent open
// cannot interleave and read a half-written tree.
var turnDirLocks sync.Map // normalised dir -> *sync.Mutex

func lockTurnDir(dir string) func() {
	key := strings.ToLower(filepath.Clean(dir))
	value, _ := turnDirLocks.LoadOrStore(key, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// captureTurnSnapshot fingerprints a working directory. It returns an error only
// for conditions that make attribution impossible, so callers can record the
// reason instead of persisting a misleadingly empty change set.
func captureTurnSnapshot(dir string) (*turnSnapshot, error) {
	if _, err := runGitTimeout(dir, turnGitTimeout, "rev-parse", "--is-inside-work-tree"); err != nil {
		return nil, errors.New("not a git repository")
	}

	snap := &turnSnapshot{Files: map[string]turnFileFingerprint{}}
	// An unborn HEAD (fresh repo, no commits) is not an error: every file is
	// simply untracked, and the empty base commit is handled at close time.
	if head, err := runGitTimeout(dir, turnGitTimeout, "rev-parse", "HEAD"); err == nil {
		snap.Head = strings.TrimSpace(head)
	}

	lineStats := readNumstat(dir, "diff", "--numstat")
	for path, stats := range readNumstat(dir, "diff", "--cached", "--numstat") {
		prev := lineStats[path]
		lineStats[path] = [2]int{prev[0] + stats[0], prev[1] + stats[1]}
	}

	porcelain, err := runGitTimeout(dir, turnGitTimeout, "status", "--porcelain=v1", "-z")
	if err != nil {
		return nil, errors.New("git status failed: " + err.Error())
	}

	bytesRead := int64(0)
	for _, record := range strings.Split(porcelain, "\x00") {
		if len(record) < 4 {
			continue
		}
		indexStatus := record[0:1]
		workStatus := record[1:2]
		path := record[3:]

		letter := indexStatus
		if indexStatus == " " || indexStatus == "?" {
			letter = workStatus
		}
		letter = strings.TrimSpace(letter)

		stats := lineStats[path]
		fp := turnFileFingerprint{Status: letter, Additions: stats[0], Deletions: stats[1]}

		// A deleted path has nothing left to stat, which is fine: its status
		// letter and numstat already tell it apart from every other state.
		full := filepath.Join(dir, path)
		if info, statErr := os.Stat(full); statErr == nil && !info.IsDir() {
			fp.Size = info.Size()
			fp.ModNanos = info.ModTime().UnixNano()
			if fp.Size <= maxFingerprintFileBytes && bytesRead+fp.Size <= maxFingerprintTotalBytes {
				if data, readErr := os.ReadFile(full); readErr == nil {
					bytesRead += int64(len(data))
					hasher := fnv.New64a()
					_, _ = hasher.Write(data)
					fp.Hash = hasher.Sum64()
					// A brand-new file has no diff to measure against, so its
					// line count is its addition count.
					if letter == "?" && fp.Additions == 0 {
						fp.Additions = countLines(data)
					}
				}
			}
		}

		snap.Files[path] = fp
	}

	return snap, nil
}

// captureBaseCommit records the exact pre-turn working tree as a commit object
// and returns its sha, so a rollback can restore the human's uncommitted edits
// rather than only what was committed.
//
// `git stash create` builds that commit without touching the working tree, the
// index, or the stash stack -- but it leaves the commit *unreferenced*, and an
// unreachable object is precisely what `git gc` exists to delete: immediately
// under `--prune=now`, and otherwise once it ages past gc.pruneExpire. A
// rollback button that quietly stops working after someone runs a gc is worse
// than one that was never offered, so the commit is pinned under its own ref.
//
// A clean tree produces no stash commit, and needs none: HEAD already describes
// it exactly.
func captureBaseCommit(dir, turnID, head string) string {
	stashCommit, err := runGit(dir, "stash", "create")
	stashCommit = strings.TrimSpace(stashCommit)
	if err != nil || stashCommit == "" {
		return head
	}
	if _, err := runGit(dir, "update-ref", checkpointRefPrefix+turnID, stashCommit); err != nil {
		// The snapshot exists but stays prunable. Still better than none: the
		// rollback path already refuses to touch a file whose snapshot has
		// gone away rather than falling back to HEAD.
		log.Printf("turn-changes: could not pin checkpoint for turn %s: %v", turnID, err)
	}
	return stashCommit
}

// pruneCheckpointRefs releases snapshots for this directory's turns that have
// aged past the retention window, letting gc reclaim the trees they pinned.
//
// It runs on the dispatch path, which is already doing git work against this
// directory, and clears BaseCommit so the rollback path reports an aged-out
// snapshot as unavailable instead of pointing at a deleted object.
func pruneCheckpointRefs(workspaceID, dir string) {
	cutoff := time.Now().Add(-checkpointRetention).UnixMilli()
	var stale []models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ? AND working_dir = ? AND started_at < ? AND base_commit <> ?",
		workspaceID, dir, cutoff, "").
		Limit(checkpointPruneBatch).Find(&stale).Error; err != nil {
		return
	}
	for _, row := range stale {
		// Deleting a ref that was never created (a clean-tree turn kept HEAD as
		// its base) is a harmless no-op, so the result is not worth branching on.
		_, _ = runGit(dir, "update-ref", "-d", checkpointRefPrefix+row.ID)
		if err := db.DB.Model(&models.AgentTurnChange{}).Where("id = ?", row.ID).
			Update("base_commit", "").Error; err != nil {
			log.Printf("turn-changes: failed to clear aged checkpoint on turn %s: %v", row.ID, err)
		}
	}
}

func readNumstat(dir string, args ...string) map[string][2]int {
	stats := map[string][2]int{}
	out, err := runGitTimeout(dir, turnGitTimeout, args...)
	if err != nil || out == "" {
		return stats
	}
	for _, line := range strings.Split(out, "\n") {
		cols := strings.Split(line, "\t")
		if len(cols) < 3 {
			continue
		}
		// Binary files report "-" for both counts; Atoi leaves those at zero so
		// the path is still attributed, just without a line count.
		adds, _ := strconv.Atoi(cols[0])
		dels, _ := strconv.Atoi(cols[1])
		// A rename is reported as "old => new"; the last column carries the
		// path git will also list in status.
		path := cols[len(cols)-1]
		prev := stats[path]
		stats[path] = [2]int{prev[0] + adds, prev[1] + dels}
	}
	return stats
}

func countLines(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	text := string(data)
	lines := strings.Count(text, "\n")
	if !strings.HasSuffix(text, "\n") {
		lines++
	}
	return lines
}

// diffTurnSnapshots attributes the difference between two snapshots of the same
// directory. Three sources are merged: paths that appeared or changed in the
// working tree, paths that vanished because the agent committed them, and paths
// that vanished because the agent reverted them.
func diffTurnSnapshots(dir string, base, final *turnSnapshot) []turnFileChange {
	changes := map[string]*turnFileChange{}

	for path, fp := range final.Files {
		basefp, existed := base.Files[path]
		if existed && !fp.differsFrom(basefp) {
			continue
		}
		change := &turnFileChange{
			Path:      path,
			Status:    fp.Status,
			Additions: fp.Additions,
			Deletions: fp.Deletions,
		}
		if existed {
			change.PreExisting = true
			change.BaseAdditions = basefp.Additions
			change.BaseDeletions = basefp.Deletions
		}
		changes[path] = change
	}

	// Commits made during the turn move work out of git status entirely. Without
	// this pass, an agent that commits its own output would appear to have
	// changed nothing at all.
	if final.Head != "" && base.Head != "" && final.Head != base.Head {
		for path, stats := range readNumstat(dir, "diff", "--numstat", base.Head+".."+final.Head) {
			if existing, ok := changes[path]; ok {
				existing.Committed = true
				existing.Additions += stats[0]
				existing.Deletions += stats[1]
				continue
			}
			change := &turnFileChange{
				Path:      path,
				Status:    "M",
				Additions: stats[0],
				Deletions: stats[1],
				Committed: true,
			}
			if basefp, existed := base.Files[path]; existed {
				change.PreExisting = true
				change.BaseAdditions = basefp.Additions
				change.BaseDeletions = basefp.Deletions
			}
			changes[path] = change
		}
	}

	for path, basefp := range base.Files {
		if _, stillDirty := final.Files[path]; stillDirty {
			continue
		}
		if existing, ok := changes[path]; ok && existing.Committed {
			continue
		}
		// Dirty before, clean now, not committed: an uncommitted human edit was
		// undone during this turn.
		changes[path] = &turnFileChange{
			Path:          path,
			Status:        basefp.Status,
			PreExisting:   true,
			Reverted:      true,
			BaseAdditions: basefp.Additions,
			BaseDeletions: basefp.Deletions,
		}
	}

	result := make([]turnFileChange, 0, len(changes))
	for _, change := range changes {
		result = append(result, *change)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	return result
}

// resolveTurnDir mirrors the git endpoints' resolution order: a channel's own
// binding wins, and an agent's launch directory is the fallback for channels
// that were never bound to a project.
func resolveTurnDir(workspaceID string, channel *models.Channel, agentName string) string {
	if channel != nil && channel.WorkingDir != nil {
		if dir := strings.TrimSpace(*channel.WorkingDir); dir != "" {
			if stat, err := os.Stat(dir); err == nil && stat.IsDir() {
				return dir
			}
		}
	}
	var members []models.WorkspaceMember
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspaceID, agentName).
		Limit(1).Find(&members).Error; err == nil && len(members) == 1 && members[0].WorkingDir != nil {
		if dir := strings.TrimSpace(*members[0].WorkingDir); dir != "" {
			if stat, err := os.Stat(dir); err == nil && stat.IsDir() {
				return dir
			}
		}
	}
	return ""
}

// openAgentTurn records the baseline for a dispatch. It must run before the
// message reaches the agent, otherwise the "before" state already contains some
// of the agent's own writes. Returns true if the turn is opened for execution immediately,
// or false if the turn was queued due to directory contention.
func openAgentTurn(workspaceID string, channel *models.Channel, agentName, taskID, triggerEventID string) bool {
	agentName = strings.TrimSpace(agentName)
	if workspaceID == "" || channel == nil || agentName == "" || agentName == noResponseAgent {
		return false
	}
	dir := resolveTurnDir(workspaceID, channel, agentName)
	if dir == "" {
		// Nothing is bound to a project directory, so there is nothing to
		// attribute. Not an error worth recording.
		return true
	}
	if taskID == "" {
		taskID = triggerEventID
	}
	if taskID == "" {
		taskID = uuid.NewString()
	}

	// A fresh dispatch supersedes whatever turn this agent still had open in
	// this channel, so settle that one first rather than leaving it dangling.
	closeAgentTurn(workspaceID, channel, agentName)
	expireStaleTurns(workspaceID)

	unlock := lockTurnDir(dir)
	defer unlock()

	record := models.AgentTurnChange{
		ID:             uuid.NewString(),
		WorkspaceID:    workspaceID,
		ChannelID:      channel.ID,
		ChannelName:    channel.Name,
		AgentName:      agentName,
		TaskID:         taskID,
		TriggerEventID: triggerEventID,
		WorkingDir:     dir,
		Status:         "open",
		StartedAt:      time.Now().UnixMilli(),
	}

	// Working directory concurrency control: if another agent is currently editing
	// this working directory, enqueue this turn to prevent stomping.
	if others := openTurnAgentsForDir(workspaceID, dir, agentName); len(others) > 0 {
		record.Status = "queued"
		record.Contended = true
		record.ContendedBy, _ = json.Marshal(others)
		if err := db.DB.Model(&models.AgentTurnChange{}).
			Where("workspace_id = ? AND working_dir = ? AND status = ?", workspaceID, dir, "open").
			Update("contended", true).Error; err != nil {
			log.Printf("turn-changes: failed to flag contention on %s: %v", dir, err)
		}
		if err := db.DB.Create(&record).Error; err != nil {
			log.Printf("turn-changes: failed to enqueue turn for @%s in %s: %v", agentName, channel.Name, err)
		} else {
			busyAgents := strings.Join(others, ", @")
			queueMsg := fmt.Sprintf("⏳ @%s 排队中：@%s 正在目录 `%s` 工作，将在前序任务完成后自动开始。",
				agentName, busyAgents, dir)
			RelayPipelineAlert(workspaceID, "channel/"+channel.Name, queueMsg)
		}
		return false
	}

	snap, err := captureTurnSnapshot(dir)
	if err != nil {
		record.Status = "unavailable"
		record.Reason = err.Error()
	} else {
		record.BaseCommit = captureBaseCommit(dir, record.ID, snap.Head)
		record.Baseline, _ = json.Marshal(snap)
		pruneCheckpointRefs(workspaceID, dir)
	}

	// Capture Baseline Verification Run asynchronously so message dispatch is never blocked
	if channel.VerificationCmd != nil && strings.TrimSpace(*channel.VerificationCmd) != "" {
		cmdStr := strings.TrimSpace(*channel.VerificationCmd)
		recID := record.ID
		targetDir := dir
		go func() {
			if baselineRes, err := evaluator.RunVerificationCommand(targetDir, cmdStr, 30*time.Second); err == nil && baselineRes != nil {
				encoded, _ := json.Marshal(baselineRes)
				_ = db.DB.Model(&models.AgentTurnChange{}).Where("id = ?", recID).
					Update("baseline_verify", encoded)
			}
		}()
	}

	if err := db.DB.Create(&record).Error; err != nil {
		log.Printf("turn-changes: failed to open turn for @%s in %s: %v", agentName, channel.Name, err)
		return false
	}
	return true
}

// GetLatestTurnBaselineVerify retrieves the baseline verification result recorded at dispatch time.
func GetLatestTurnBaselineVerify(workspaceID, channelID, agentName string) *evaluator.VerificationRunResult {
	var records []models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ? AND channel_id = ? AND agent_name = ?", workspaceID, channelID, agentName).
		Order("started_at desc").Limit(1).Find(&records).Error; err != nil || len(records) == 0 {
		return nil
	}
	if len(records[0].BaselineVerify) == 0 {
		return nil
	}
	var res evaluator.VerificationRunResult
	if err := json.Unmarshal(records[0].BaselineVerify, &res); err != nil {
		return nil
	}
	return &res
}

// closeAgentTurn settles the agent's open turn in this channel by
// re-snapshotting and diffing against the baseline.
func closeAgentTurn(workspaceID string, channel *models.Channel, agentName string) {
	agentName = strings.TrimSpace(agentName)
	if workspaceID == "" || channel == nil || agentName == "" {
		return
	}

	// Find rather than First: having no open turn is the common case on a first
	// dispatch, and it is not worth a "record not found" line in the log.
	var records []models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ? AND channel_id = ? AND agent_name = ? AND status = ?",
		workspaceID, channel.ID, agentName, "open").
		Order("started_at desc").Limit(1).Find(&records).Error; err != nil || len(records) == 0 {
		return
	}
	record := records[0]

	nowMs := time.Now().UnixMilli()
	unlock := lockTurnDir(record.WorkingDir)
	defer unlock()

	var base turnSnapshot
	if err := json.Unmarshal(record.Baseline, &base); err != nil || base.Files == nil {
		finishTurnUnavailable(record.ID, "baseline snapshot is unreadable", nowMs)
		return
	}

	final, err := captureTurnSnapshot(record.WorkingDir)
	if err != nil {
		finishTurnUnavailable(record.ID, err.Error(), nowMs)
		return
	}

	changes := diffTurnSnapshots(record.WorkingDir, &base, final)
	additions, deletions := 0, 0
	for _, change := range changes {
		additions += change.Additions
		deletions += change.Deletions
	}

	encoded, err := json.Marshal(changes)
	if err != nil {
		finishTurnUnavailable(record.ID, "change set is unencodable", nowMs)
		return
	}

	if err := db.DB.Model(&models.AgentTurnChange{}).Where("id = ?", record.ID).
		Updates(map[string]interface{}{
			"status":      "closed",
			"changes":     encoded,
			"additions":   additions,
			"deletions":   deletions,
			"file_count":  len(changes),
			"finished_at": nowMs,
		}).Error; err != nil {
		log.Printf("turn-changes: failed to close turn %s: %v", record.ID, err)
	} else if len(changes) > 0 {
		_ = PublishWorkspaceStateEvent(workspaceID, "workspace.git.turn.changed", record.AgentName, channel.Name, gin.H{
			"turn_id":    record.ID,
			"agent_name": record.AgentName,
			"additions":  additions,
			"deletions":  deletions,
			"file_count": len(changes),
		})
	}

	// Drain any turn waiting in queue for this working directory
	drainDirQueue(workspaceID, record.WorkingDir)
}

func finishTurnUnavailable(recordID, reason string, nowMs int64) {
	if err := db.DB.Model(&models.AgentTurnChange{}).Where("id = ?", recordID).
		Updates(map[string]interface{}{
			"status":      "unavailable",
			"reason":      reason,
			"finished_at": nowMs,
		}).Error; err != nil {
		log.Printf("turn-changes: failed to mark turn %s unavailable: %v", recordID, err)
	}
}

func openTurnAgentsForDir(workspaceID, dir, excludeAgent string) []string {
	var rows []models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ? AND working_dir = ? AND status = ? AND agent_name <> ?",
		workspaceID, dir, "open", excludeAgent).Find(&rows).Error; err != nil {
		return nil
	}
	seen := map[string]bool{}
	agents := make([]string, 0, len(rows))
	for _, row := range rows {
		if !seen[row.AgentName] {
			seen[row.AgentName] = true
			agents = append(agents, row.AgentName)
		}
	}
	return agents
}

// drainDirQueue wakes up the next queued turn for a working directory when the previous turn closes or expires.
func drainDirQueue(workspaceID, dir string) {
	if workspaceID == "" || dir == "" || db.DB == nil {
		return
	}
	// Check if there are still any open turns running on this directory
	var openCount int64
	if err := db.DB.Model(&models.AgentTurnChange{}).
		Where("workspace_id = ? AND working_dir = ? AND status = ?", workspaceID, dir, "open").
		Count(&openCount).Error; err != nil || openCount > 0 {
		return
	}

	// Find the oldest queued turn for this directory
	var queued models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ? AND working_dir = ? AND status = ?", workspaceID, dir, "queued").
		Order("started_at asc").First(&queued).Error; err != nil {
		return
	}

	// Activate this queued turn
	nowMs := time.Now().UnixMilli()
	snap, err := captureTurnSnapshot(dir)
	var baseCommit string
	var baselineJSON []byte
	if err == nil && snap != nil {
		// A queued turn is baselined when it is *activated*, not when it was
		// queued: the directory has moved on since, and the turn it was waiting
		// behind is exactly what it must not be blamed for.
		baseCommit = captureBaseCommit(dir, queued.ID, snap.Head)
		baselineJSON, _ = json.Marshal(snap)
	}

	updates := map[string]interface{}{
		"status":      "open",
		"started_at":  nowMs,
		"base_commit": baseCommit,
		"baseline":    baselineJSON,
	}

	if err := db.DB.Model(&queued).Updates(updates).Error; err == nil {
		var channel models.Channel
		if err := db.DB.Where("id = ?", queued.ChannelID).First(&channel).Error; err == nil {
			targetChan := "channel/" + channel.Name
			wakeEventID := uuid.New().String()
			nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)

			payload := map[string]interface{}{
				"content":      fmt.Sprintf("@%s 前序任务已完成，排队结束。开始在目录 `%s` 执行任务。", queued.AgentName, dir),
				"sender_name":  "Pipeline Supervisor",
				"sender_type":  "system",
				"message_type": "chat",
			}
			metadata := map[string]interface{}{
				"target_agents": []string{queued.AgentName},
				"task_id":       queued.TaskID,
				"queued_wake":   true,
			}
			payloadBytes, _ := json.Marshal(payload)
			metaBytes, _ := json.Marshal(metadata)

			wakeEvent := models.EventRecord{
				ID:         wakeEventID,
				NetworkID:  workspaceID,
				Type:       "workspace.message.posted",
				Source:     "system:orchestrator",
				Target:     targetChan,
				Payload:    payloadBytes,
				Metadata:   metaBytes,
				Timestamp:  nowUnixMs,
				Visibility: "channel",
			}
			_ = db.DB.Create(&wakeEvent)

			fullEvent, _ := json.Marshal(gin.H{
				"id":        wakeEventID,
				"event_id":  wakeEventID,
				"network":   workspaceID,
				"type":      "workspace.message.posted",
				"source":    "system:orchestrator",
				"target":    targetChan,
				"payload":   payload,
				"metadata":  metadata,
				"timestamp": nowUnixMs,
				"status":    "confirmed",
			})
			if hub.GlobalHub != nil {
				hub.GlobalHub.Broadcast(hub.BroadcastMsg{
					WorkspaceID: workspaceID,
					ChannelName: targetChan,
					Payload:     string(fullEvent),
				})
			}
		}
		log.Printf("turn-changes: activated queued turn %s for @%s on %s", queued.ID, queued.AgentName, dir)
	}
}

// expireStaleTurns settles turns whose agent went away without reporting back.
// Their change set is unknowable after the fact, so they are marked rather than
// diffed -- a stale baseline would attribute unrelated later edits to them.
func expireStaleTurns(workspaceID string) {
	cutoff := time.Now().Add(-turnStaleAfter).UnixMilli()
	nowMs := time.Now().UnixMilli()
	var staleRows []models.AgentTurnChange
	_ = db.DB.Where("workspace_id = ? AND status = ? AND started_at < ?", workspaceID, "open", cutoff).Find(&staleRows).Error

	if err := db.DB.Model(&models.AgentTurnChange{}).
		Where("workspace_id = ? AND status = ? AND started_at < ?", workspaceID, "open", cutoff).
		Updates(map[string]interface{}{
			"status":      "unavailable",
			"reason":      "agent never reported back; change set cannot be attributed",
			"finished_at": nowMs,
		}).Error; err != nil {
		log.Printf("turn-changes: failed to expire stale turns: %v", err)
	}

	// Drain any queues waiting on directories that just freed up
	seenDirs := map[string]bool{}
	for _, row := range staleRows {
		if row.WorkingDir != "" && !seenDirs[row.WorkingDir] {
			seenDirs[row.WorkingDir] = true
			drainDirQueue(workspaceID, row.WorkingDir)
		}
	}
}

// recordTurnChanges is the single hook from the event path. One agent chat
// message can both end that agent's turn and begin the next agent's, and the
// order matters: settle first, then open, so the next baseline includes
// everything the previous agent left behind.
func recordTurnChanges(workspaceID string, req *SendEventRequest, eventID string) {
	if req == nil || req.Type != "workspace.message.posted" {
		return
	}
	if !strings.HasPrefix(req.Target, "channel/") {
		return
	}
	if messageType(req.Payload) != "chat" {
		return
	}

	channelName := strings.TrimPrefix(req.Target, "channel/")
	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspaceID, channelName).
		First(&channel).Error; err != nil {
		return
	}

	if isAgentSource(req.Source) {
		if actor := agentNameFromSource(req.Source); actor != "" {
			closeAgentTurn(workspaceID, &channel, actor)
		}
	}

	taskID := metadataString(req.Metadata, "task_id")
	var activeTargets []string
	var queuedTargets []string

	for _, target := range metadataStrings(req.Metadata, "target_agents") {
		if openAgentTurn(workspaceID, &channel, target, taskID, eventID) {
			activeTargets = append(activeTargets, target)
		} else {
			queuedTargets = append(queuedTargets, target)
		}
	}

	// Real Queue Gating: If all target agents are queued, intercept target_agents so they don't run prematurely
	if len(queuedTargets) > 0 && len(activeTargets) == 0 {
		if req.Metadata == nil {
			req.Metadata = make(map[string]interface{})
		}
		req.Metadata["target_agents"] = []string{noResponseAgent}
		req.Metadata["queued_agents"] = queuedTargets
	} else if len(activeTargets) > 0 && len(queuedTargets) > 0 {
		req.Metadata["target_agents"] = activeTargets
		req.Metadata["queued_agents"] = queuedTargets
	}
}

// recordRelayTurn is the hook for the relay paths, which write their event rows
// directly instead of going through the event handler.
func recordRelayTurn(workspaceID, target, agentName, taskID, eventID string) {
	if !strings.HasPrefix(target, "channel/") {
		return
	}
	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspaceID, strings.TrimPrefix(target, "channel/")).
		First(&channel).Error; err != nil {
		return
	}
	openAgentTurn(workspaceID, &channel, agentName, taskID, eventID)
}

// pipelineTaskID is the grouping key that makes every self-correction retry of a
// step roll up into the same task as the original attempt.
func pipelineTaskID(pipelineID string, stepIndex int) string {
	return pipelineID + ":" + strconv.Itoa(stepIndex)
}

func metadataString(metadata map[string]interface{}, key string) string {
	if metadata == nil {
		return ""
	}
	value, _ := metadata[key].(string)
	return strings.TrimSpace(value)
}

// metadataStrings tolerates both the in-process []string that routing sets and
// the []interface{} a JSON round-trip produces.
func metadataStrings(metadata map[string]interface{}, key string) []string {
	if metadata == nil {
		return nil
	}
	switch value := metadata[key].(type) {
	case []string:
		return value
	case []interface{}:
		result := make([]string, 0, len(value))
		for _, item := range value {
			if name, ok := item.(string); ok {
				result = append(result, name)
			}
		}
		return result
	}
	return nil
}

type turnChangeResponse struct {
	models.AgentTurnChange
	Files       []turnFileChange `json:"files"`
	ContendedBy []string         `json:"contended_by,omitempty"`
}

// ListTurnChanges handles GET /v1/git/turn-changes
//
// Scoped by channel (default) or by agent, newest first. A caller that passes
// task_id gets just that task's turns, which is how a change panel renders
// "this task touched these files" across a pipeline's steps and retries.
func ListTurnChanges(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	query := db.DB.Where("workspace_id = ?", workspace.ID)

	if channelRef := strings.TrimSpace(c.Query("channel")); channelRef != "" {
		var channel models.Channel
		if err := db.DB.Where("workspace_id = ? AND (id = ? OR name = ?)", workspace.ID, channelRef, channelRef).
			First(&channel).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Channel not found"})
			return
		}
		query = query.Where("channel_id = ?", channel.ID)
	}
	if agentName := strings.TrimSpace(c.Query("agent_name")); agentName != "" {
		query = query.Where("agent_name = ?", agentName)
	}
	if taskID := strings.TrimSpace(c.Query("task_id")); taskID != "" {
		query = query.Where("task_id = ?", taskID)
	}

	limit := 20
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 200 {
			limit = parsed
		}
	}

	var rows []models.AgentTurnChange
	if err := query.Order("started_at desc").Limit(limit).Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load turn changes"})
		return
	}

	turns := make([]turnChangeResponse, 0, len(rows))
	for _, row := range rows {
		item := turnChangeResponse{AgentTurnChange: row, Files: []turnFileChange{}}
		if len(row.Changes) > 0 {
			var files []turnFileChange
			if err := json.Unmarshal(row.Changes, &files); err == nil {
				item.Files = files
			}
		}
		if len(row.ContendedBy) > 0 {
			var agents []string
			if err := json.Unmarshal(row.ContendedBy, &agents); err == nil {
				item.ContendedBy = agents
			}
		}
		turns = append(turns, item)
	}

	c.JSON(http.StatusOK, gin.H{"turns": turns})
}
