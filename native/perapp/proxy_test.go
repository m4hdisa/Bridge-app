package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestThroughSingBox carries a TCP request and a UDP DNS query through a real sing-box SOCKS
// inbound with a password, the way Bridge's apps-in inbounds take them. The packet filter is not
// involved: the test registers the flows itself, as the filter would. Needs the internet and
// BRIDGE_SINGBOX naming sing-box.exe.
func TestThroughSingBox(t *testing.T) {
	singBox := os.Getenv("BRIDGE_SINGBOX")
	if singBox == "" {
		t.Skip("set BRIDGE_SINGBOX to sing-box.exe")
	}
	inbound := freePort(t)
	config := fmt.Sprintf(`{"log":{"level":"warn"},"inbounds":[{"type":"socks","listen":"127.0.0.1","listen_port":%d,"users":[{"username":"u","password":"p"}]}],"outbounds":[{"type":"direct"}]}`, inbound)
	file := filepath.Join(t.TempDir(), "box.json")
	if err := os.WriteFile(file, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	box := exec.Command(singBox, "run", "-c", file)
	box.Stdout, box.Stderr = os.Stderr, os.Stderr
	if err := box.Start(); err != nil {
		t.Fatal(err)
	}
	defer box.Process.Kill()
	for wait := 0; wait < 100; wait++ {
		if c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", inbound)); err == nil {
			c.Close()
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	nat := NewNAT()
	p, err := NewProxy(uint16(inbound), "u", "p", nat)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.Serve(ctx)

	// TCP: a plain HTTP request to one.one.one.one.
	local := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: freePort(t)}
	nat.Add(true, FlowKey{netip.MustParseAddr("127.0.0.1"), uint16(local.Port)}, &Flow{Dst: netip.MustParseAddrPort("1.1.1.1:80"), ProxyPort: p.TCPPort()})
	c, err := (&net.Dialer{LocalAddr: local, Timeout: 5 * time.Second}).Dial("tcp", fmt.Sprintf("127.0.0.1:%d", p.TCPPort()))
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(15 * time.Second))
	_, _ = c.Write([]byte("GET / HTTP/1.1\r\nHost: one.one.one.one\r\nConnection: close\r\n\r\n"))
	body, _ := io.ReadAll(c)
	c.Close()
	if !strings.HasPrefix(string(body), "HTTP/1.1 ") {
		t.Fatalf("TCP through sing-box: %q", body)
	}

	// UDP: a DNS query for example.com to 1.1.1.1.
	u, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer u.Close()
	from := u.LocalAddr().(*net.UDPAddr)
	nat.Add(false, FlowKey{netip.MustParseAddr("127.0.0.1"), uint16(from.Port)}, &Flow{Dst: netip.MustParseAddrPort("1.1.1.1:53"), ProxyPort: p.UDPPort()})
	query := dnsQuery("example.com")
	_ = u.SetDeadline(time.Now().Add(15 * time.Second))
	var answer []byte
	for try := 0; try < 3 && answer == nil; try++ {
		if _, err := u.WriteToUDP(query, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(p.UDPPort())}); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 1500)
		_ = u.SetReadDeadline(time.Now().Add(4 * time.Second))
		if n, _, err := u.ReadFromUDP(buf); err == nil {
			answer = buf[:n]
		}
	}
	if len(answer) < 12 || answer[0] != query[0] || answer[1] != query[1] || binary.BigEndian.Uint16(answer[6:]) == 0 {
		t.Fatalf("UDP through sing-box: no DNS answer (%x)", answer)
	}
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func dnsQuery(name string) []byte {
	q := []byte{0xbe, 0xef, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, part := range strings.Split(name, ".") {
		q = append(q, byte(len(part)))
		q = append(q, part...)
	}
	return append(q, 0, 0, 1, 0, 1)
}
