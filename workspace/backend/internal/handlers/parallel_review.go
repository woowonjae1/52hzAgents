package handlers

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
REVIEW BEFORE MERGE.

A batch in review waits for the user to merge it, and all the user had to go
on was a diffstat. With Channel.ReviewAgent set, each lane that changed
something is first read by another agent, whose verdict sits on the lane in
the panel:

 1. start (enterReview -> startLaneReviews): every lane with changes whose
    branch head has no verdict yet gets a reviewer that is not its author.
    The branch is checked out into a throwaway worktree and the brief is sent
    in the lane's own review thread, `review:<batch>:<agent>`.
 2. the thread is the fresh conversation. Adapters keep one CLI session per
    channel, so a new channel is a new session in every one of them, and the
    reviewer's thinking and tool calls stay out of the main channel. Its
    messages there are never routed onward (silenceReviewThreadAgent).
 3. the copy, not the lane's worktree: an adapter that does not enforce plan
    mode can only dirty the copy -- the lane's own folder is committed with
    `add -A` when the lane is sent back -- and merge or discard never waits on
    a reviewer holding the lane's folder open.
 4. finish: the adapter reports the turn's reply. Its ```verdict block becomes
    approved or changes_requested; anything else is a failed review, with the
    reply kept as notes. The copy is removed. When the last review is in, one
    summary goes to the main channel.
 5. the user still decides: Merge, Discard, or "Send back", which runs the
    lane again with the notes; it is reviewed again when it returns because
    its branch head moved. A review silent past ParallelReviewTimeout is timed
    out by the scheduler, and merging or discarding cancels running reviews.

Shared-folder batches are not reviewed: they never wait in review (their
changes are already in the folder), so there is nothing to hold back.
*/

const (
	reviewRunning          = "running"
	reviewApproved         = "approved"
	reviewChangesRequested = "changes_requested"
	reviewFailed           = "failed"
	reviewSkipped          = "skipped"
	reviewTimedOut         = "timed_out"
	reviewCancelled        = "cancelled"

	reviewThreadPrefix = "review:"
)

// ParallelReviewTimeout is how long a lane review may run before the scheduler
// times it out. Overridable with PARALLEL_REVIEW_TIMEOUT_SECONDS.
func ParallelReviewTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("PARALLEL_REVIEW_TIMEOUT_SECONDS")); v != "" {
		var secs int
		if _, err := fmt.Sscanf(v, "%d", &secs); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return 15 * time.Minute
}

func isReviewThread(channelName string) bool {
	return strings.HasPrefix(channelName, reviewThreadPrefix)
}

func reviewThreadName(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord) string {
	return reviewThreadPrefix + batch.ID[:8] + ":" + lane.Agent
}

func reviewCopyPath(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord) string {
	return GenerateAgentWorktreePath(batch.WorkspaceID, "r"+batch.ID[:8], lane.Agent)
}

// silenceReviewThreadAgent keeps an agent's message in a review thread from
// being routed: it answers the workspace's review request, and a reviewer
// writing "@claude forgot the test" must not wake claude in there. An explicit
// empty target list is what tells routeMessage to stay out.
func silenceReviewThreadAgent(channel *models.Channel, req *SendEventRequest) {
	if channel == nil || req == nil || !isReviewThread(channel.Name) || !isAgentSource(req.Source) {
		return
	}
	if req.Metadata == nil {
		req.Metadata = map[string]interface{}{}
	}
	if _, set := req.Metadata["target_agents"]; !set {
		req.Metadata["target_agents"] = []string{}
	}
}

// channelReviewSpec is the batch channel's review setting, "" when off.
func channelReviewSpec(batch *models.ParallelBatchRecord) string {
	var ch models.Channel
	if db.DB.Where("workspace_id = ? AND name = ?", batch.WorkspaceID, batch.ChannelName).Limit(1).Find(&ch).RowsAffected == 0 {
		return ""
	}
	return strings.TrimSpace(valueOrEmpty(ch.ReviewAgent))
}

type reviewerChoice struct {
	Agent string
	// Model rides on metadata.agent_models; "" leaves the agent's own.
	Model string
	// Info says why this is not the configured reviewer ("" when it is), or,
	// when nobody can review, why not.
	Info string
}

// resolveReviewer picks who reviews author's lane. spec is the channel
// setting: an agent name today; a saved agent profile would resolve here to
// its agent and model. Never the author: the configured agent when it is
// online and did not write the lane, else another online agent, preferring a
// different agent type -- another provider reads the code differently.
// ok=false means nobody can review it.
func resolveReviewer(workspaceID, spec, author string) (reviewerChoice, bool) {
	var members []models.WorkspaceMember
	db.DB.Where("workspace_id = ?", workspaceID).Order("agent_name").Find(&members)
	names := make([]string, 0, len(members))
	typeOf := map[string]string{}
	for _, m := range members {
		if m.AgentName == "" || m.AgentName == noResponseAgent {
			continue
		}
		names = append(names, m.AgentName)
		typeOf[strings.ToLower(m.AgentName)] = strings.ToLower(strings.TrimSpace(valueOrEmpty(m.AgentType)))
	}
	online := onlineParticipants(db.DB, workspaceID, names)

	configured := ""
	for _, n := range names {
		if strings.EqualFold(n, spec) {
			configured = n
		}
	}
	var info string
	switch {
	case configured == "":
		info = fmt.Sprintf("@%s is not in this workspace", spec)
	case strings.EqualFold(configured, author):
		info = fmt.Sprintf("@%s wrote this part", configured)
	case !online[configured]:
		info = fmt.Sprintf("@%s is offline", configured)
	default:
		return reviewerChoice{Agent: configured}, true
	}

	var candidates []string
	for _, n := range names {
		if !strings.EqualFold(n, author) && online[n] {
			candidates = append(candidates, n)
		}
	}
	if len(candidates) == 0 {
		return reviewerChoice{Info: info + ", and no other agent is online"}, false
	}
	authorType := typeOf[strings.ToLower(author)]
	otherType := func(name string) bool { return authorType == "" || typeOf[strings.ToLower(name)] != authorType }
	sort.SliceStable(candidates, func(i, j int) bool { return otherType(candidates[i]) && !otherType(candidates[j]) })
	return reviewerChoice{Agent: candidates[0], Info: info}, true
}

// laneHead is the commit the lane's branch points at, "" if unknown.
func laneHead(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord) string {
	if batch.RepoDir == "" || lane.Branch == "" {
		return ""
	}
	out, err := runGit(batch.RepoDir, "rev-parse", lane.Branch)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// startLaneReviews sends every lane that needs a review to a reviewer and
// returns one line per lane for the "ready for review" message. A lane needs
// one when it finished with changes and its branch head has no review yet;
// a running review is left alone. No-op when the channel has review off.
func startLaneReviews(batch *models.ParallelBatchRecord) []string {
	if batch.Isolation != "worktree" {
		return nil
	}
	spec := channelReviewSpec(batch)
	if spec == "" {
		return nil
	}
	var lanes []models.ParallelLaneRecord
	db.DB.Where("batch_id = ?", batch.ID).Order("agent").Find(&lanes)
	var lines []string
	for i := range lanes {
		lane := &lanes[i]
		if lane.Status != laneDone || lane.ReviewStatus == reviewRunning || laneAhead(batch, lane) == 0 {
			continue
		}
		if head := laneHead(batch, lane); head != "" && head == lane.ReviewedCommit {
			continue // this exact branch head already has its review
		}
		lines = append(lines, startLaneReview(batch, lane, spec))
	}
	return lines
}

// startLaneReview starts (or restarts) one lane's review and returns its line
// for the channel.
func startLaneReview(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord, spec string) string {
	head := laneHead(batch, lane)
	// A lane that comes back after a review is checked against what was asked.
	previous := ""
	if lane.ReviewedCommit != "" && lane.ReviewedCommit != head {
		previous = strings.TrimSpace(lane.ReviewNotes)
	}
	now := time.Now().UTC()
	lane.ReviewedCommit = head
	lane.ReviewStartedAt = &now
	lane.ReviewNotes = ""
	lane.ReviewChannel = ""

	choice, ok := resolveReviewer(batch.WorkspaceID, spec, lane.Agent)
	if !ok {
		lane.ReviewStatus, lane.Reviewer, lane.ReviewInfo = reviewSkipped, "", choice.Info
		saveReviewLane(batch, lane)
		return fmt.Sprintf("⏭ **@%s**'s part — review skipped: %s", lane.Agent, choice.Info)
	}
	lane.Reviewer, lane.ReviewInfo = choice.Agent, choice.Info

	path := reviewCopyPath(batch, lane)
	if err := checkoutReviewCopy(batch, path, head); err != nil {
		lane.ReviewStatus = reviewFailed
		lane.ReviewInfo = "could not check out a read-only copy: " + truncateRunes(err.Error(), 300)
		saveReviewLane(batch, lane)
		return fmt.Sprintf("❌ **@%s**'s part — the review could not start: %s", lane.Agent, lane.ReviewInfo)
	}
	lane.ReviewChannel = ensureReviewThread(batch, lane, choice.Agent, path)
	lane.ReviewStatus = reviewRunning
	saveReviewLane(batch, lane)

	meta := map[string]interface{}{
		// Read-only for adapters that enforce it; the copy covers the rest.
		"agent_mode": "plan",
		"parallel_review": map[string]interface{}{
			"batch_id":    batch.ID,
			"lane":        lane.Agent,
			"working_dir": path,
		},
	}
	if choice.Model != "" {
		meta["agent_models"] = map[string]string{choice.Agent: choice.Model}
	}
	postChannelMessage(batch.WorkspaceID, lane.ReviewChannel, "system:parallel",
		reviewBrief(batch, lane, path, previous), []string{choice.Agent}, meta)

	line := fmt.Sprintf("🔍 **@%s** is reviewing **@%s**'s part", choice.Agent, lane.Agent)
	if choice.Info != "" {
		line += " (" + choice.Info + ")"
	}
	return line
}

// checkoutReviewCopy puts a detached checkout of head at path, replacing any
// copy left from an earlier review of the same lane.
func checkoutReviewCopy(batch *models.ParallelBatchRecord, path, head string) error {
	removeReviewCopy(batch, path)
	if head == "" {
		return fmt.Errorf("the lane's branch has no commit")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	_, err := runGit(batch.RepoDir, "worktree", "add", "--detach", path, head)
	return err
}

// removeReviewCopy deletes a review copy. Best effort: a copy that cannot be
// removed now (a process still inside it on Windows) is replaced by the next
// review's checkout or pruned with the others.
func removeReviewCopy(batch *models.ParallelBatchRecord, path string) {
	if batch.RepoDir == "" {
		return
	}
	if _, err := os.Stat(path); err == nil {
		_ = RemoveGitWorktree(batch.RepoDir, path, true)
		_ = os.RemoveAll(path)
	}
	_, _ = runGit(batch.RepoDir, "worktree", "prune")
}

// ensureReviewThread returns the lane's review thread, creating it the first
// time. Its folder is the review copy, so anything that resolves the thread's
// working directory instead of the per-turn override still lands there.
func ensureReviewThread(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord, reviewer, path string) string {
	name := reviewThreadName(batch, lane)
	var ch models.Channel
	if db.DB.Where("workspace_id = ? AND name = ?", batch.WorkspaceID, name).Limit(1).Find(&ch).RowsAffected == 0 {
		title := fmt.Sprintf("Review · @%s's part", lane.Agent)
		creator := "system:parallel"
		ch = models.Channel{
			ID: uuid.NewString(), WorkspaceID: batch.WorkspaceID, Name: name,
			Title: &title, TitleManuallySet: true, CreatedBy: &creator,
			OrchestrationMode: "dynamic", Status: "active", WorkingDir: &path,
			CreatedAt: time.Now().UTC(),
		}
		if err := db.DB.Create(&ch).Error; err != nil {
			fmt.Printf("[parallel] could not create review thread %s: %v\n", name, err)
		}
	} else {
		db.DB.Model(&ch).Update("working_dir", path)
	}
	if ch.ID != "" {
		db.DB.FirstOrCreate(&models.ChannelMember{ChannelID: ch.ID, AgentName: reviewer})
	}
	return name
}

// clearReviewThreadDir unbinds the thread from a review copy that is gone.
func clearReviewThreadDir(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord) {
	if lane.ReviewChannel == "" {
		return
	}
	db.DB.Model(&models.Channel{}).Where("workspace_id = ? AND name = ?", batch.WorkspaceID, lane.ReviewChannel).
		Update("working_dir", gorm.Expr("NULL"))
}

func quoteLines(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i, l := range lines {
		lines[i] = "> " + l
	}
	return strings.Join(lines, "\n")
}

// reviewBrief is the reviewer's whole instruction: the lane's task, what
// changed, where the copy is, what to check, and the verdict format.
func reviewBrief(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord, path, previous string) string {
	base := baseRef(batch)
	since := base
	if out, err := runGit(batch.RepoDir, "merge-base", base, lane.Branch); err == nil && strings.TrimSpace(out) != "" {
		since = strings.TrimSpace(out)
		if len(since) > 12 {
			since = since[:12]
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "[Review before merge] Review @%s's part of a parallel batch. Nothing has been merged into `%s` yet: the user decides after reading your verdict.\n\n", lane.Agent, base)
	fmt.Fprintf(&b, "The task @%s was given:\n%s\n\n", lane.Agent, quoteLines(lane.Task))
	stat := lane.Diffstat
	if stat == "" {
		stat = "changes"
	}
	fmt.Fprintf(&b, "What changed (%s, branch `%s`):\n", stat, lane.Branch)
	for _, f := range strings.Split(lane.ChangedFiles, "\n") {
		if f = strings.TrimSpace(f); f != "" {
			b.WriteString("- " + f + "\n")
		}
	}
	fmt.Fprintf(&b, "\nYou are in a read-only copy of that branch: %s\nSee the whole change with `git diff %s HEAD`. Do not modify any file -- read files and run only commands that change nothing.\n\n", path, since)
	b.WriteString("Check, most important first:\n" +
		"1. Correctness: does it do what the task asked, without breaking what is around it?\n" +
		"2. Tests: is new behaviour covered where the project has tests? Name what is missing.\n" +
		"3. Unnecessary complexity: anything a simpler change would do, or changes the task did not need.\n")
	if previous != "" {
		b.WriteString("\nThis is a re-review: the part was sent back to its author with your previous notes:\n" +
			quoteLines(truncateRunes(previous, 1500)) + "\nCheck each point was dealt with.\n")
	}
	b.WriteString("\nWrite your notes first: concrete, with file names. If the part is sent back, its author gets them word for word. " +
		"Then end your reply with exactly one verdict block:\n\n" +
		"```verdict\n{\"verdict\": \"approve\"}\n```\n\n" +
		"or `{\"verdict\": \"changes_requested\"}` when something must change before it is merged.")
	return b.String()
}

// A fenced ```verdict block. The closing fence is required, as for decision
// blocks: half a block is a reply still streaming, not a verdict.
var verdictFenceRE = regexp.MustCompile("(?ims)^[ \\t]*```(?:oa[-:])?verdict[ \\t]*\\r?\\n(.*?)\\r?\\n[ \\t]*```[ \\t]*\\r?$")

// parseReviewVerdict reads the reviewer's verdict from its reply. The last
// block counts (a reviewer may quote the format before answering). The notes
// are the reply around the block, plus any "notes" field inside it. ok=false
// when there is no usable block; notes is then the whole reply.
func parseReviewVerdict(reply string) (status, notes string, ok bool) {
	reply = strings.TrimSpace(reply)
	matches := verdictFenceRE.FindAllStringSubmatchIndex(reply, -1)
	if len(matches) == 0 {
		return "", reply, false
	}
	last := matches[len(matches)-1]
	body := strings.TrimSpace(reply[last[2]:last[3]])
	rest := strings.TrimSpace(reply[:last[0]] + reply[last[1]:])

	word, inner := body, ""
	if strings.HasPrefix(body, "{") {
		var v struct {
			Verdict string `json:"verdict"`
			Notes   string `json:"notes"`
		}
		if err := json.Unmarshal([]byte(body), &v); err != nil {
			return "", reply, false
		}
		word, inner = v.Verdict, strings.TrimSpace(v.Notes)
	}
	word = strings.NewReplacer(" ", "_", "-", "_", "\"", "", "'", "").Replace(strings.ToLower(strings.TrimSpace(word)))
	switch word {
	case "approve", "approved", "lgtm":
		status = reviewApproved
	case "changes_requested", "request_changes", "changes", "reject", "rejected":
		status = reviewChangesRequested
	default:
		return "", reply, false
	}
	switch {
	case inner == "":
		notes = rest
	case rest == "":
		notes = inner
	default:
		notes = rest + "\n\n" + inner
	}
	return status, notes, true
}

// saveReviewLane writes only the review columns, so it never undoes a status
// or diffstat written meanwhile by the lane's own path (and vice versa).
func saveReviewLane(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord) {
	db.DB.Model(&models.ParallelLaneRecord{}).Where("id = ?", lane.ID).Updates(map[string]interface{}{
		"review_status":     lane.ReviewStatus,
		"reviewer":          lane.Reviewer,
		"review_notes":      lane.ReviewNotes,
		"review_info":       lane.ReviewInfo,
		"review_channel":    lane.ReviewChannel,
		"reviewed_commit":   lane.ReviewedCommit,
		"review_started_at": lane.ReviewStartedAt,
	})
	_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.parallel.lane", "system:parallel", batch.ChannelName, gin.H{"batch_id": batch.ID, "lane": lane})
}

// finishLaneReview records the end of a review turn.
func finishLaneReview(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord, failed bool, errText, reply string) {
	removeReviewCopy(batch, reviewCopyPath(batch, lane))
	clearReviewThreadDir(batch, lane)
	reply = strings.TrimSpace(reply)
	// A verdict that made it into the reply counts even if the turn then
	// ended badly: the review itself was done.
	switch status, notes, ok := parseReviewVerdict(reply); {
	case ok:
		lane.ReviewStatus = status
		lane.ReviewNotes = truncateRunes(notes, 4000)
	case failed:
		lane.ReviewStatus = reviewFailed
		lane.ReviewInfo = strings.TrimSpace(truncateRunes(errText, 500))
		if lane.ReviewInfo == "" {
			lane.ReviewInfo = "the review turn ended with an error"
		}
		lane.ReviewNotes = truncateRunes(reply, 4000)
	default:
		lane.ReviewStatus = reviewFailed
		lane.ReviewInfo = "the reviewer answered without a verdict block"
		if reply == "" {
			lane.ReviewInfo = "the reviewer gave no answer"
		}
		lane.ReviewNotes = truncateRunes(reply, 4000)
	}
	saveReviewLane(batch, lane)
	announceReviewsIfDone(batch)
}

// stopReview ends a running review without a verdict: timed out, or cancelled
// because the user merged or discarded without waiting.
func stopReview(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord, status, info string) {
	if lane.Reviewer != "" && lane.ReviewChannel != "" {
		emitAgentControlEvent(batch.WorkspaceID, lane.Reviewer, "stop", gin.H{"channel": lane.ReviewChannel})
	}
	removeReviewCopy(batch, reviewCopyPath(batch, lane))
	clearReviewThreadDir(batch, lane)
	lane.ReviewStatus, lane.ReviewInfo = status, info
	saveReviewLane(batch, lane)
}

// cancelLaneReviews stops the batch's running reviews. Called before a merge
// or discard loads the lanes, so their saves carry the cancelled state.
func cancelLaneReviews(batch *models.ParallelBatchRecord, why string) {
	var running []models.ParallelLaneRecord
	db.DB.Where("batch_id = ? AND review_status = ?", batch.ID, reviewRunning).Find(&running)
	for i := range running {
		stopReview(batch, &running[i], reviewCancelled, why)
	}
}

// ExpireStaleLaneReviews times out reviews running past ParallelReviewTimeout,
// so a silent reviewer cannot leave a lane "reviewing" forever. Called by the
// scheduler through ExpireStaleParallelLanes.
func ExpireStaleLaneReviews() {
	if db.DB == nil {
		return
	}
	cutoff := time.Now().UTC().Add(-ParallelReviewTimeout())
	var stale []models.ParallelLaneRecord
	db.DB.Where("review_status = ? AND review_started_at < ?", reviewRunning, cutoff).Find(&stale)
	for i := range stale {
		var batch models.ParallelBatchRecord
		if db.DB.Where("id = ?", stale[i].BatchID).Limit(1).Find(&batch).RowsAffected == 0 {
			continue
		}
		stopReview(&batch, &stale[i], reviewTimedOut, fmt.Sprintf("no verdict within %s", ParallelReviewTimeout()))
		announceReviewsIfDone(&batch)
	}
}

func reviewLine(l *models.ParallelLaneRecord) string {
	first := strings.TrimSpace(strings.SplitN(strings.TrimSpace(l.ReviewNotes), "\n", 2)[0])
	switch l.ReviewStatus {
	case reviewApproved:
		return fmt.Sprintf("✅ **@%s**'s part — approved by @%s", l.Agent, l.Reviewer)
	case reviewChangesRequested:
		line := fmt.Sprintf("⚠️ **@%s**'s part — changes requested by @%s", l.Agent, l.Reviewer)
		if first != "" {
			line += ": " + truncateRunes(first, 200)
		}
		return line
	case reviewTimedOut:
		return fmt.Sprintf("⏱ **@%s**'s part — @%s gave no verdict in time", l.Agent, l.Reviewer)
	case reviewSkipped:
		return fmt.Sprintf("⏭ **@%s**'s part — review skipped: %s", l.Agent, l.ReviewInfo)
	default:
		return fmt.Sprintf("❌ **@%s**'s part — review failed: %s", l.Agent, l.ReviewInfo)
	}
}

// announceReviewsIfDone posts one summary to the main channel once no review
// of a batch still waiting for the user is running.
func announceReviewsIfDone(batch *models.ParallelBatchRecord) {
	var current models.ParallelBatchRecord
	if db.DB.Where("id = ?", batch.ID).Limit(1).Find(&current).RowsAffected == 0 || current.Status != batchReview {
		return
	}
	var lanes []models.ParallelLaneRecord
	db.DB.Where("batch_id = ?", batch.ID).Order("agent").Find(&lanes)
	var lines []string
	for i := range lanes {
		l := &lanes[i]
		if l.ReviewStatus == reviewRunning {
			return
		}
		if l.Status != laneDone || l.ReviewStatus == "" || l.ReviewStatus == reviewCancelled {
			continue
		}
		lines = append(lines, reviewLine(l))
	}
	if len(lines) == 0 {
		return
	}
	postChannelMessage(batch.WorkspaceID, batch.ChannelName, "system:parallel",
		"**Reviews are in** — nothing is merged until you say so. Merge, or send a part back to its author, in the panel above.\n\n"+strings.Join(lines, "\n"),
		nil, map[string]interface{}{"parallel_summary": gin.H{"batch_id": batch.ID, "review": true}})
}

// batchLane loads the batch and lane named in the URL (:agent is the lane's
// author), answering 404 itself when either is missing.
func batchLane(c *gin.Context) (*models.ParallelBatchRecord, *models.ParallelLaneRecord, bool) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return nil, nil, false
	}
	var batch models.ParallelBatchRecord
	if db.DB.Where("id = ? AND workspace_id = ?", c.Param("batch_id"), workspace.ID).Limit(1).Find(&batch).RowsAffected == 0 {
		c.JSON(404, gin.H{"error": "batch not found"})
		return nil, nil, false
	}
	var lane models.ParallelLaneRecord
	if db.DB.Where("batch_id = ? AND agent = ?", batch.ID, agentNameFromSource(c.Param("agent"))).Limit(1).Find(&lane).RowsAffected == 0 {
		c.JSON(404, gin.H{"error": "lane not found"})
		return nil, nil, false
	}
	return &batch, &lane, true
}

type laneReviewCompleteRequest struct {
	Reviewer string `json:"reviewer"`
	Status   string `json:"status"` // done | failed
	Error    string `json:"error"`
	Reply    string `json:"reply"`
}

// CompleteLaneReview handles POST /v1/workspaces/:workspace_id/parallel-batches/:batch_id/lanes/:agent/review/complete,
// sent by the reviewer's adapter when its review turn ends. A report for a
// review that is no longer running (timed out, cancelled, restarted with
// someone else) is ignored.
func CompleteLaneReview(c *gin.Context) {
	batch, lane, ok := batchLane(c)
	if !ok {
		return
	}
	var req laneReviewCompleteRequest
	_ = c.ShouldBindJSON(&req)
	if lane.ReviewStatus != reviewRunning ||
		(strings.TrimSpace(req.Reviewer) != "" && !strings.EqualFold(agentNameFromSource(req.Reviewer), lane.Reviewer)) {
		c.JSON(200, gin.H{"lane": lane, "ignored": "no review of this lane is waiting for that reviewer"})
		return
	}
	finishLaneReview(batch, lane, req.Status == "failed", req.Error, req.Reply)
	c.JSON(200, gin.H{"lane": lane})
}

// RetryLaneReview handles POST /v1/workspaces/:workspace_id/parallel-batches/:batch_id/lanes/:agent/review:
// review the lane again -- after a failure, a time-out, a skip or a cancel.
func RetryLaneReview(c *gin.Context) {
	batch, lane, ok := batchLane(c)
	if !ok {
		return
	}
	if batch.Status != batchReview {
		c.JSON(409, gin.H{"error": "the batch is not waiting for review"})
		return
	}
	if lane.ReviewStatus == reviewRunning {
		c.JSON(409, gin.H{"error": "this part is already being reviewed"})
		return
	}
	if lane.Status != laneDone || laneAhead(batch, lane) == 0 {
		c.JSON(409, gin.H{"error": "only a finished part with changes can be reviewed"})
		return
	}
	spec := channelReviewSpec(batch)
	if spec == "" {
		c.JSON(409, gin.H{"error": "review before merge is off for this thread"})
		return
	}
	line := startLaneReview(batch, lane, spec)
	c.JSON(200, gin.H{"lane": lane, "summary": line})
}

// SendBackParallelLane handles POST /v1/workspaces/:workspace_id/parallel-batches/:batch_id/lanes/:agent/send-back:
// the user sends a reviewed lane back to its author with the review. It runs
// again in its own worktree (redispatchLane) and, because its branch head
// moves, is reviewed again when it finishes. The other lanes keep theirs.
func SendBackParallelLane(c *gin.Context) {
	batch, lane, ok := batchLane(c)
	if !ok {
		return
	}
	if batch.Status != batchReview {
		c.JSON(409, gin.H{"error": "the batch is not waiting for review"})
		return
	}
	if lane.Status != laneDone || lane.ReviewStatus == reviewRunning || strings.TrimSpace(lane.ReviewNotes) == "" {
		c.JSON(409, gin.H{"error": "only a finished part with review notes can be sent back"})
		return
	}
	if lane.WorktreePath != "" {
		if _, err := os.Stat(lane.WorktreePath); err != nil {
			c.JSON(409, gin.H{"error": "the lane's worktree no longer exists"})
			return
		}
	}
	redispatchLane(batch, lane, fmt.Sprintf(
		"@%s reviewed your part before merge, and the user is sending it back with that review:\n\n%s\n\n"+
			"Make the changes in your worktree and leave them uncommitted -- they are committed for you.",
		lane.Reviewer, quoteLines(lane.ReviewNotes)))
	c.JSON(200, gin.H{"lane": lane})
}
