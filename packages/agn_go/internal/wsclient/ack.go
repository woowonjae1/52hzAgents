package wsclient

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func newClientMessageID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return hex.EncodeToString(raw[:])
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func (b *Bridge) registerAck(id string) chan ackResult {
	result := make(chan ackResult, 1)
	b.ackMu.Lock()
	if b.pendingAcks == nil {
		b.pendingAcks = make(map[string]chan ackResult)
	}
	b.pendingAcks[id] = result
	b.ackMu.Unlock()
	return result
}

func (b *Bridge) removeAck(id string) {
	b.ackMu.Lock()
	delete(b.pendingAcks, id)
	b.ackMu.Unlock()
}

func (b *Bridge) deliverAck(id string, result ackResult) {
	b.ackMu.Lock()
	resultCh := b.pendingAcks[id]
	b.ackMu.Unlock()
	if resultCh != nil {
		select {
		case resultCh <- result:
		default:
		}
	}
}

func (b *Bridge) readPump() {
	for {
		_, message, err := b.conn.ReadMessage()
		if err != nil {
			log.Printf("[bridge:%s] websocket read closed: %v", b.AgentName, err)
			return
		}

		var envelope struct {
			Type            string `json:"type"`
			Status          string `json:"status"`
			EventID         string `json:"event_id"`
			ClientMessageID string `json:"client_message_id"`
			Error           string `json:"error"`
			Source          string `json:"source"`
			Payload         struct {
				Content string `json:"content"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(message, &envelope); err != nil {
			continue
		}
		if envelope.Type == "system.event.ack" {
			b.deliverAck(envelope.ClientMessageID, ackResult{
				Status:  envelope.Status,
				EventID: envelope.EventID,
				Error:   envelope.Error,
			})
			continue
		}
		if envelope.Type != "workspace.message.posted" || envelope.Source == b.source {
			continue
		}
		content := strings.TrimSpace(envelope.Payload.Content)
		if content != "" && b.onMessage != nil {
			b.onMessage(content)
		}
	}
}

func (b *Bridge) SendOutput(line string) error {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}

	clientMessageID := newClientMessageID()
	ackCh := b.registerAck(clientMessageID)
	defer b.removeAck(clientMessageID)

	event := map[string]interface{}{
		"type":              "workspace.message.posted",
		"source":            b.source,
		"target":            "channel/" + b.Channel,
		"network":           b.networkID,
		"client_message_id": clientMessageID,
		"payload": map[string]interface{}{
			"content":      line,
			"message_type": "chat",
		},
		"metadata": map[string]interface{}{
			"session_id": b.sessionID,
		},
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}

	for attempt := 1; attempt <= b.MaxRetries; attempt++ {
		b.writeMu.Lock()
		conn := b.conn
		if conn != nil {
			err = conn.WriteMessage(websocket.TextMessage, data)
		} else {
			err = fmt.Errorf("websocket connection is closed")
		}
		b.writeMu.Unlock()
		if err != nil {
			if attempt == b.MaxRetries {
				return fmt.Errorf("send message: %w", err)
			}
			continue
		}

		select {
		case result := <-ackCh:
			if result.Status == "confirmed" {
				return nil
			}
			return fmt.Errorf("message rejected: %s", result.Error)
		case <-time.After(b.AckTimeout):
			if attempt == b.MaxRetries {
				return fmt.Errorf("message confirmation timed out after %d attempts", attempt)
			}
		}
	}
	return fmt.Errorf("message confirmation failed")
}
