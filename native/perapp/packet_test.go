package main

import (
	"encoding/binary"
	"net/netip"
	"testing"
)

// checksum sums a TCP or UDP segment with its IPv4 pseudo-header, as a receiver checks it.
func checksum(src, dst [4]byte, proto byte, segment []byte) uint16 {
	var sum uint32
	add := func(b []byte) {
		for i := 0; i+1 < len(b); i += 2 {
			sum += uint32(binary.BigEndian.Uint16(b[i:]))
		}
		if len(b)%2 == 1 {
			sum += uint32(b[len(b)-1]) << 8
		}
	}
	add(src[:])
	add(dst[:])
	sum += uint32(proto) + uint32(len(segment))
	add(segment)
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

func ipv4Frame(proto byte, src, dst [4]byte, sport, dport uint16, flags byte, payload []byte) []byte {
	l4len := 8
	if proto == protoTCP {
		l4len = 20
	}
	b := make([]byte, 14+20+l4len+len(payload))
	copy(b[0:6], []byte{1, 1, 1, 1, 1, 1})
	copy(b[6:12], []byte{2, 2, 2, 2, 2, 2})
	binary.BigEndian.PutUint16(b[12:], 0x0800)
	ip := b[14:]
	ip[0] = 0x45
	binary.BigEndian.PutUint16(ip[2:], uint16(20+l4len+len(payload)))
	ip[8] = 64
	ip[9] = proto
	copy(ip[12:16], src[:])
	copy(ip[16:20], dst[:])
	l4 := ip[20:]
	binary.BigEndian.PutUint16(l4[0:], sport)
	binary.BigEndian.PutUint16(l4[2:], dport)
	if proto == protoTCP {
		l4[12] = 5 << 4
		l4[13] = flags
		copy(l4[20:], payload)
		binary.BigEndian.PutUint16(l4[16:], checksum(src, dst, proto, l4))
	} else {
		binary.BigEndian.PutUint16(l4[4:], uint16(8+len(payload)))
		copy(l4[8:], payload)
		binary.BigEndian.PutUint16(l4[6:], checksum(src, dst, proto, l4))
	}
	return b
}

func TestRedirectKeepsChecksumsValid(t *testing.T) {
	local := [4]byte{192, 168, 1, 20}
	server := [4]byte{149, 154, 167, 51}
	for _, proto := range []byte{protoTCP, protoUDP} {
		b := ipv4Frame(proto, local, server, 50123, 443, tcpSYN, []byte("hello, odd length"))
		f, ok := ParseFrame(b)
		if !ok {
			t.Fatal("not parsed")
		}
		if f.Src() != netip.AddrFrom4(local) || f.Dst() != netip.AddrFrom4(server) || f.SrcPort() != 50123 || f.DstPort() != 443 {
			t.Fatalf("headers read wrong: %v:%d -> %v:%d", f.Src(), f.SrcPort(), f.Dst(), f.DstPort())
		}
		if proto == protoTCP && f.Flags()&tcpSYN == 0 {
			t.Fatal("SYN not seen")
		}
		f.Turn()
		f.SetDstPort(61000)
		f.Seal()
		if f.Src() != netip.AddrFrom4(server) || f.Dst() != netip.AddrFrom4(local) || f.DstPort() != 61000 {
			t.Fatal("not turned around")
		}
		if b[0] != 2 || b[6] != 1 {
			t.Fatal("MACs not swapped")
		}
		if got := checksum(server, local, proto, b[34:]); got != 0 {
			t.Fatalf("proto %d: checksum doesn't verify after the change (%#x)", proto, got)
		}
	}
}

// The network card usually fills in the checksums of outgoing packets, so the filter sees blanks.
func TestSealFillsChecksumsLeftToTheCard(t *testing.T) {
	local := [4]byte{10, 0, 0, 2}
	server := [4]byte{8, 8, 8, 8}
	for _, proto := range []byte{protoTCP, protoUDP} {
		b := ipv4Frame(proto, local, server, 5000, 53, tcpSYN, []byte("query"))
		binary.BigEndian.PutUint16(b[14+10:], 0)
		at := 34 + 16
		if proto == protoUDP {
			at = 34 + 6
		}
		binary.BigEndian.PutUint16(b[at:], 0x1234)
		// Ethernet pads short frames; the padding is not part of the packet.
		b = append(b, 0, 0, 0, 0, 0, 0)
		f, _ := ParseFrame(b)
		f.Turn()
		f.SetDstPort(1234)
		f.Seal()
		if fold(sum(b[14:34], 0)) != 0 {
			t.Fatalf("proto %d: IP header checksum wrong", proto)
		}
		if got := checksum(server, local, proto, b[34:len(b)-6]); got != 0 {
			t.Fatalf("proto %d: checksum wrong (%#x)", proto, got)
		}
	}
}

func TestOnlyFirstFragmentsAndKnownProtocols(t *testing.T) {
	b := ipv4Frame(protoUDP, [4]byte{10, 0, 0, 2}, [4]byte{8, 8, 8, 8}, 5000, 53, 0, nil)
	binary.BigEndian.PutUint16(b[14+6:], 10) // fragment offset
	if _, ok := ParseFrame(b); ok {
		t.Fatal("a later fragment has no ports")
	}
	icmp := ipv4Frame(protoUDP, [4]byte{10, 0, 0, 2}, [4]byte{8, 8, 8, 8}, 1, 1, 0, nil)
	icmp[14+9] = 1
	if _, ok := ParseFrame(icmp); ok {
		t.Fatal("ICMP is not handled")
	}
}

func TestLocalAddresses(t *testing.T) {
	for _, s := range []string{"192.168.1.1", "10.10.34.35", "127.0.0.1", "169.254.1.1", "224.0.0.251", "255.255.255.255", "100.64.0.1", "fe80::1", "fd00::1"} {
		if !Local(netip.MustParseAddr(s)) {
			t.Errorf("%s should be local", s)
		}
	}
	for _, s := range []string{"1.1.1.1", "149.154.167.51", "2001:4860:4860::8888"} {
		if Local(netip.MustParseAddr(s)) {
			t.Errorf("%s should not be local", s)
		}
	}
}
