package handlers

import (
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
	Parallel orchestration: everybody assigned starts at once.

	This is deliberately NOT a judgement. dynamic mode asks an LLM to choose one
	next speaker, which is the right shape when it is unclear who should act.
	Parallel is the opposite situation - the division of labour is already
	decided, and the routing is simply "wake all of them". Nothing here calls a
	model, so a batch cannot be derailed by a routing decision going wrong.

	The cost of parallel is not routing, it is collision: N agents editing one
	repository at the same time silently clobber each other, and "the division
	of labour is clear" is a human intention nothing verifies. Hence Scope on
	every task and detectScopeConflicts below - the mode refuses to start rather
	than discovering the overlap after three agents have been working for ten
	minutes.
*/

// openTodoStatuses are the states that still count as part of a running batch.
var openTodoStatuses = []string{"pending", "in_progress"}

// ScopeConflict names two tasks whose declared scopes overlap.
type ScopeConflict struct {
	AssigneeA string `json:"assignee_a"`
	AssigneeB string `json:"assignee_b"`
	ScopeA    string `json:"scope_a"`
	ScopeB    string `json:"scope_b"`
	Reason    string `json:"reason"`
}

func (c ScopeConflict) String() string {
	return fmt.Sprintf("%s (%s) and %s (%s): %s", c.AssigneeA, c.ScopeA, c.AssigneeB, c.ScopeB, c.Reason)
}

// normaliseScope makes scopes comparable: forward slashes, no leading or
// trailing separator, cleaned of "." and "..".
func normaliseScope(raw string) string {
	value := strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	if value == "" {
		return ""
	}
	value = path.Clean(value)
	value = strings.Trim(value, "/")
	if value == "." {
		return ""
	}
	return value
}

// scopesOverlap reports whether two normalised scopes can touch the same file.
// Equal scopes overlap, and so does any pair where one contains the other -
// "src" and "src/api" are not disjoint however they were meant.
func scopesOverlap(a, b string) bool {
	if a == "" || b == "" {
		// An empty scope is the whole tree.
		return true
	}
	if a == b {
		return true
	}
	return strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/")
}

// detectScopeConflicts returns every pair of tasks, held by DIFFERENT assignees,
// whose scopes are not disjoint. Two tasks belonging to one agent are never a
// conflict: that agent runs them one after another, never concurrently.
func detectScopeConflicts(todos []models.TodoRecord) []ScopeConflict {
	type scoped struct {
		assignee string
		scope    string
		declared bool
	}
	entries := make([]scoped, 0, len(todos))
	for _, todo := range todos {
		assignee := strings.TrimSpace(todo.Assignee)
		if assignee == "" {
			continue
		}
		entry := scoped{assignee: assignee}
		if todo.Scope != nil {
			entry.scope = normaliseScope(*todo.Scope)
			entry.declared = entry.scope != ""
		}
		entries = append(entries, entry)
	}

	conflicts := make([]ScopeConflict, 0)
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if strings.EqualFold(entries[i].assignee, entries[j].assignee) {
				continue
			}
			if !scopesOverlap(entries[i].scope, entries[j].scope) {
				continue
			}
			reason := "scopes overlap"
			if !entries[i].declared || !entries[j].declared {
				reason = "a task has no declared scope, so it covers the whole tree"
			} else if entries[i].scope == entries[j].scope {
				reason = "both tasks claim the same scope"
			} else {
				reason = "one scope contains the other"
			}
			conflicts = append(conflicts, ScopeConflict{
				AssigneeA: entries[i].assignee, ScopeA: displayScope(entries[i].scope),
				AssigneeB: entries[j].assignee, ScopeB: displayScope(entries[j].scope),
				Reason: reason,
			})
		}
	}
	return conflicts
}

func displayScope(scope string) string {
	if scope == "" {
		return "(unscoped)"
	}
	return scope
}

// loadOpenBatch returns the tasks that make up the channel's current batch.
func loadOpenBatch(workspaceID, channelName string) []models.TodoRecord {
	var todos []models.TodoRecord
	db.DB.Where("workspace_id = ? AND channel_name = ? AND status IN ?",
		workspaceID, channelName, openTodoStatuses).Find(&todos)
	return todos
}

// parallelAssignees returns the distinct assignees of a batch, sorted so the
// wake order is stable and a test can assert on it.
func parallelAssignees(todos []models.TodoRecord, participants []string, exclude string) []string {
	allowed := map[string]string{}
	for _, name := range participants {
		allowed[strings.ToLower(name)] = name
	}

	seen := map[string]bool{}
	names := make([]string, 0, len(todos))
	for _, todo := range todos {
		assignee := strings.TrimSpace(todo.Assignee)
		if assignee == "" || strings.EqualFold(assignee, exclude) {
			continue
		}
		canonical, ok := allowed[strings.ToLower(assignee)]
		if !ok {
			// Assigned to somebody who is not in this channel: skip rather than
			// wake a name the workspace cannot deliver to.
			continue
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		names = append(names, canonical)
	}
	sort.Strings(names)
	return names
}

// parallelTargets is the routing decision for a channel in parallel mode.
//
// Returns the agents to wake and, when the batch cannot safely start, the
// conflicts that stopped it. An empty target list with no conflicts simply
// means there is no open work - the caller then falls back to its normal path,
// so a channel left in parallel mode still behaves sensibly between batches.
func parallelTargets(workspaceID, channelName string, participants []string, exclude string) ([]string, []ScopeConflict) {
	todos := loadOpenBatch(workspaceID, channelName)
	if len(todos) == 0 {
		return nil, nil
	}
	assignees := parallelAssignees(todos, participants, exclude)
	if len(assignees) < 2 {
		// One worker is not a parallel batch; there is nothing to collide with.
		return assignees, nil
	}
	if conflicts := detectScopeConflicts(todos); len(conflicts) > 0 {
		return nil, conflicts
	}
	return assignees, nil
}

// ---------------------------------------------------------------------------
// Batch status, for the UI
// ---------------------------------------------------------------------------

// ParallelWorker is one agent's slice of a batch.
type ParallelWorker struct {
	Assignee string              `json:"assignee"`
	Scope    string              `json:"scope"`
	Tasks    []models.TodoRecord `json:"tasks"`
	Done     int                 `json:"done"`
	Total    int                 `json:"total"`
	Running  bool                `json:"running"`
}

// ParallelBatch is what the channel is doing right now, in the shape the UI
// needs to draw it: one lane per worker, plus the reason it is blocked.
type ParallelBatch struct {
	Mode      string           `json:"mode"`
	State     string           `json:"state"`
	Workers   []ParallelWorker `json:"workers"`
	Conflicts []ScopeConflict  `json:"conflicts"`
	Done      int              `json:"done"`
	Total     int              `json:"total"`
}

// buildParallelBatch groups a channel's tasks into per-worker lanes.
//
// Counts cover the whole batch including finished work, which is why it reads
// every task for the channel rather than only the open ones: a lane that has
// finished must still be drawn, at 3/3, instead of vanishing when its last task
// closes.
func buildParallelBatch(mode string, all []models.TodoRecord) ParallelBatch {
	batch := ParallelBatch{Mode: mode, State: "idle", Workers: []ParallelWorker{}, Conflicts: []ScopeConflict{}}

	order := make([]string, 0)
	lanes := map[string]*ParallelWorker{}
	open := make([]models.TodoRecord, 0, len(all))

	for _, todo := range all {
		assignee := strings.TrimSpace(todo.Assignee)
		if assignee == "" {
			continue
		}
		key := strings.ToLower(assignee)
		lane, ok := lanes[key]
		if !ok {
			lane = &ParallelWorker{Assignee: assignee, Scope: "(unscoped)", Tasks: []models.TodoRecord{}}
			lanes[key] = lane
			order = append(order, key)
		}
		if todo.Scope != nil && normaliseScope(*todo.Scope) != "" {
			lane.Scope = normaliseScope(*todo.Scope)
		}
		lane.Tasks = append(lane.Tasks, todo)
		lane.Total++
		batch.Total++
		switch todo.Status {
		case "completed", "cancelled":
			lane.Done++
			batch.Done++
		case "in_progress":
			lane.Running = true
			open = append(open, todo)
		default:
			open = append(open, todo)
		}
	}

	sort.Strings(order)
	for _, key := range order {
		batch.Workers = append(batch.Workers, *lanes[key])
	}

	if conflicts := detectScopeConflicts(open); len(conflicts) > 0 {
		batch.Conflicts = conflicts
		batch.State = "blocked"
		return batch
	}
	if len(open) > 0 {
		batch.State = "running"
	} else if batch.Total > 0 {
		batch.State = "done"
	}
	return batch
}
