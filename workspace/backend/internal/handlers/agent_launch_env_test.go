package handlers

import (
	"reflect"
	"strings"
	"testing"
)

func TestLaunchEnvArgs(t *testing.T) {
	got, err := launchEnvArgs(map[string]string{
		"ACP_PERMISSION_MODE": "auto",
		"ACP_COMMAND":         "  gemini --experimental-acp  ",
	}, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{
		"--env", "ACP_COMMAND=gemini --experimental-acp",
		"--env", "ACP_PERMISSION_MODE=auto",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}

	if got, err := launchEnvArgs(nil, false); err != nil || got != nil {
		t.Fatalf("empty env: got %q, %v", got, err)
	}

	// Outside a cmd shim, shell metacharacters are just text: each pair is one
	// argv entry and never reaches a shell.
	if _, err := launchEnvArgs(map[string]string{"ACP_COMMAND": `"C:\Tools\a b.exe" acp & more`}, false); err != nil {
		t.Fatalf("direct exec should accept metacharacters: %v", err)
	}
}

func TestLaunchConnectExtraArgs(t *testing.T) {
	// No body (every roster card) → no extra args.
	for _, body := range []string{"", "{}"} {
		got, err := launchConnectExtraArgs(strings.NewReader(body), "cli.js")
		if err != nil || len(got) != 0 {
			t.Fatalf("body %q: got %q, %v", body, got, err)
		}
	}
	if got, err := launchConnectExtraArgs(nil, "cli.js"); err != nil || len(got) != 0 {
		t.Fatalf("nil body: got %q, %v", got, err)
	}

	got, err := launchConnectExtraArgs(strings.NewReader(
		`{"agent_type":"acp","env":{"ACP_COMMAND":"opencode acp","ACP_PERMISSION_MODE":"ask"}}`), "cli.js")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--type", "acp", "--env", "ACP_COMMAND=opencode acp", "--env", "ACP_PERMISSION_MODE=ask"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}

	if _, err := launchConnectExtraArgs(strings.NewReader(`{"agent_type":"acp; rm -rf /"}`), "cli.js"); err == nil {
		t.Fatal("want error for invalid agent_type")
	}
	if _, err := launchConnectExtraArgs(strings.NewReader(`{not json`), "cli.js"); err == nil {
		t.Fatal("want error for malformed body")
	}
}

func TestLaunchEnvArgsRejects(t *testing.T) {
	cases := []struct {
		name  string
		env   map[string]string
		shim  bool
		match string
	}{
		{"lowercase key", map[string]string{"acp_command": "x"}, false, "UPPER_SNAKE_CASE"},
		{"key with dash", map[string]string{"ACP-COMMAND": "x"}, false, "UPPER_SNAKE_CASE"},
		{"newline value", map[string]string{"ACP_COMMAND": "a\nb"}, false, "single line"},
		{"nul value", map[string]string{"ACP_COMMAND": "a\x00b"}, false, "single line"},
		{"too long", map[string]string{"ACP_COMMAND": strings.Repeat("a", maxLaunchEnvValueLen+1)}, false, "too long"},
		{"cmd shim ampersand", map[string]string{"ACP_COMMAND": "opencode&calc"}, true, "may not contain"},
		{"cmd shim percent", map[string]string{"ACP_COMMAND": "%PATH%"}, true, "may not contain"},
		{"cmd shim quote", map[string]string{"ACP_COMMAND": `a" & calc`}, true, "may not contain"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := launchEnvArgs(tc.env, tc.shim)
			if err == nil || !strings.Contains(err.Error(), tc.match) {
				t.Fatalf("want error containing %q, got %v", tc.match, err)
			}
		})
	}

	many := map[string]string{}
	for i := 0; i <= maxLaunchEnvEntries; i++ {
		many["K"+strings.Repeat("A", i+1)] = "v"
	}
	if _, err := launchEnvArgs(many, false); err == nil {
		t.Fatal("want error for too many entries")
	}

	// A preset command passes the stricter shim check.
	if _, err := launchEnvArgs(map[string]string{"ACP_COMMAND": "npx -y @zed-industries/claude-code-acp"}, true); err != nil {
		t.Fatalf("preset rejected on cmd shim: %v", err)
	}
}
