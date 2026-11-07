package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Config is what Bridge writes before starting this program (see src/main/perapp.ts).
type Config struct {
	// The SOCKS user and password of Bridge's inbounds.
	User     string `json:"user"`
	Password string `json:"password"`
	// In order; the first that names a program wins. Bridge puts Block first.
	Proxies []ProxyRule `json:"proxies"`
	// Bridge's own programs, never redirected whatever the rules say.
	Exclude []string `json:"exclude"`
}

// ProxyRule hands the programs it names to one of Bridge's SOCKS inbounds on 127.0.0.1.
type ProxyRule struct {
	// A name matches anywhere in the program's full path, ignoring case: a path, a folder
	// (so a rule outlives an app updating itself into a new versioned folder) or an exe name.
	Apps []string `json:"apps"`
	Port uint16   `json:"port"`
}

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("the config is not valid JSON: %w", err)
	}
	for _, p := range c.Proxies {
		if p.Port == 0 {
			return nil, fmt.Errorf("a rule has no port")
		}
	}
	return &c, nil
}

// Rules answers which inbound a program's connections go to.
type Rules struct {
	names   [][]string
	ports   []uint16
	exclude []string
}

func NewRules(c *Config) *Rules {
	r := &Rules{}
	for _, p := range c.Proxies {
		var names []string
		for _, a := range p.Apps {
			if a = strings.ToLower(strings.TrimSpace(a)); a != "" {
				names = append(names, a)
			}
		}
		if len(names) > 0 {
			r.names = append(r.names, names)
			r.ports = append(r.ports, p.Port)
		}
	}
	for _, e := range c.Exclude {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			r.exclude = append(r.exclude, e)
		}
	}
	return r
}

// Port is the inbound for a program's full path, or 0 when its connections are left alone.
func (r *Rules) Port(path string) uint16 {
	if path == "" {
		return 0
	}
	p := strings.ToLower(path)
	for _, e := range r.exclude {
		if p == e {
			return 0
		}
	}
	for i, names := range r.names {
		for _, n := range names {
			if strings.Contains(p, n) {
				return r.ports[i]
			}
		}
	}
	return 0
}

// Ports lists every inbound the rules use, once each.
func (r *Rules) Ports() []uint16 {
	seen := map[uint16]bool{}
	var out []uint16
	for _, p := range r.ports {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}
