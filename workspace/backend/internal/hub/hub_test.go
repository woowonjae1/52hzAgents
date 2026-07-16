package hub

import (
	"strings"
	"testing"
)

func matchChannel(clientChan, msgChan string) bool {
	clientChannel := strings.TrimPrefix(clientChan, "channel/")
	messageChannel := strings.TrimPrefix(msgChan, "channel/")
	return clientChannel == "" || clientChannel == messageChannel
}

func TestChannelNamesMatch(t *testing.T) {
	tests := []struct {
		clientChan string
		msgChan    string
		want       bool
	}{
		{clientChan: "general", msgChan: "channel/general", want: true},
		{clientChan: "channel/general", msgChan: "general", want: true},
		{clientChan: "", msgChan: "channel/general", want: true},
		{clientChan: "general", msgChan: "channel/other", want: false},
	}

	for _, test := range tests {
		if got := matchChannel(test.clientChan, test.msgChan); got != test.want {
			t.Errorf("matchChannel(%q, %q) = %v, want %v", test.clientChan, test.msgChan, got, test.want)
		}
	}
}
