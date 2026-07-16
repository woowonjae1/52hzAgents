package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func authorizationContext(tokenHeader, tokenQuery string) (*gin.Context, *httptest.ResponseRecorder) {
	request := httptest.NewRequest(http.MethodGet, "/v1/workspaces/test?token="+tokenQuery, nil)
	if tokenHeader != "" {
		request.Header.Set("X-Workspace-Token", tokenHeader)
	}
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = request
	return context, response
}

func TestAuthorizeWorkspace(t *testing.T) {
	gin.SetMode(gin.TestMode)
	validToken := "workspace-token"
	hash := hashWorkspaceToken(validToken)
	workspace := &models.Workspace{PasswordHash: &hash}

	t.Run("rejects missing and invalid credentials", func(t *testing.T) {
		context, response := authorizationContext("", "")
		if authorizeWorkspace(context, workspace) {
			t.Fatal("missing credential was authorized")
		}
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("missing credential status = %d, want %d", response.Code, http.StatusUnauthorized)
		}

		context, response = authorizationContext("invalid", "")
		if authorizeWorkspace(context, workspace) {
			t.Fatal("invalid credential was authorized")
		}
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("invalid credential status = %d, want %d", response.Code, http.StatusUnauthorized)
		}
	})

	t.Run("accepts hashed header token", func(t *testing.T) {
		context, response := authorizationContext(validToken, "")
		if !authorizeWorkspace(context, workspace) {
			t.Fatal("valid header credential was rejected")
		}
		if response.Code != http.StatusOK {
			t.Fatalf("valid header response status = %d, want %d", response.Code, http.StatusOK)
		}
	})

	t.Run("uses header before compatibility query token", func(t *testing.T) {
		context, _ := authorizationContext("invalid", validToken)
		if authorizeWorkspace(context, workspace) {
			t.Fatal("invalid header must not fall back to query token")
		}

		context, _ = authorizationContext("", validToken)
		if !authorizeWorkspace(context, workspace) {
			t.Fatal("valid compatibility query token was rejected")
		}
	})
}
