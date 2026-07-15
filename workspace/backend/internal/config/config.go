package config

import (
	"os"
	"strconv"
)

type Config struct {
	DatabaseURL         string
	AuthMode            string
	FileStorageBackend  string
	FileStoragePath     string
	Host                string
	Port                int
	AgentTimeoutSeconds int
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

	GlobalConfig = &Config{
		DatabaseURL:         dbURL,
		AuthMode:            authMode,
		FileStorageBackend:  storageBackend,
		FileStoragePath:     storagePath,
		Host:                host,
		Port:                port,
		AgentTimeoutSeconds: timeout,
	}
}
