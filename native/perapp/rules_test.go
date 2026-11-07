package main

import "testing"

func TestRules(t *testing.T) {
	r := NewRules(&Config{
		Proxies: []ProxyRule{
			{Apps: []string{`C:\Games\Blocked\`}, Port: 9000},
			{Apps: []string{`C:\Users\me\AppData\Local\Discord\`}, Port: 9001},
			{Apps: []string{`Telegram.exe`}, Port: 9002},
			{Apps: []string{" ", ""}, Port: 9003},
		},
		Exclude: []string{`C:\Program Files\Bridge\resources\core\sing-box.exe`},
	})
	cases := map[string]uint16{
		`C:\Users\me\AppData\Local\Discord\app-1.0.9187\Discord.exe`: 9001,
		`c:\users\ME\appdata\local\discord\app-1.0.9200\Discord.exe`: 9001,
		`D:\Apps\Telegram Desktop\Telegram.exe`:                      9002,
		`C:\Games\Blocked\game.exe`:                                  9000,
		`C:\Windows\System32\svchost.exe`:                            0,
		`C:\Program Files\Bridge\resources\core\sing-box.exe`:        0,
		``: 0,
	}
	for path, want := range cases {
		if got := r.Port(path); got != want {
			t.Errorf("%q: got %d, want %d", path, got, want)
		}
	}
	if ports := r.Ports(); len(ports) != 3 {
		t.Errorf("a rule without names shouldn't count: %v", ports)
	}
}
