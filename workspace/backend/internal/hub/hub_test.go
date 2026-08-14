package hub

import (
	"strings"
	"testing"
	"time"
)

func matchChannel(clientChan, msgChan string) bool {
	clientChannel := strings.TrimPrefix(clientChan, "channel/")
	messageChannel := strings.TrimPrefix(msgChan, "channel/")
	return clientChannel == "" || clientChannel == messageChannel
}

func TestEventHubBucketedBroadcast(t *testing.T) {
	InitHub()

	c1 := &Client{
		ID:          "client-ws-all",
		WorkspaceID: "ws-1",
		ChannelName: "",
		Send:        make(chan string, 10),
	}
	c2 := &Client{
		ID:          "client-ws-general",
		WorkspaceID: "ws-1",
		ChannelName: "general",
		Send:        make(chan string, 10),
	}
	c3 := &Client{
		ID:          "client-ws-other-channel",
		WorkspaceID: "ws-1",
		ChannelName: "random",
		Send:        make(chan string, 10),
	}
	c4 := &Client{
		ID:          "client-other-workspace",
		WorkspaceID: "ws-2",
		ChannelName: "general",
		Send:        make(chan string, 10),
	}

	GlobalHub.Register(c1)
	GlobalHub.Register(c2)
	GlobalHub.Register(c3)
	GlobalHub.Register(c4)

	// Wait briefly for register loop to process
	for {
		GlobalHub.mu.RLock()
		registered := len(GlobalHub.clients)
		GlobalHub.mu.RUnlock()
		if registered >= 4 {
			break
		}
	}

	// Broadcast to ws-1 / general
	GlobalHub.Broadcast(BroadcastMsg{
		WorkspaceID: "ws-1",
		ChannelName: "channel/general",
		Payload:     `{"event":"hello"}`,
	})

	select {
	case msg := <-c1.Send:
		if msg != `{"event":"hello"}` {
			t.Errorf("c1 got wrong msg: %s", msg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Errorf("c1 (global subscriber) should have received the message")
	}

	select {
	case msg := <-c2.Send:
		if msg != `{"event":"hello"}` {
			t.Errorf("c2 got wrong msg: %s", msg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Errorf("c2 (channel subscriber) should have received the message")
	}

	select {
	case msg := <-c3.Send:
		t.Errorf("c3 should not have received message for general channel, got: %s", msg)
	default:
		// expected
	}

	select {
	case msg := <-c4.Send:
		t.Errorf("c4 should not have received message for ws-1, got: %s", msg)
	default:
		// expected
	}

	// Cleanup
	GlobalHub.Unregister(c1)
	GlobalHub.Unregister(c2)
	GlobalHub.Unregister(c3)
	GlobalHub.Unregister(c4)
}
