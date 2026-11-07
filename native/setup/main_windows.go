//go:build windows

// Bridge Setup: Bridge's installer in the app's own look. The window is a page (ui/index.html) in
// Windows' WebView2; the installing itself is done by the electron-builder installer carried
// inside (see payload.go), run silently, so updates keep working exactly as before. Without
// WebView2, or when started silently (/S, as updates do), that installer simply runs on its own.
package main

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed ui/index.html
var page string

//go:embed ui/fonts/Geist-Variable.woff2
var geist []byte

//go:embed ui/fonts/Vazirmatn-Regular.ttf
var vazirRegular []byte

//go:embed ui/fonts/Vazirmatn-Bold.ttf
var vazirBold []byte

// The window's size in the page's pixels; scaled to the screen.
const width, height = 440, 600

var (
	user32  = windows.NewLazySystemDLL("user32.dll")
	shell32 = windows.NewLazySystemDLL("shell32.dll")
	dwmapi  = windows.NewLazySystemDLL("dwmapi.dll")
	kernel  = windows.NewLazySystemDLL("kernel32.dll")
)

func init() {
	// The window and WebView2 must stay on the thread that made them.
	runtime.LockOSThread()
}

func main() {
	logf("Bridge Setup started: %v", os.Args[1:])
	self, err := os.Executable()
	if err != nil {
		fail(err)
	}
	f, err := os.Open(self)
	if err != nil {
		fail(err)
	}
	stat, _ := f.Stat()
	payload, err := ReadPayload(f, stat.Size())
	if err != nil {
		fail(err)
	}
	work, err := os.MkdirTemp("", "bridge-setup-")
	if err != nil {
		fail(err)
	}
	defer os.RemoveAll(work)
	installer := filepath.Join(work, "Bridge-Installer.exe")

	// Started silently (an update, or someone scripting it): the inner installer does it all.
	for _, a := range os.Args[1:] {
		if strings.EqualFold(a, "/S") || a == "--updated" {
			if err := payload.Extract(f, installer); err != nil {
				fail(err)
			}
			os.Exit(run(installer, strings.Join(quoteAll(os.Args[1:]), " ")))
		}
	}

	setDpiAware()
	scale := float64(dpi()) / 96
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  filepath.Join(work, "webview"),
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "Bridge Setup",
			Width:  uint(width * scale),
			Height: uint(height * scale),
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		// No WebView2 on this PC: the classic installer, with its own pages.
		logf("WebView2 is not available; running the classic installer")
		if err := payload.Extract(f, installer); err != nil {
			fail(err)
		}
		os.Exit(run(installer, ""))
	}
	defer w.Destroy()
	hwnd := uintptr(w.Window())
	frameless(hwnd)

	s := &setup{w: w, hwnd: hwnd, payload: payload, file: f, installer: installer}
	must(w.Bind("setupInfo", s.info))
	must(w.Bind("setupChooseFolder", s.chooseFolder))
	must(w.Bind("setupInstall", s.install))
	must(w.Bind("setupOpen", s.open))
	must(w.Bind("setupDrag", s.drag))
	must(w.Bind("setupMinimize", func() { showWindow(hwnd, 6) }))
	must(w.Bind("setupClose", s.close))
	w.SetHtml(html())
	w.Run()
}

func html() string {
	data := func(b []byte, kind string) string {
		return "data:" + kind + ";base64," + base64.StdEncoding.EncodeToString(b)
	}
	return strings.NewReplacer(
		"{{GEIST}}", data(geist, "font/woff2"),
		"{{VAZIR_REGULAR}}", data(vazirRegular, "font/ttf"),
		"{{VAZIR_BOLD}}", data(vazirBold, "font/ttf"),
	).Replace(page)
}

type setup struct {
	w         webview2.WebView
	hwnd      uintptr
	payload   *Payload
	file      *os.File
	installer string

	mu      sync.Mutex
	busy    bool
	dir     string
	updated bool
}

type info struct {
	Version         string `json:"version"`
	Lang            string `json:"lang"`
	Dir             string `json:"dir"`
	Existing        string `json:"existing"`
	DriverInstalled bool   `json:"driverInstalled"`
}

func (s *setup) info() info {
	dir, version := installed()
	if dir == "" {
		dir = filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Bridge")
	}
	lang := "en"
	// Persian Windows (LANG_PERSIAN), or a Persian keyboard as the first one.
	if id, _, _ := kernel.NewProc("GetUserDefaultUILanguage").Call(); id&0x3ff == 0x29 {
		lang = "fa"
	}
	_, err := os.Stat(filepath.Join(os.Getenv("SystemRoot"), "System32", "drivers", "ndisrd.sys"))
	return info{Version: s.payload.Meta.Version, Lang: lang, Dir: dir, Existing: version, DriverInstalled: err == nil}
}

// installed is where Bridge already is, from the entry its installer leaves for Windows' app list.
func installed() (dir, version string) {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Uninstall`, registry.READ)
	if err != nil {
		return "", ""
	}
	defer k.Close()
	names, _ := k.ReadSubKeyNames(-1)
	for _, n := range names {
		sub, err := registry.OpenKey(k, n, registry.READ)
		if err != nil {
			continue
		}
		name, _, _ := sub.GetStringValue("DisplayName")
		uninstall, _, _ := sub.GetStringValue("UninstallString")
		v, _, _ := sub.GetStringValue("DisplayVersion")
		sub.Close()
		if location := dirOfUninstaller(uninstall); strings.HasPrefix(name, "Bridge ") && location != "" {
			return location, v
		}
	}
	return "", ""
}

func (s *setup) chooseFolder(current string) string {
	picked := pickFolder(s.hwnd)
	if picked == "" {
		return ""
	}
	if !strings.EqualFold(filepath.Base(picked), "Bridge") {
		picked = filepath.Join(picked, "Bridge")
	}
	return picked
}

type options struct {
	Dir      string `json:"dir"`
	Driver   bool   `json:"driver"`
	Shortcut bool   `json:"shortcut"`
}

type result struct {
	OK           bool   `json:"ok"`
	DriverFailed bool   `json:"driverFailed"`
	Error        string `json:"error,omitempty"`
}

func (s *setup) install(o options) {
	s.mu.Lock()
	if s.busy {
		s.mu.Unlock()
		return
	}
	s.busy = true
	s.dir = o.Dir
	s.mu.Unlock()
	go func() {
		r := s.work(o)
		s.mu.Lock()
		s.busy = false
		s.mu.Unlock()
		logf("finished: %+v", r)
		s.eval("onFinished(%s)", r)
	}()
}

func (s *setup) work(o options) result {
	progress := func(step string, f float64) { s.eval("onProgress(%s, %s)", step, f) }
	progress("files", 0.02)
	if err := s.payload.Extract(s.file, s.installer); err != nil {
		return result{Error: err.Error()}
	}
	desktop, _ := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0)
	link := filepath.Join(desktop, "Bridge.lnk")
	_, statErr := os.Stat(link)
	hadLink := statErr == nil

	// Copying: the folder grows toward the size of an installed Bridge.
	done := make(chan int, 1)
	go func() { done <- run(s.installer, "/S /D="+o.Dir) }()
	steps := 0.75
	if !o.Driver {
		steps = 0.92
	}
	var code int
	tick := time.NewTicker(250 * time.Millisecond)
	shown := 0.02
wait:
	for {
		select {
		case code = <-done:
			break wait
		case <-tick.C:
			if s.payload.Meta.Unpacked > 0 {
				f := float64(dirSize(o.Dir)) / float64(s.payload.Meta.Unpacked)
				if f = min(f, 0.98) * steps; f > shown {
					shown = f
					progress("files", shown)
				}
			}
		}
	}
	tick.Stop()
	if code != 0 {
		return result{Error: fmt.Sprintf("The installer stopped with code %d. Details: %s", code, logPath())}
	}
	if _, err := os.Stat(filepath.Join(o.Dir, "Bridge.exe")); err != nil {
		return result{Error: "Bridge.exe is missing after installing. Details: " + logPath()}
	}
	r := result{OK: true}
	if o.Driver {
		progress("driver", steps)
		script := filepath.Join(o.Dir, "resources", "perapp", "install-driver.ps1")
		ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		c, err := runElevated(ps, fmt.Sprintf(`-NoProfile -ExecutionPolicy Bypass -File "%s"`, script))
		logf("driver: code %d, %v", c, err)
		// 3010: installed, Windows finishes it at the next restart.
		if err != nil || (c != 0 && c != 3010) {
			r.DriverFailed = true
		}
	}
	progress("shortcut", 0.97)
	if !o.Shortcut && !hadLink {
		_ = os.Remove(link)
	}
	progress("done", 1)
	return r
}

func (s *setup) open() {
	s.mu.Lock()
	dir := s.dir
	s.mu.Unlock()
	c := exec.Command(filepath.Join(dir, "Bridge.exe"))
	c.Dir = dir
	_ = c.Start()
	s.w.Terminate()
}

func (s *setup) close() {
	s.mu.Lock()
	busy := s.busy
	s.mu.Unlock()
	// Closing halfway would leave Bridge half installed.
	if !busy {
		s.w.Terminate()
	}
}

func (s *setup) drag() {
	user32.NewProc("ReleaseCapture").Call()
	// WM_NCLBUTTONDOWN on the caption: Windows moves the window as the mouse moves.
	user32.NewProc("SendMessageW").Call(s.hwnd, 0x00A1, 2, 0)
}

// eval calls a page function with JSON arguments, from any goroutine.
func (s *setup) eval(format string, args ...any) {
	parts := make([]any, len(args))
	for i, a := range args {
		b, _ := json.Marshal(a)
		parts[i] = string(b)
	}
	js := fmt.Sprintf(format, parts...)
	s.w.Dispatch(func() { s.w.Eval(js) })
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if i, err := d.Info(); err == nil {
				n += i.Size()
			}
		}
		return nil
	})
	return n
}

// run starts the inner installer with a raw command line (NSIS needs /D= unquoted and last) and
// waits for it.
func run(exe, args string) int {
	c := exec.Command(exe)
	c.SysProcAttr = &syscall.SysProcAttr{CmdLine: fmt.Sprintf(`"%s" %s`, exe, args)}
	if err := c.Run(); err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			return e.ExitCode()
		}
		logf("running the installer: %v", err)
		return 1
	}
	return 0
}

func quoteAll(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		if strings.HasPrefix(a, "/D=") || !strings.ContainsAny(a, " \t") {
			out[i] = a
		} else {
			out[i] = `"` + a + `"`
		}
	}
	return out
}

// shellExecuteInfo is SHELLEXECUTEINFOW.
type shellExecuteInfo struct {
	size       uint32
	mask       uint32
	hwnd       uintptr
	verb       *uint16
	file       *uint16
	parameters *uint16
	directory  *uint16
	show       int32
	instApp    uintptr
	idList     uintptr
	class      *uint16
	keyClass   uintptr
	hotKey     uint32
	icon       uintptr
	process    windows.Handle
}

// runElevated runs a program as administrator (Windows asks first) and waits for it.
func runElevated(exe, args string) (int, error) {
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString(args)
	info := &shellExecuteInfo{
		mask:       0x00000040, // SEE_MASK_NOCLOSEPROCESS
		verb:       verb,
		file:       file,
		parameters: params,
		show:       windows.SW_HIDE,
	}
	info.size = uint32(unsafe.Sizeof(*info))
	if ok, _, err := shell32.NewProc("ShellExecuteExW").Call(uintptr(unsafe.Pointer(info))); ok == 0 {
		return 0, err
	}
	defer windows.CloseHandle(info.process)
	_, _ = windows.WaitForSingleObject(info.process, windows.INFINITE)
	var code uint32
	_ = windows.GetExitCodeProcess(info.process, &code)
	return int(code), nil
}

// pickFolder shows Windows' folder picker.
func pickFolder(owner uintptr) string {
	type browseInfo struct {
		Owner       uintptr
		Root        uintptr
		DisplayName *uint16
		Title       *uint16
		Flags       uint32
		Callback    uintptr
		Param       uintptr
		Image       int32
	}
	name := make([]uint16, windows.MAX_PATH)
	title, _ := windows.UTF16PtrFromString("Bridge")
	bi := browseInfo{Owner: owner, DisplayName: &name[0], Title: title, Flags: 0x0001 | 0x0040} // BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
	pidl, _, _ := shell32.NewProc("SHBrowseForFolderW").Call(uintptr(unsafe.Pointer(&bi)))
	if pidl == 0 {
		return ""
	}
	defer windows.NewLazySystemDLL("ole32.dll").NewProc("CoTaskMemFree").Call(pidl)
	path := make([]uint16, windows.MAX_PATH)
	if ok, _, _ := shell32.NewProc("SHGetPathFromIDListW").Call(pidl, uintptr(unsafe.Pointer(&path[0]))); ok == 0 {
		return ""
	}
	return windows.UTF16ToString(path)
}

func setDpiAware() {
	// Per-monitor v2 (Windows 10 1703 and later), else the system's scale.
	if p := user32.NewProc("SetProcessDpiAwarenessContext"); p.Find() == nil {
		if ok, _, _ := p.Call(^uintptr(3)); ok != 0 {
			return
		}
	}
	user32.NewProc("SetProcessDPIAware").Call()
}

func dpi() uint32 {
	if p := user32.NewProc("GetDpiForSystem"); p.Find() == nil {
		if d, _, _ := p.Call(); d != 0 {
			return uint32(d)
		}
	}
	return 96
}

// frameless takes the title bar and border off (the page draws its own), with Windows 11's
// rounded corners and shadow.
func frameless(hwnd uintptr) {
	const (
		gwlStyle       = ^uintptr(15) // -16
		wsPopup        = 0x80000000
		wsVisible      = 0x10000000
		wsSysMenu      = 0x00080000
		wsMinimizeBox  = 0x00020000
		swpFrame       = 0x0020
		swpNoMove      = 0x0002
		swpNoSize      = 0x0001
		swpNoZOrder    = 0x0004
		cornerPrefAttr = 33
	)
	user32.NewProc("SetWindowLongPtrW").Call(hwnd, gwlStyle, wsPopup|wsVisible|wsSysMenu|wsMinimizeBox)
	user32.NewProc("SetWindowPos").Call(hwnd, 0, 0, 0, 0, 0, swpFrame|swpNoMove|swpNoSize|swpNoZOrder)
	round := uint32(2) // DWMWCP_ROUND
	dwmapi.NewProc("DwmSetWindowAttribute").Call(hwnd, cornerPrefAttr, uintptr(unsafe.Pointer(&round)), 4)
}

func showWindow(hwnd uintptr, cmd uintptr) { user32.NewProc("ShowWindow").Call(hwnd, cmd) }

func logPath() string { return filepath.Join(os.TempDir(), "bridge-setup.log") }

func logf(format string, args ...any) {
	f, err := os.OpenFile(logPath(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

func must(err error) {
	if err != nil {
		fail(err)
	}
}

// fail shows a plain Windows message, since there may be no window to show it in.
func fail(err error) {
	logf("failed: %v", err)
	text, _ := windows.UTF16PtrFromString("Bridge Setup could not start: " + err.Error())
	title, _ := windows.UTF16PtrFromString("Bridge Setup")
	windows.MessageBox(0, text, title, windows.MB_ICONERROR)
	os.Exit(1)
}
