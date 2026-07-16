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
	RequestsPerMinute   int
	CORSOrigins         []string
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

	rateLimitStr := os.Getenv("REQUESTS_PER_MINUTE")
	rateLimit := 120
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

	GlobalConfig = &Config{
		DatabaseURL:         dbURL,
		AuthMode:            authMode,
		FileStorageBackend:  storageBackend,
		FileStoragePath:     storagePath,
		Host:                host,
		Port:                port,
		AgentTimeoutSeconds: timeout,
		RequestsPerMinute:   rateLimit,
		CORSOrigins:         allowedOrigins,
	}
}

// IsAllowedOrigin reports whether a browser Origin may use credentialed CORS
// or establish a WebSocket connection. Requests without Origin are non-browser
// clients and are authenticated by their workspace token instead.
func (c *Config) IsAllowedOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	for _, allowed := range c.CORSOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}
