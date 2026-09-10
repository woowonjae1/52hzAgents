package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func setupCouncilTestDB(t *testing.T) (*models.Workspace, *models.Channel, *gin.Engine) {
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open sqlite in-memory: %v", err)
	}
	db.DB = database

	// Explicitly register ALL required models including Council models
	err = db.DB.AutoMigrate(
		&models.Workspace{},
		&models.WorkspaceMember{},
		&models.Channel{},
		&models.ChannelMember{},
		&models.EventRecord{},
		&models.CouncilSession{},
		&models.SpeechActRecord{},
	)
	if err != nil {
		t.Fatalf("failed to auto-migrate: %v", err)
	}

	// Verify table existence
	if !db.DB.Migrator().HasTable(&models.CouncilSession{}) {
		t.Fatal("expected council_sessions table to exist")
	}
	if !db.DB.Migrator().HasTable(&models.SpeechActRecord{}) {
		t.Fatal("expected speech_act_records table to exist")
	}

	ws := models.Workspace{
		ID:   uuid.New().String(),
		Slug: "council-test-ws",
		Name: "Council Test WS",
	}
	db.DB.Create(&ws)

	ch := models.Channel{
		ID:          uuid.New().String(),
		WorkspaceID: ws.ID,
		Name:        "general",
	}
	db.DB.Create(&ch)

	claudeType := "claude"
	codexType := "codex"
	sessClaude := "sess-claude-1"
	db.DB.Create(&models.WorkspaceMember{
		WorkspaceID: ws.ID,
		AgentName:   "claude",
		AgentType:   &claudeType,
		Status:      "online",
		SessionID:   &sessClaude,
	})
	db.DB.Create(&models.WorkspaceMember{
		WorkspaceID: ws.ID,
		AgentName:   "codex",
		AgentType:   &codexType,
		Role:        "reviewer",
		Status:      "online",
	})

	router := gin.New()
	v1 := router.Group("/v1")
	{
		v1.POST("/council/sessions", CreateCouncilSession)
		v1.GET("/council/sessions/:session_id", GetCouncilSession)
		v1.POST("/council/sessions/:session_id/acts", PostSpeechAct)
	}

	return &ws, &ch, router
}

func TestCouncilLifecycleAndAntiSelfCertification(t *testing.T) {
	ws, ch, router := setupCouncilTestDB(t)

	// 1. Create session via POST /v1/council/sessions
	createReq := CreateCouncilSessionRequest{
		Channel:   ch.Name,
		Topic:     "Refactor Authentication to JWT",
		MaxRounds: 2,
	}
	body, _ := json.Marshal(createReq)
	req := httptest.NewRequest("POST", "/v1/council/sessions?network="+ws.ID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor-Id", "human:user")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected status 201, got %d: %s", w.Code, w.Body.String())
	}

	var session models.CouncilSession
	_ = json.Unmarshal(w.Body.Bytes(), &session)

	if session.Topic != "Refactor Authentication to JWT" {
		t.Fatalf("unexpected topic: %s", session.Topic)
	}
	if session.MandatoryChallenger != "codex" {
		t.Fatalf("expected codex to be selected as reviewer challenger, got %s", session.MandatoryChallenger)
	}

	// 2. Claude submits a PROPOSAL
	propReq := PostSpeechActRequest{
		ActType:  models.ActProposal,
		Summary:  "Introduce JWT with RS256 signing and Redis token blacklist",
		Payload:  map[string]interface{}{"spec": "jwt-rs256"},
		Metadata: map[string]interface{}{"session_id": "sess-claude-1"},
	}
	body, _ = json.Marshal(propReq)
	req = httptest.NewRequest("POST", fmt.Sprintf("/v1/council/sessions/%s/acts?network=%s", session.ID, ws.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor-Id", "claude")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 on proposal, got %d: %s", w.Code, w.Body.String())
	}

	var propResp struct {
		Act models.SpeechActRecord `json:"act"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &propResp)
	proposalID := propResp.Act.ID

	// 3. Claude attempts to self-certify victory by submitting RESOLUTION directly -> MUST FAIL
	resReq := PostSpeechActRequest{
		ActType:  models.ActResolution,
		Summary:  "Self-certified victory without challenge",
		Payload:  map[string]interface{}{"result": "passed"},
		Metadata: map[string]interface{}{"session_id": "sess-claude-1"},
	}
	body, _ = json.Marshal(resReq)
	req = httptest.NewRequest("POST", fmt.Sprintf("/v1/council/sessions/%s/acts?network=%s", session.ID, ws.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor-Id", "claude")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request when self-certifying victory without challenge, got %d", w.Code)
	}

	// 4. Codex (the challenger) submits a CHALLENGE
	chalReq := PostSpeechActRequest{
		ActType:     models.ActChallenge,
		Summary:     "RS256 key rotation is missing; Redis blacklist introduces high latency for stateless tokens",
		TargetActID: &proposalID,
		Payload:     map[string]interface{}{"risk": "rotation_gap"},
	}
	body, _ = json.Marshal(chalReq)
	req = httptest.NewRequest("POST", fmt.Sprintf("/v1/council/sessions/%s/acts?network=%s", session.ID, ws.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor-Id", "codex")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 on challenge, got %d: %s", w.Code, w.Body.String())
	}

	// 5. Claude submits a DEFENSE
	defReq := PostSpeechActRequest{
		ActType:  models.ActDefense,
		Summary:  "Added JWKS endpoint for dynamic key rotation; replaced Redis with local Bloom filter",
		Metadata: map[string]interface{}{"session_id": "sess-claude-1"},
	}
	body, _ = json.Marshal(defReq)
	req = httptest.NewRequest("POST", fmt.Sprintf("/v1/council/sessions/%s/acts?network=%s", session.ID, ws.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor-Id", "claude")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 on defense, got %d: %s", w.Code, w.Body.String())
	}

	// 6. Codex submits SUPPORT
	supReq := PostSpeechActRequest{
		ActType: models.ActSupport,
		Summary: "JWKS key rotation and Bloom filter address all security and latency concerns. LGTM.",
	}
	body, _ = json.Marshal(supReq)
	req = httptest.NewRequest("POST", fmt.Sprintf("/v1/council/sessions/%s/acts?network=%s", session.ID, ws.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor-Id", "codex")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 on support, got %d: %s", w.Code, w.Body.String())
	}

	// 7. Claude now submits RESOLUTION -> MUST SUCCEED and CONVERGE session
	finalResReq := PostSpeechActRequest{
		ActType:  models.ActResolution,
		Summary:  "Final Architecture Decision: JWT with JWKS rotation and Bloom filter blacklist",
		Payload:  map[string]interface{}{"decision": "approved_by_adversary"},
		Metadata: map[string]interface{}{"session_id": "sess-claude-1"},
	}
	body, _ = json.Marshal(finalResReq)
	req = httptest.NewRequest("POST", fmt.Sprintf("/v1/council/sessions/%s/acts?network=%s", session.ID, ws.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor-Id", "claude")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 on resolution sealing, got %d: %s", w.Code, w.Body.String())
	}

	// 8. Verify CouncilSession status is CONVERGED
	var updatedSession models.CouncilSession
	db.DB.Where("id = ?", session.ID).First(&updatedSession)
	if updatedSession.Status != models.CouncilStatusConverged {
		t.Fatalf("expected session status to be 'converged', got %s", updatedSession.Status)
	}

	// 9. Verify event projections were written to events table
	var projectionEvents []models.EventRecord
	db.DB.Where("network_id = ? AND source = ?", ws.ID, "system:council").Find(&projectionEvents)
	if len(projectionEvents) < 5 {
		t.Fatalf("expected at least 5 projection events, found %d", len(projectionEvents))
	}
}

func TestCouncilSessionRevocationCheck(t *testing.T) {
	ws, ch, router := setupCouncilTestDB(t)

	session, err := startCouncilSession(ws.ID, ch, "human:user", "Test Revocation", 3)
	if err != nil {
		t.Fatalf("failed to start council session: %v", err)
	}

	// Stale / revoked session token
	propReq := PostSpeechActRequest{
		ActType:  models.ActProposal,
		Summary:  "Attempt from zombie process",
		Metadata: map[string]interface{}{"session_id": "stale-session-token"},
	}
	body, _ := json.Marshal(propReq)
	req := httptest.NewRequest("POST", fmt.Sprintf("/v1/council/sessions/%s/acts?network=%s", session.ID, ws.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor-Id", "claude")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized for revoked session, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCouncilInterceptRFCCommand(t *testing.T) {
	ws, ch, _ := setupCouncilTestDB(t)

	ok := InterceptRFCCommand(ws.ID, "channel/"+ch.Name, "human:user", "/rfc Migrate to PostgreSQL")
	if !ok {
		t.Fatal("expected InterceptRFCCommand to return true")
	}

	var session models.CouncilSession
	if err := db.DB.Where("workspace_id = ? AND topic = ?", ws.ID, "Migrate to PostgreSQL").First(&session).Error; err != nil {
		t.Fatalf("failed to find council session created from /rfc: %v", err)
	}

	if session.Status != models.CouncilStatusDebating {
		t.Fatalf("expected status debating, got %s", session.Status)
	}
}
