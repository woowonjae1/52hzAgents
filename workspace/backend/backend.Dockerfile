# Build the Go workspace backend in a small, reproducible image.
FROM golang:1.21-alpine AS builder

RUN apk add --no-cache gcc musl-dev

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 CGO_CFLAGS="-D_LARGEFILE64_SOURCE -D_GNU_SOURCE" GOOS=linux \
    go build -trimpath -ldflags="-s -w" -o /out/workspace-backend ./cmd/server

FROM alpine:3.20

RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /out/workspace-backend /usr/local/bin/workspace-backend

ENV HOST=0.0.0.0 \
    PORT=8000 \
    FILE_STORAGE_BACKEND=local \
    FILE_STORAGE_PATH=/var/lib/openagents/files

RUN mkdir -p /var/lib/openagents/files
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/workspace-backend"]
