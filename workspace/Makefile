.PHONY: dev dev-backend stop test build reset-db lint

# Start all services (db + backend + frontend)
dev:
	docker compose up --build

# Start only the backend (db + backend, no frontend)
dev-backend:
	docker compose up --build db backend

# Stop all services
stop:
	docker compose down

# Run Go backend tests
test:
	cd backend && go test ./...

# Build Docker images
build:
	docker compose build

# Reset database (destroy and recreate)
reset-db:
	docker compose down -v
	docker compose up -d db
	@echo "Waiting for database..."
	@sleep 3
	docker compose up -d backend

# Lint
lint:
	cd backend && go vet ./...
