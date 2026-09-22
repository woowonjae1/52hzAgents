package handlers

import (
	"testing"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
	Parallel mode's precondition, tested as the invariant it is.

	The agreed design: parallel is opt-in and narrow, for when the division of
	labour is already clear. But "clear" is a human intention, and the failure
	it guards against - two agents writing the same files - is silent and
	expensive. So the scope check is what makes the mode safe to offer at all,
	and it is the part worth pinning.
*/

func todo(assignee string, scope *string, status string) models.TodoRecord {
	return models.TodoRecord{Assignee: assignee, Scope: scope, Status: status, Content: "task"}
}

func ptr(s string) *string { return &s }

func TestDisjointScopesAreNotAConflict(t *testing.T) {
	conflicts := detectScopeConflicts([]models.TodoRecord{
		todo("pi", ptr("workspace/frontend"), "pending"),
		todo("claude", ptr("workspace/backend"), "pending"),
		todo("goose", ptr("packages/wwj"), "pending"),
	})
	if len(conflicts) != 0 {
		t.Fatalf("clean division of labour must start, got %v", conflicts)
	}
}

func TestNestedScopesConflict(t *testing.T) {
	// The case a human reads as "clearly separate": one is inside the other.
	conflicts := detectScopeConflicts([]models.TodoRecord{
		todo("pi", ptr("src"), "pending"),
		todo("claude", ptr("src/api"), "pending"),
	})
	if len(conflicts) != 1 {
		t.Fatalf("a nested scope must be caught, got %v", conflicts)
	}
	if conflicts[0].Reason != "one scope contains the other" {
		t.Fatalf("the reason must name the real problem, got %q", conflicts[0].Reason)
	}
}

func TestUnscopedTaskBlocksTheBatch(t *testing.T) {
	conflicts := detectScopeConflicts([]models.TodoRecord{
		todo("pi", ptr("workspace/frontend"), "pending"),
		todo("claude", nil, "pending"),
	})
	if len(conflicts) != 1 {
		t.Fatalf("an unscoped task covers everything and must block, got %v", conflicts)
	}
}

func TestOneAgentsOwnTasksNeverConflict(t *testing.T) {
	// Two tasks for one agent run one after another - _channelWorker serialises
	// per channel - so they cannot collide with each other.
	conflicts := detectScopeConflicts([]models.TodoRecord{
		todo("pi", ptr("src"), "pending"),
		todo("pi", ptr("src/api"), "pending"),
		todo("PI", nil, "pending"),
	})
	if len(conflicts) != 0 {
		t.Fatalf("one agent's own tasks are sequential, got %v", conflicts)
	}
}

func TestScopeNormalisation(t *testing.T) {
	// Windows separators and stray slashes must not make two identical scopes
	// look disjoint.
	conflicts := detectScopeConflicts([]models.TodoRecord{
		todo("pi", ptr(`workspace\frontend\`), "pending"),
		todo("claude", ptr("/workspace/frontend"), "pending"),
	})
	if len(conflicts) != 1 || conflicts[0].Reason != "both tasks claim the same scope" {
		t.Fatalf("the same scope written two ways must collide, got %v", conflicts)
	}
}

func TestParallelAssigneesAreDistinctAndInTheChannel(t *testing.T) {
	todos := []models.TodoRecord{
		todo("pi", ptr("a"), "pending"),
		todo("pi", ptr("b"), "in_progress"),
		todo("claude", ptr("c"), "pending"),
		todo("ghost", ptr("d"), "pending"), // not a participant
		todo("human", ptr("e"), "pending"), // the sender
	}
	got := parallelAssignees(todos, []string{"pi", "claude", "human"}, "human")

	if len(got) != 2 || got[0] != "claude" || got[1] != "pi" {
		t.Fatalf("expected the two in-channel assignees, sorted, got %v", got)
	}
}

func TestBatchStateReflectsProgress(t *testing.T) {
	all := []models.TodoRecord{
		todo("pi", ptr("frontend"), "completed"),
		todo("pi", ptr("frontend"), "in_progress"),
		todo("claude", ptr("backend"), "pending"),
	}
	batch := buildParallelBatch("parallel", all)

	if batch.State != "running" {
		t.Fatalf("state should be running, got %q", batch.State)
	}
	if batch.Done != 1 || batch.Total != 3 {
		t.Fatalf("progress should be 1/3, got %d/%d", batch.Done, batch.Total)
	}
	if len(batch.Workers) != 2 {
		t.Fatalf("expected two lanes, got %d", len(batch.Workers))
	}
	// A finished lane must still be drawn, not vanish.
	finished := buildParallelBatch("parallel", []models.TodoRecord{todo("pi", ptr("frontend"), "completed")})
	if finished.State != "done" || len(finished.Workers) != 1 {
		t.Fatalf("a completed batch must still render its lane, got %+v", finished)
	}
}

func TestBlockedBatchReportsWhy(t *testing.T) {
	batch := buildParallelBatch("parallel", []models.TodoRecord{
		todo("pi", ptr("src"), "pending"),
		todo("claude", ptr("src/api"), "pending"),
	})
	if batch.State != "blocked" || len(batch.Conflicts) != 1 {
		t.Fatalf("an overlapping batch must report blocked with a reason, got %+v", batch)
	}
}
