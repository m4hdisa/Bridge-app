//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"unsafe"

	A "github.com/wiresock/ndisapi-go"
	"golang.org/x/sys/windows"
)

// internetRoute is the adapter Windows sends internet traffic through.
type internetRoute struct {
	GUID string // "{...}", the name the driver knows it by too
	Name string // as Windows shows it
}

func findInternetRoute() (internetRoute, error) {
	var index uint32
	if err := windows.GetBestInterfaceEx(&windows.SockaddrInet4{Addr: [4]byte{8, 8, 8, 8}}, &index); err != nil {
		return internetRoute{}, err
	}
	size := uint32(16 << 10)
	for {
		buf := make([]byte, size)
		first := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, 0, 0, first, &size)
		if errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) {
			continue
		}
		if err != nil {
			return internetRoute{}, err
		}
		for a := first; a != nil; a = a.Next {
			if a.IfIndex == index {
				return internetRoute{windows.BytePtrToString(a.AdapterName), windows.UTF16PtrToString(a.FriendlyName)}, nil
			}
		}
		return internetRoute{}, fmt.Errorf("Windows did not list adapter %d", index)
	}
}

// driverAdapterName is one name from the driver's list, a "\DEVICE\{GUID}" in a fixed-size field.
func driverAdapterName(field []byte) string {
	if i := bytes.IndexByte(field, 0); i >= 0 {
		field = field[:i]
	}
	return string(field)
}

// matchAdapter is the position in the driver's list of the adapter with this GUID, or -1. By GUID
// and not by the name Windows shows, which depends on the registry and on how it was renamed.
func matchAdapter(list *A.TcpAdapterList, guid string) int {
	for i := 0; i < int(list.AdapterCount); i++ {
		name := driverAdapterName(list.AdapterNameList[i][:])
		if strings.EqualFold(name[strings.LastIndexByte(name, '\\')+1:], guid) {
			return i
		}
	}
	return -1
}

// internetAdapter finds the adapter the internet goes through in the driver's list. Another VPN's
// adapter, a phone modem or a dial-up connection can be missing from it; packets there never pass
// the driver, so the error says what Windows uses and what the driver sees.
func internetAdapter(api *A.NdisApi, list *A.TcpAdapterList) (int, string, error) {
	route, err := findInternetRoute()
	if err != nil {
		return 0, "", fmt.Errorf("Windows has no route to the internet: %w", err)
	}
	if i := matchAdapter(list, route.GUID); i >= 0 {
		return i, route.Name, nil
	}
	seen := make([]string, 0, list.AdapterCount)
	for i := 0; i < int(list.AdapterCount); i++ {
		seen = append(seen, api.ConvertWindows2000AdapterName(driverAdapterName(list.AdapterNameList[i][:])))
	}
	return 0, "", fmt.Errorf("the internet goes through %q, which the driver can't see (it sees: %s)", route.Name, strings.Join(seen, ", "))
}

// CheckRoute says whether redirecting can start on this network, without starting it.
func CheckRoute() error {
	api, err := openDriver()
	if err != nil {
		return err
	}
	defer api.Close()
	adapters, err := api.GetTcpipBoundAdaptersInfo()
	if err != nil {
		return err
	}
	_, _, err = internetAdapter(api, adapters)
	return err
}
