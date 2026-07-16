package config

import "testing"

func TestIsAllowedOrigin(t *testing.T) {
	configuration := &Config{CORSOrigins: []string{"http://localhost:3000", "https://workspace.example"}}

	for _, origin := range []string{"", "http://localhost:3000", "https://workspace.example"} {
		if !configuration.IsAllowedOrigin(origin) {
			t.Errorf("origin %q should be allowed", origin)
		}
	}
	if configuration.IsAllowedOrigin("https://untrusted.example") {
		t.Error("unconfigured origin should be rejected")
	}
}
