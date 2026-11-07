//go:build windows

package main

import (
	"context"
	"fmt"
	"log"
	"net/netip"
	"os"
	"sync"
	"time"

	A "github.com/wiresock/ndisapi-go"
	D "github.com/wiresock/ndisapi-go/driver"
	N "github.com/wiresock/ndisapi-go/netlib"
	"golang.org/x/sys/windows"
)

// Router watches every packet leaving the computer's main network adapter (through the Windows
// Packet Filter driver). A connection from a program the rules name is turned around to a local
// proxy (see Proxy), which carries it through Bridge's SOCKS inbound; everything else passes
// untouched, so no other program notices anything. Built on the driver maker's Go library
// (github.com/wiresock/ndisapi-go, MIT) and its ProxiFyre example.
type Router struct {
	api     *A.NdisApi
	rules   *Rules
	nat     *NAT
	lookup  *N.ProcessLookup
	self    uint32
	proxies map[uint16]*Proxy // by SOCKS inbound
	tcpOf   map[uint16]uint16 // SOCKS inbound -> local proxy TCP port
	udpOf   map[uint16]uint16
	isTCP   map[uint16]bool // local proxy ports, to spot their replies
	isUDP   map[uint16]bool

	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	filter  *D.QueuedPacketFilter
	ifIndex int
	notify  windows.Handle
}

func NewRouter(c *Config) (*Router, error) {
	api, err := A.NewNdisApi()
	if err != nil {
		return nil, fmt.Errorf("can't open the Windows Packet Filter driver: %w", err)
	}
	if !api.IsDriverLoaded() {
		api.Close()
		return nil, fmt.Errorf("the Windows Packet Filter driver is not installed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Router{
		api:     api,
		rules:   NewRules(c),
		nat:     NewNAT(),
		lookup:  N.NewProcessLookup(),
		self:    uint32(os.Getpid()),
		proxies: map[uint16]*Proxy{},
		tcpOf:   map[uint16]uint16{},
		udpOf:   map[uint16]uint16{},
		isTCP:   map[uint16]bool{},
		isUDP:   map[uint16]bool{},
		ctx:     ctx,
		cancel:  cancel,
	}
	for _, inbound := range r.rules.Ports() {
		p, err := NewProxy(inbound, c.User, c.Password, r.nat)
		if err != nil {
			r.Close()
			return nil, fmt.Errorf("can't open a local proxy: %w", err)
		}
		r.proxies[inbound] = p
		r.tcpOf[inbound], r.udpOf[inbound] = p.TCPPort(), p.UDPPort()
		r.isTCP[p.TCPPort()], r.isUDP[p.UDPPort()] = true, true
	}
	return r, nil
}

// Start begins redirecting, and follows the computer to another network (Wi-Fi to cable...).
func (r *Router) Start() error {
	for _, p := range r.proxies {
		go p.Serve(r.ctx)
	}
	go r.lookup.StartCleanup(r.ctx, 30*time.Second)
	go r.sweep()
	if err := r.attach(); err != nil {
		return err
	}
	h, err := N.NotifyIpInterfaceChange(r.networkChanged, 0, false)
	if err != nil {
		log.Printf("won't follow network changes: %v", err)
	} else {
		r.notify = h
	}
	return nil
}

// attach starts filtering the adapter Windows uses to reach the internet.
func (r *Router) attach() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.filter != nil {
		r.filter.Close()
		r.filter = nil
	}
	adapters, err := r.api.GetTcpipBoundAdaptersInfo()
	if err != nil {
		return err
	}
	info, _, err := N.GetNetworkAdapterInfo(r.api)
	if err != nil || len(info) == 0 {
		return fmt.Errorf("no network adapter found: %v", err)
	}
	best, err := N.GetBestInterface(info, "8.8.8.8")
	if err != nil {
		return fmt.Errorf("no adapter reaches the internet: %w", err)
	}
	filter, err := D.NewQueuedPacketFilter(r.ctx, r.api, adapters, nil, r.outgoing)
	if err != nil {
		return err
	}
	if err := filter.StartFilter(best.AdapterIndex); err != nil {
		return err
	}
	r.filter = filter
	r.ifIndex = best.AdapterIndex
	log.Printf("redirecting on %s", best.Name)
	return nil
}

func (r *Router) networkChanged(_ uintptr, _ *windows.MibIpInterfaceRow, _ N.MibNotificationType) uintptr {
	go func() {
		// Let the new network settle first.
		time.Sleep(time.Second)
		info, _, err := N.GetNetworkAdapterInfo(r.api)
		if err != nil {
			return
		}
		best, err := N.GetBestInterface(info, "8.8.8.8")
		r.mu.Lock()
		same := err == nil && best.AdapterIndex == r.ifIndex && r.filter != nil
		r.mu.Unlock()
		if err != nil || same {
			return
		}
		if err := r.attach(); err != nil {
			log.Printf("couldn't move to the new network: %v", err)
		}
	}()
	return 0
}

func (r *Router) sweep() {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case now := <-t.C:
			r.nat.Sweep(now)
		}
	}
}

// Close stops redirecting; the adapter goes back to normal at once.
func (r *Router) Close() {
	if r.notify != 0 {
		_ = N.CancelMibChangeNotify2(r.notify)
	}
	r.mu.Lock()
	if r.filter != nil {
		r.filter.Close()
		r.filter = nil
	}
	r.mu.Unlock()
	r.cancel()
	r.api.Close()
}

// program is the full path of the program behind a new connection, or "" (also for this one).
func (r *Router) program(udp bool, src, dst netip.AddrPort) string {
	info, err := r.lookup.FindProcessInfo(r.ctx, udp, src, dst, false)
	if err != nil || info.ID == r.self || info.ID == 0 || info.ID == 4 {
		return ""
	}
	return info.PathName
}

// outgoing decides about one packet leaving the computer.
func (r *Router) outgoing(_ A.Handle, b *A.IntermediateBuffer) A.FilterAction {
	f, ok := ParseFrame(b.Buffer[:b.Length])
	if !ok {
		return A.FilterActionPass
	}
	tcp := f.TCP()
	src, dst := f.Src(), f.Dst()

	// A reply from a local proxy to a redirected program: give it the real server's address back.
	if !f.V6() && ((tcp && r.isTCP[f.SrcPort()]) || (!tcp && r.isUDP[f.SrcPort()])) {
		flow := r.nat.Get(tcp, FlowKey{dst, f.DstPort()})
		if flow == nil {
			return A.FilterActionPass
		}
		if tcp && f.Flags()&(tcpFIN|tcpRST) != 0 {
			flow.closed.CompareAndSwap(0, time.Now().Unix())
		}
		f.SetSrcPort(flow.Dst.Port())
		f.Turn()
		f.Seal()
		return A.FilterActionRedirect
	}

	key := FlowKey{dst, f.SrcPort()}
	if flow := r.nat.Get(tcp, key); flow != nil {
		flow.Touch()
		if tcp && f.Flags()&(tcpFIN|tcpRST) != 0 {
			flow.closed.CompareAndSwap(0, time.Now().Unix())
		}
		f.SetDstPort(flow.ProxyPort)
		f.Turn()
		f.Seal()
		return A.FilterActionRedirect
	}

	// Only the start of a connection (or a new UDP destination) is looked at further.
	if tcp && f.Flags()&(tcpSYN|tcpACK) != tcpSYN {
		return A.FilterActionPass
	}
	if Local(dst) {
		return A.FilterActionPass
	}
	path := r.program(!tcp, netip.AddrPortFrom(src, f.SrcPort()), netip.AddrPortFrom(dst, f.DstPort()))
	inbound := r.rules.Port(path)
	if inbound == 0 {
		return A.FilterActionPass
	}
	// The local proxies speak IPv4; a program on the VPN that tries IPv6 is refused, so it falls
	// back to IPv4 instead of going around the VPN.
	if f.V6() {
		return A.FilterActionDrop
	}
	proxyPort := r.tcpOf[inbound]
	if !tcp {
		proxyPort = r.udpOf[inbound]
	}
	flow := r.nat.Add(tcp, key, &Flow{Dst: netip.AddrPortFrom(dst, f.DstPort()), ProxyPort: proxyPort})
	f.SetDstPort(flow.ProxyPort)
	f.Turn()
	f.Seal()
	return A.FilterActionRedirect
}
