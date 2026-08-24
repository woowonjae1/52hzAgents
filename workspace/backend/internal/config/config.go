package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	DatabaseURL         string
	AuthMode            string
	FileStorageBackend  string
	FileStoragePath     string
	Host                string
	Port                int
	AgentTimeoutSeconds int
	// PipelineStepTimeoutSeconds bounds how long one pipeline step may run before
	// the scheduler halts it. Independent of AgentTimeoutSeconds on purpose.
	PipelineStepTimeoutSeconds int
	RequestsPerMinute          int
	CORSOrigins                []string
	RouterLLMEnabled           bool
	RouterLLMProvider          string
	RouterLLMModel             string
	RouterLLMAPIKey            string
	RouterLLMBaseURL           string
}

var GlobalConfig *Config

func LoadConfig() {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgresql://postgres:dev@localhost:5432/openagents_workspace"
	}

	authMode := os.Getenv("AUTH_MODE")
	if authMode == "" {
		authMode = "workspace_token"
	}

	storageBackend := os.Getenv("FILE_STORAGE_BACKEND")
	if storageBackend == "" {
		storageBackend = "local"
	}

	storagePath := os.Getenv("FILE_STORAGE_PATH")
	if storagePath == "" {
		storagePath = "/tmp/openagents_files"
	}

	host := os.Getenv("HOST")
	if host == "" {
		host = "0.0.0.0"
	}

	portStr := os.Getenv("PORT")
	port := 8000
	if portStr != "" {
		if p, err := strconv.Atoi(portStr); err == nil {
			port = p
		}
	}

	timeoutStr := os.Getenv("AGENT_TIMEOUT_SECONDS")
	timeout := 60
	if timeoutStr != "" {
		if t, err := strconv.Atoi(timeoutStr); err == nil {
			timeout = t
		}
	}

	// A pipeline step's deadline is a different quantity from agent liveness by
	// one to two orders of magnitude. AGENT_TIMEOUT_SECONDS answers "has this
	// agent gone away?", which is a question about seconds; a step's deadline
	// answers "how long may a coding task legitimately take?", which is a
	// question about tens of minutes. Deriving the second from the first kills
	// every real task at the one-minute mark.
	stepTimeoutStr := os.Getenv("PIPELINE_STEP_TIMEOUT_SECONDS")
	stepTimeout := 1800
	if stepTimeoutStr != "" {
		if t, err := strconv.Atoi(stepTimeoutStr); err == nil && t > 0 {
			stepTimeout = t
		}
	}

	rateLimitStr := os.Getenv("REQUESTS_PER_MINUTE")
	// Budgeted against real steady-state load, because the limiter keys on client
	// IP and every agent connector plus every browser tab on a machine shares one.
	// A browser tab costs ~50 req/min (discovery + the 15s sidebar refresh) and an
	// idle connector ~45. The old default of 120 could not fit one browser and two
	// agents, which is why the dev script had to override it with 100000 — a
	// default nobody can run under is not a safety limit, it is a bug that gets
	// configured away. 600 still stops a runaway poll loop dead.
	rateLimit := 600
	if rateLimitStr != "" {
		if parsed, err := strconv.Atoi(rateLimitStr); err == nil && parsed > 0 {
			rateLimit = parsed
		}
	}

	corsOrigins := os.Getenv("CORS_ORIGINS")
	if corsOrigins == "" {
		corsOrigins = "http://localhost:3000,http://localhost:3001"
	}
	allowedOrigins := make([]string, 0)
	for _, origin := range strings.Split(corsOrigins, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			allowedOrigins = append(allowedOrigins, origin)
		}
	}

	routerEnabled := parseBoolEnv("ROUTER_LLM_ENABLED", true)
	routerProvider := strings.ToLower(strings.TrimSpace(os.Getenv("ROUTER_LLM_PROVIDER")))
	if routerProvider == "" {
		routerProvider = "anthropic"
	}
	routerKey := strings.TrimSpace(os.Getenv("ROUTER_LLM_API_KEY"))
	if routerKey == "" && routerProvider == "anthropic" {
		routerKey = strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	}

	GlobalConfig = &Config{
		DatabaseURL:                dbURL,
		AuthMode:                   authMode,
		FileStorageBackend:         storageBackend,
		FileStoragePath:            storagePath,
		Host:                       host,
		Port:                       port,
		AgentTimeoutSeconds:        timeout,
		PipelineStepTimeoutSeconds: stepTimeout,
		RequestsPerMinute:          rateLimit,
		CORSOrigins:                allowedOrigins,
		RouterLLMEnabled:           routerEnabled,
		RouterLLMProvider:          routerProvider,
		RouterLLMModel:             strings.TrimSpace(os.Getenv("ROUTER_LLM_MODEL")),
		RouterLLMAPIKey:            routerKey,
		RouterLLMBaseURL:           strings.TrimRight(strings.TrimSpace(os.Getenv("ROUTER_LLM_BASE_URL")), "/"),
	}
}

func parseBoolEnv(name string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	if value == "" {
		return fallback
	}
	return value == "true" || value == "1" || value == "yes"
}

// IsAllowedOrigin reports whether a browser Origin may use credentialed CORS
// or establish a WebSocket connection. Requests without Origin are non-browser
// clients and are authenticated by their workspace token instead.
func (c *Config) IsAllowedOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	for _, allowed := range c.CORSOrigins {
		if allowed == "*" || origin == allowed {
			return true
		}
	}
	if strings.HasPrefix(origin, "http://localhost:") || strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "https://localhost:") {
		return true
	}
	return false
}
