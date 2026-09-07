package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// postAct submits one speech act as `actor` and returns the HTTP status plus body.
func postAct(t *testing.T, router *gin.Engine, wsID, sessionID, actor string, req PostSpeechActRequest) (int, string) {
	t.Helper()
	body, _ := json.Marshal(req)
	httpReq := httptest.NewRequest("POST",
		fmt.Sprintf("/v1/council/sessions/%s/acts?network=%s", sessionID, wsID), bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Actor-Id", actor)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httpReq)
	return w.Code, w.Body.String()
}

func newCouncilSession(t *testing.T, router *gin.Engine, wsID, channelName string, maxRounds int) models.CouncilSession {
	t.Helper()
	body, _ := json.Marshal(CreateCouncilSessionRequest{Channel: channelName, Topic: "Auth refactor", MaxRounds: maxRounds})
	req := httptest.NewRequest("POST", "/v1/council/sessions?network="+wsID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor-Id", "human:user")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("session create failed: %d %s", w.Code, w.Body.String())
	}
	var s models.CouncilSession
	_ = json.Unmarshal(w.Body.Bytes(), &s)
	return s
}

// A bystander agent that is NOT the designated mandatory challenger must not be
// able to unlock resolution sealing. Sealing authority belongs to the appointed
// adversary (or the human); otherwise appointing a challenger means nothing and
// the proposer only needs one friendly agent to rubber-stamp its own work.
func TestCouncilBystanderSupportCannotUnlockSealing(t *testing.T) {
	ws, ch, router := setupCouncilTestDB(t)
	geminiType := "gemini"
	db.DB.Create(&models.WorkspaceMember{
		WorkspaceID: ws.ID, AgentName: "gemini", AgentType: &geminiType, Status: "online",
	})

	session := newCouncilSession(t, router, ws.ID, ch.Name, 3)
	if session.MandatoryChallenger != "codex" {
		t.Fatalf("expected codex as challenger, got %q", session.MandatoryChallenger)
	}

	if code, body := postAct(t, router, ws.ID, session.ID, "claude", PostSpeechActRequest{
		ActType: models.ActProposal, Summary: "JWT RS256",
		Metadata: map[string]interface{}{"session_id": "sess-claude-1"},
	}); code != http.StatusCreated {
		t.Fatalf("proposal rejected: %d %s", code, body)
	}

	if code, body := postAct(t, router, ws.ID, session.ID, "codex", PostSpeechActRequest{
		ActType: models.ActChallenge, Summary: "RS256 key rotation unaddressed",
	}); code != http.StatusCreated {
		t.Fatalf("challenge rejected: %d %s", code, body)
	}

	// gemini is a bystander: never appointed, never reviewed anything.
	if code, _ := postAct(t, router, ws.ID, session.ID, "gemini", PostSpeechActRequest{
		ActType: models.ActSupport, Summary: "lgtm",
	}); code == http.StatusCreated {
		t.Logf("bystander SUPPORT was accepted (status %d)", code)
	}

	// The challenger's objection was never answered, yet the proposer seals.
	code, body := postAct(t, router, ws.ID, session.ID, "claude", PostSpeechActRequest{
		ActType: models.ActResolution, Summary: "Sealing JWT RS256",
		Payload: map[string]interface{}{"spec": "jwt-rs256"},
	})
	if code == http.StatusCreated {
		t.Fatalf("BUG: proposer sealed a RESOLUTION on a bystander rubber stamp while the "+
			"mandatory challenger objection stood unanswered (status %d, body %s)", code, body)
	}

	var sealed models.CouncilSession
	db.DB.Where("id = ?", session.ID).First(&sealed)
	if sealed.Status == models.CouncilStatusConverged {
		t.Fatalf("BUG: session converged without the appointed challenger support")
	}
}

// A SUPPORT applies to the proposal version that was on the table when it was
// given. Once the proposer revises the design in a later DEFENSE, that stale
// SUPPORT must not still authorize sealing the new, unreviewed version.
func TestCouncilStaleSupportCannotSealRevisedProposal(t *testing.T) {
	ws, ch, router := setupCouncilTestDB(t)
	session := newCouncilSession(t, router, ws.ID, ch.Name, 3)

	if code, body := postAct(t, router, ws.ID, session.ID, "claude", PostSpeechActRequest{
		ActType: models.ActProposal, Summary: "v1: JWT RS256, no blacklist",
		Payload:  map[string]interface{}{"spec": "v1"},
		Metadata: map[string]interface{}{"session_id": "sess-claude-1"},
	}); code != http.StatusCreated {
		t.Fatalf("proposal rejected: %d %s", code, body)
	}
	if code, body := postAct(t, router, ws.ID, session.ID, "codex", PostSpeechActRequest{
		ActType: models.ActChallenge, Summary: "no revocation path",
	}); code != http.StatusCreated {
		t.Fatalf("challenge rejected: %d %s", code, body)
	}
	if code, body := postAct(t, router, ws.ID, session.ID, "codex", PostSpeechActRequest{
		ActType: models.ActSupport, Summary: "v1 acceptable after clarification",
	}); code != http.StatusCreated {
		t.Fatalf("support rejected: %d %s", code, body)
	}

	// Proposer now materially changes the design after approval was granted.
	if code, body := postAct(t, router, ws.ID, session.ID, "claude", PostSpeechActRequest{
		ActType: models.ActDefense, Summary: "v2: switched to HS256 with shared secret",
		Payload: map[string]interface{}{"spec": "v2-hs256-shared-secret"},
	}); code != http.StatusCreated {
		t.Fatalf("defense rejected: %d %s", code, body)
	}

	code, body := postAct(t, router, ws.ID, session.ID, "claude", PostSpeechActRequest{
		ActType: models.ActResolution, Summary: "Sealing v2",
		Payload: map[string]interface{}{"spec": "v2-hs256-shared-secret"},
	})
	if code == http.StatusCreated {
		var sealed models.CouncilSession
		db.DB.Where("id = ?", session.ID).First(&sealed)
		t.Fatalf("BUG: a stale SUPPORT for v1 sealed an unreviewed v2 (status %d, body %s, sealed=%s)",
			code, body, string(sealed.Resolution))
	}
}

// A session that has reached its round limit while a SUPPORT already exists must
// not be left in `debating` with a stale deadline: nothing further can advance
// it, so it silently waits for the scheduler to reap it as a challenger timeout
// that never actually happened.
func TestCouncilDefenseAtRoundLimitDoesNotStall(t *testing.T) {
	ws, ch, router := setupCouncilTestDB(t)
	session := newCouncilSession(t, router, ws.ID, ch.Name, 1)

	postAct(t, router, ws.ID, session.ID, "claude", PostSpeechActRequest{
		ActType: models.ActProposal, Summary: "v1",
		Metadata: map[string]interface{}{"session_id": "sess-claude-1"},
	})
	postAct(t, router, ws.ID, session.ID, "codex", PostSpeechActRequest{
		ActType: models.ActChallenge, Summary: "objection",
	})
	postAct(t, router, ws.ID, session.ID, "codex", PostSpeechActRequest{
		ActType: models.ActSupport, Summary: "ok",
	})

	var before models.CouncilSession
	db.DB.Where("id = ?", session.ID).First(&before)
	deadlineBefore := before.ChallengeDeadlineAt

	postAct(t, router, ws.ID, session.ID, "claude", PostSpeechActRequest{
		ActType: models.ActDefense, Summary: "final revision at round limit",
	})

	var after models.CouncilSession
	db.DB.Where("id = ?", session.ID).First(&after)
	if after.Status == models.CouncilStatusDebating &&
		deadlineBefore != nil && after.ChallengeDeadlineAt != nil &&
		*after.ChallengeDeadlineAt == *deadlineBefore {
		t.Fatalf("BUG: DEFENSE at the round limit advanced nothing - session still %q, round %d/%d, "+
			"deadline not extended; it will be reaped as a challenger timeout that never happened",
			after.Status, after.CurrentRound, after.MaxRounds)
	}
}
