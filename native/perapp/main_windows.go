//go:build windows

// bridge-perapp sends only the chosen programs' connections to Bridge, like Proxifier: the rest of
// the computer keeps its own route, so connecting or disconnecting never drops a game that isn't
// on the VPN. It needs the Windows Packet Filter driver, which Bridge's installer adds.
//
//	bridge-perapp -config <file> -parent <pid>
//
// Prints "ready" once it redirects, and stops when Bridge exits or closes its input.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	A "github.com/wiresock/ndisapi-go"
	"golang.org/x/sys/windows"
)

func main() {
	config := flag.String("config", "", "the rules Bridge wrote")
	parent := flag.Int("parent", 0, "stop when this process (Bridge) exits")
	check := flag.Bool("check", false, "only say whether the driver is installed")
	flag.Parse()
	log.SetFlags(0)
	log.SetOutput(os.Stdout)

	if *check {
		api, err := A.NewNdisApi()
		if err != nil || !api.IsDriverLoaded() {
			fmt.Println("missing")
			os.Exit(1)
		}
		api.Close()
		fmt.Println("installed")
		return
	}

	c, err := LoadConfig(*config)
	if err != nil {
		log.Fatalf("can't read the rules: %v", err)
	}
	r, err := NewRouter(c)
	if err != nil {
		log.Fatal(err)
	}
	if err := r.Start(); err != nil {
		r.Close()
		log.Fatal(err)
	}
	fmt.Println("ready")

	stop := make(chan string, 3)
	go func() {
		s := make(chan os.Signal, 1)
		signal.Notify(s, os.Interrupt, syscall.SIGTERM)
		<-s
		stop <- "asked to stop"
	}()
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop <- "Bridge closed the connection"
	}()
	if *parent > 0 {
		go func() {
			h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(*parent))
			if err != nil {
				stop <- "Bridge is gone"
				return
			}
			_, _ = windows.WaitForSingleObject(h, windows.INFINITE)
			stop <- "Bridge exited"
		}()
	}
	why := <-stop
	r.Close()
	log.Printf("stopped (%s)", why)
}
