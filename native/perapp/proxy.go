package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wzshiming/socks5"
)

// FlowKey names a redirected connection the way it reaches the local proxy: from the address
// the app was talking to, and from the app's own port (only the addresses are swapped).
type FlowKey struct {
	Addr netip.Addr
	Port uint16
}

// Flow is where a redirected connection was going, and which local proxy took it.
type Flow struct {
	Dst       netip.AddrPort
	ProxyPort uint16
	last      atomic.Int64 // unix seconds of the last packet
	closed    atomic.Int64 // unix seconds of the first FIN or RST, 0 while open
}

func (f *Flow) Touch() { f.last.Store(time.Now().Unix()) }

// NAT is the table of redirected connections, shared by the packet filter and the local proxies.
type NAT struct {
	mu  sync.RWMutex
	tcp map[FlowKey]*Flow
	udp map[FlowKey]*Flow
}

func NewNAT() *NAT {
	return &NAT{tcp: map[FlowKey]*Flow{}, udp: map[FlowKey]*Flow{}}
}

func (n *NAT) table(tcp bool) map[FlowKey]*Flow {
	if tcp {
		return n.tcp
	}
	return n.udp
}

func (n *NAT) Get(tcp bool, k FlowKey) *Flow {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.table(tcp)[k]
}

// Add keeps the first flow under a key: a retransmitted SYN mustn't move a connection.
func (n *NAT) Add(tcp bool, k FlowKey, f *Flow) *Flow {
	n.mu.Lock()
	defer n.mu.Unlock()
	if old := n.table(tcp)[k]; old != nil {
		return old
	}
	f.Touch()
	n.table(tcp)[k] = f
	return f
}

// Sweep forgets TCP connections closed a while ago or idle for hours, and UDP ones idle for minutes.
func (n *NAT) Sweep(now time.Time) {
	t := now.Unix()
	n.mu.Lock()
	defer n.mu.Unlock()
	for k, f := range n.tcp {
		if c := f.closed.Load(); (c != 0 && t-c > 30) || t-f.last.Load() > 2*3600 {
			delete(n.tcp, k)
		}
	}
	for k, f := range n.udp {
		if t-f.last.Load() > udpIdleSeconds {
			delete(n.udp, k)
		}
	}
}

const udpIdleSeconds = 180

// Proxy receives the redirected connections of the programs sent to one SOCKS inbound and
// carries them through it. It listens on every address, since a redirected packet arrives
// addressed to the computer's own network address.
type Proxy struct {
	inbound uint16
	dialer  *socks5.Dialer
	nat     *NAT
	tcp     *net.TCPListener
	udp     *net.UDPConn

	mu       sync.Mutex
	sessions map[FlowKey]*udpSession
}

type udpSession struct {
	conn net.Conn
	last atomic.Int64
}

func NewProxy(inbound uint16, user, password string, nat *NAT) (*Proxy, error) {
	d, err := socks5.NewDialer(fmt.Sprintf("socks5://127.0.0.1:%d", inbound))
	if err != nil {
		return nil, err
	}
	if user != "" {
		d.Username = user
		d.Password = password
	}
	tcp, err := net.ListenTCP("tcp4", &net.TCPAddr{})
	if err != nil {
		return nil, err
	}
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{Port: tcp.Addr().(*net.TCPAddr).Port})
	if err != nil {
		// The same number for both is tidier but not needed.
		udp, err = net.ListenUDP("udp4", &net.UDPAddr{})
		if err != nil {
			tcp.Close()
			return nil, err
		}
	}
	return &Proxy{inbound: inbound, dialer: d, nat: nat, tcp: tcp, udp: udp, sessions: map[FlowKey]*udpSession{}}, nil
}

func (p *Proxy) TCPPort() uint16 { return uint16(p.tcp.Addr().(*net.TCPAddr).Port) }
func (p *Proxy) UDPPort() uint16 { return uint16(p.udp.LocalAddr().(*net.UDPAddr).Port) }

// Serve runs until ctx ends.
func (p *Proxy) Serve(ctx context.Context) {
	go func() {
		<-ctx.Done()
		p.tcp.Close()
		p.udp.Close()
		p.mu.Lock()
		for k, s := range p.sessions {
			s.conn.Close()
			delete(p.sessions, k)
		}
		p.mu.Unlock()
	}()
	go p.sweepUDP(ctx)
	go p.serveUDP(ctx)
	for {
		c, err := p.tcp.AcceptTCP()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			continue
		}
		go p.handleTCP(ctx, c)
	}
}

func keyOf(a netip.AddrPort) FlowKey {
	return FlowKey{a.Addr().Unmap(), a.Port()}
}

func (p *Proxy) handleTCP(ctx context.Context, c *net.TCPConn) {
	defer c.Close()
	flow := p.nat.Get(true, keyOf(c.RemoteAddr().(*net.TCPAddr).AddrPort()))
	if flow == nil {
		// Not a redirected connection (someone on the network trying the port).
		return
	}
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	remote, err := p.dialer.DialContext(dialCtx, "tcp", flow.Dst.String())
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("TCP to %s through 127.0.0.1:%d failed: %v", flow.Dst, p.inbound, err)
		}
		return
	}
	defer remote.Close()
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(remote, c)
		closeWrite(remote)
		close(done)
	}()
	_, _ = io.Copy(c, remote)
	_ = c.CloseWrite()
	<-done
}

func closeWrite(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = c.Close()
}

func (p *Proxy) serveUDP(ctx context.Context) {
	buf := make([]byte, 65535)
	for {
		n, from, err := p.udp.ReadFromUDPAddrPort(buf)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		key := keyOf(from)
		flow := p.nat.Get(false, key)
		if flow == nil {
			continue
		}
		flow.Touch()
		s, err := p.session(ctx, key, flow)
		if err != nil {
			continue
		}
		s.last.Store(time.Now().Unix())
		// Write copies the bytes out before buf is read into again.
		_, _ = s.conn.Write(buf[:n])
	}
}

// session is the SOCKS UDP association for one app socket and one destination.
func (p *Proxy) session(ctx context.Context, key FlowKey, flow *Flow) (*udpSession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if s := p.sessions[key]; s != nil {
		return s, nil
	}
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := p.dialer.DialContext(dialCtx, "udp", flow.Dst.String())
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("UDP to %s through 127.0.0.1:%d failed: %v", flow.Dst, p.inbound, err)
		}
		return nil, err
	}
	s := &udpSession{conn: conn}
	s.last.Store(time.Now().Unix())
	p.sessions[key] = s
	client := netip.AddrPortFrom(key.Addr, key.Port)
	go func() {
		buf := make([]byte, 65535)
		for {
			n, err := conn.Read(buf)
			if err != nil {
				p.drop(key, s)
				return
			}
			s.last.Store(time.Now().Unix())
			flow.Touch()
			_, _ = p.udp.WriteToUDPAddrPort(buf[:n], client)
		}
	}()
	return s, nil
}

func (p *Proxy) drop(key FlowKey, s *udpSession) {
	p.mu.Lock()
	if p.sessions[key] == s {
		delete(p.sessions, key)
	}
	p.mu.Unlock()
	s.conn.Close()
}

func (p *Proxy) sweepUDP(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			p.mu.Lock()
			var idle []FlowKey
			for k, s := range p.sessions {
				if now.Unix()-s.last.Load() > udpIdleSeconds {
					idle = append(idle, k)
				}
			}
			p.mu.Unlock()
			for _, k := range idle {
				p.mu.Lock()
				s := p.sessions[k]
				p.mu.Unlock()
				if s != nil {
					p.drop(k, s)
				}
			}
		}
	}
}
