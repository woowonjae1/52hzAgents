package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// LaunchAgentRequest is the optional JSON body of POST /v1/agents/:name/launch.
// Env carries per-agent settings for runtimes that need them before they can
// run — e.g. an ACP agent's ACP_COMMAND / ACP_PERMISSION_MODE. They are handed
// to `wwj connect` as `--env KEY=VALUE` and stored on that agent only; wwj
// accepts just the keys the agent type declares in its registry env_config.
type LaunchAgentRequest struct {
	AgentType string            `json:"agent_type"`
	Env       map[string]string `json:"env"`
}

var launchEnvKeyRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

const (
	maxLaunchEnvEntries  = 16
	maxLaunchEnvValueLen = 4096
	// cmd.exe re-parses the command line when the launcher is a .cmd shim
	// (bare `wwj` on Windows). Go's argument quoting does not escape these for
	// cmd, so a value containing one could break out into a second command.
	cmdShimMetachars = "\"%!&|<>^"
)

// launchConnectExtraArgs reads the optional LaunchAgentRequest body and returns
// the extra `wwj connect` argv (`--type`, `--env` pairs). An empty body is the
// common case (every roster card) and yields no extra args.
func launchConnectExtraArgs(body io.Reader, cliPath string) ([]string, error) {
	var req LaunchAgentRequest
	if body != nil {
		if err := json.NewDecoder(body).Decode(&req); err != nil && err != io.EOF {
			return nil, fmt.Errorf("invalid request body: %v", err)
		}
	}
	var args []string
	if t := strings.TrimSpace(req.AgentType); t != "" {
		if !agentIdentRe.MatchString(t) {
			return nil, fmt.Errorf("agent_type is not a valid runtime type")
		}
		args = append(args, "--type", t)
	}
	envArgs, err := launchEnvArgs(req.Env, runtime.GOOS == "windows" && cliPath == "wwj")
	if err != nil {
		return nil, err
	}
	return append(args, envArgs...), nil
}

// launchEnvArgs turns an env map into `--env KEY=VALUE` argv pairs, sorted by
// key so the command line is deterministic. Values are never interpolated into
// a shell string: each pair is its own argv entry. viaCmdShim tightens the
// value charset for the one path where cmd.exe does see the arguments.
func launchEnvArgs(env map[string]string, viaCmdShim bool) ([]string, error) {
	if len(env) == 0 {
		return nil, nil
	}
	if len(env) > maxLaunchEnvEntries {
		return nil, fmt.Errorf("at most %d env entries", maxLaunchEnvEntries)
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	args := make([]string, 0, len(keys)*2)
	for _, k := range keys {
		if !launchEnvKeyRe.MatchString(k) {
			return nil, fmt.Errorf("env key %q must be UPPER_SNAKE_CASE", k)
		}
		v := strings.TrimSpace(env[k])
		if len(v) > maxLaunchEnvValueLen {
			return nil, fmt.Errorf("env %s is too long", k)
		}
		for _, r := range v {
			if r < 0x20 || r == 0x7f {
				return nil, fmt.Errorf("env %s must be a single line of printable text", k)
			}
		}
		if viaCmdShim && strings.ContainsAny(v, cmdShimMetachars) {
			return nil, fmt.Errorf("env %s may not contain any of %s on this launcher", k, cmdShimMetachars)
		}
		args = append(args, "--env", k+"="+v)
	}
	return args, nil
}
