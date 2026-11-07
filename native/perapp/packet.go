package main

import (
	"encoding/binary"
	"net/netip"
)

// Frame is an Ethernet frame carrying TCP or UDP over IPv4 or IPv6, read in place: every outgoing
// packet on the adapter passes through here, so nothing is copied or decoded beyond the headers.
type Frame struct {
	b     []byte
	ip    int // where the IP header starts
	l4    int // where the TCP or UDP header starts
	v6    bool
	proto byte
}

const (
	protoTCP = 6
	protoUDP = 17

	tcpFIN = 0x01
	tcpSYN = 0x02
	tcpRST = 0x04
	tcpACK = 0x10
)

// ParseFrame reads the headers of a frame, or says it isn't TCP or UDP Bridge can handle.
func ParseFrame(b []byte) (Frame, bool) {
	if len(b) < 14 {
		return Frame{}, false
	}
	off := 12
	etherType := binary.BigEndian.Uint16(b[off:])
	// An 802.1Q tag, when the adapter leaves it in the frame.
	if etherType == 0x8100 {
		if len(b) < 18 {
			return Frame{}, false
		}
		off += 4
		etherType = binary.BigEndian.Uint16(b[off:])
	}
	ip := off + 2
	f := Frame{b: b, ip: ip}
	switch etherType {
	case 0x0800:
		if len(b) < ip+20 || b[ip]>>4 != 4 {
			return Frame{}, false
		}
		ihl := int(b[ip]&0x0f) * 4
		// Only the first fragment carries the ports.
		if ihl < 20 || binary.BigEndian.Uint16(b[ip+6:])&0x1fff != 0 {
			return Frame{}, false
		}
		f.proto = b[ip+9]
		f.l4 = ip + ihl
	case 0x86dd:
		if len(b) < ip+40 || b[ip]>>4 != 6 {
			return Frame{}, false
		}
		// Extension headers are rare for TCP and UDP; such packets just pass.
		f.v6 = true
		f.proto = b[ip+6]
		f.l4 = ip + 40
	default:
		return Frame{}, false
	}
	switch f.proto {
	case protoTCP:
		if len(b) < f.l4+20 {
			return Frame{}, false
		}
	case protoUDP:
		if len(b) < f.l4+8 {
			return Frame{}, false
		}
	default:
		return Frame{}, false
	}
	return f, true
}

func (f Frame) TCP() bool { return f.proto == protoTCP }
func (f Frame) V6() bool  { return f.v6 }

func (f Frame) Src() netip.Addr {
	if f.v6 {
		return netip.AddrFrom16([16]byte(f.b[f.ip+8 : f.ip+24]))
	}
	return netip.AddrFrom4([4]byte(f.b[f.ip+12 : f.ip+16]))
}

func (f Frame) Dst() netip.Addr {
	if f.v6 {
		return netip.AddrFrom16([16]byte(f.b[f.ip+24 : f.ip+40]))
	}
	return netip.AddrFrom4([4]byte(f.b[f.ip+16 : f.ip+20]))
}

func (f Frame) SrcPort() uint16 { return binary.BigEndian.Uint16(f.b[f.l4:]) }
func (f Frame) DstPort() uint16 { return binary.BigEndian.Uint16(f.b[f.l4+2:]) }

// Flags are the TCP flags (0 for UDP).
func (f Frame) Flags() byte {
	if f.proto != protoTCP {
		return 0
	}
	return f.b[f.l4+13]
}

// Turn sends the frame back the way it came: Ethernet and IP addresses swapped, so the stack
// takes it as a packet arriving from the other end. Call Seal after the last change.
func (f Frame) Turn() {
	var mac [6]byte
	copy(mac[:], f.b[0:6])
	copy(f.b[0:6], f.b[6:12])
	copy(f.b[6:12], mac[:])
	size := 4
	src := f.ip + 12
	if f.v6 {
		size = 16
		src = f.ip + 8
	}
	dst := src + size
	var tmp [16]byte
	copy(tmp[:size], f.b[src:src+size])
	copy(f.b[src:src+size], f.b[dst:dst+size])
	copy(f.b[dst:dst+size], tmp[:size])
}

func (f Frame) SetSrcPort(p uint16) { binary.BigEndian.PutUint16(f.b[f.l4:], p) }
func (f Frame) SetDstPort(p uint16) { binary.BigEndian.PutUint16(f.b[f.l4+2:], p) }

// Seal writes the IPv4 header checksum and the TCP or UDP checksum from scratch. A packet on its
// way out often has no real checksums yet (the network card fills them in), but one handed back
// to the stack as received must have them, or Windows drops it. Only redirected packets pay this.
func (f Frame) Seal() {
	if f.v6 {
		return
	}
	ihl := int(f.b[f.ip]&0x0f) * 4
	total := int(binary.BigEndian.Uint16(f.b[f.ip+2:]))
	if total < ihl || f.ip+total > len(f.b) {
		total = len(f.b) - f.ip
	}
	binary.BigEndian.PutUint16(f.b[f.ip+10:], 0)
	binary.BigEndian.PutUint16(f.b[f.ip+10:], fold(sum(f.b[f.ip:f.ip+ihl], 0)))
	segment := f.b[f.l4 : f.ip+total]
	at := 16
	if f.proto == protoUDP {
		at = 6
	}
	binary.BigEndian.PutUint16(segment[at:], 0)
	pseudo := sum(f.b[f.ip+12:f.ip+20], 0) + uint32(f.proto) + uint32(len(segment))
	c := fold(sum(segment, pseudo))
	// In UDP a sum of 0 is sent as all ones; 0 means "no checksum".
	if c == 0 && f.proto == protoUDP {
		c = 0xffff
	}
	binary.BigEndian.PutUint16(segment[at:], c)
}

func sum(b []byte, start uint32) uint32 {
	s := start
	n := len(b) &^ 1
	for i := 0; i < n; i += 2 {
		s += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)&1 == 1 {
		s += uint32(b[len(b)-1]) << 8
	}
	return s
}

func fold(s uint32) uint16 {
	for s>>16 != 0 {
		s = (s & 0xffff) + (s >> 16)
	}
	return ^uint16(s)
}

// Local says an address never needs the VPN: the LAN, this computer, link-local, multicast.
func Local(a netip.Addr) bool {
	return a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() || a.IsMulticast() || a.IsUnspecified() ||
		a == netip.AddrFrom4([4]byte{255, 255, 255, 255}) ||
		// 100.64.0.0/10, the carrier-grade NAT range some ISPs use for their own services.
		(a.Is4() && a.As4()[0] == 100 && a.As4()[1]&0xc0 == 64)
}
