//go:build windows

package main

import (
	"strings"
	"testing"

	A "github.com/wiresock/ndisapi-go"
)

func adapterList(names ...string) *A.TcpAdapterList {
	l := &A.TcpAdapterList{AdapterCount: uint32(len(names))}
	for i, n := range names {
		copy(l.AdapterNameList[i][:], n)
	}
	return l
}

func TestMatchAdapter(t *testing.T) {
	wifi := `{AAAAAAAA-1111-2222-3333-444444444444}`
	list := adapterList(`\DEVICE\NDISWANIP`, `\DEVICE\{BBBBBBBB-1111-2222-3333-444444444444}`, `\DEVICE\`+wifi)
	if got := matchAdapter(list, wifi); got != 2 {
		t.Fatalf("exact GUID: got %d", got)
	}
	if got := matchAdapter(list, strings.ToLower(wifi)); got != 2 {
		t.Fatalf("lower-case GUID: got %d", got)
	}
	if got := matchAdapter(list, `{CCCCCCCC-1111-2222-3333-444444444444}`); got != -1 {
		t.Fatalf("an adapter the driver doesn't see: got %d", got)
	}
	if got := matchAdapter(adapterList(), wifi); got != -1 {
		t.Fatalf("empty list: got %d", got)
	}
}

// Only reads Windows' route table.
func TestFindInternetRoute(t *testing.T) {
	r, err := findInternetRoute()
	if err != nil {
		t.Skipf("no route on this computer: %v", err)
	}
	if !strings.HasPrefix(r.GUID, "{") || r.Name == "" {
		t.Fatalf("unexpected adapter: %+v", r)
	}
	t.Logf("internet goes through %q %s", r.Name, r.GUID)
}
