package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRateLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(RateLimit(2))
	router.GET("/v1/events", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	for attempt := 1; attempt <= 3; attempt++ {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/events", nil))
		if attempt < 3 && response.Code != http.StatusNoContent {
			t.Fatalf("request %d status = %d, want %d", attempt, response.Code, http.StatusNoContent)
		}
		if attempt == 3 && response.Code != http.StatusTooManyRequests {
			t.Fatalf("request %d status = %d, want %d", attempt, response.Code, http.StatusTooManyRequests)
		}
	}
}
