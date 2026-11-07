package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestPayloadRoundTrip(t *testing.T) {
	program := []byte("MZ pretend program")
	installer := bytes.Repeat([]byte("installer "), 1000)
	var file bytes.Buffer
	file.Write(program)
	if err := Append(&file, bytes.NewReader(installer), int64(len(installer)), Meta{Version: "0.6.2", Unpacked: 123}); err != nil {
		t.Fatal(err)
	}
	r := bytes.NewReader(file.Bytes())
	p, err := ReadPayload(r, int64(file.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if p.Meta.Version != "0.6.2" || p.Meta.Unpacked != 123 {
		t.Fatalf("meta: %+v", p.Meta)
	}
	out := filepath.Join(t.TempDir(), "installer.exe")
	if err := p.Extract(r, out); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(out)
	if !bytes.Equal(got, installer) {
		t.Fatal("the installer came out different")
	}
	if _, err := ReadPayload(bytes.NewReader(program), int64(len(program))); err == nil {
		t.Fatal("a plain program has no installer")
	}
}

func TestInstalledFolder(t *testing.T) {
	cases := map[string]string{
		`"C:\Users\me\AppData\Local\Programs\Bridge\Uninstall Bridge.exe" /currentuser`: `C:\Users\me\AppData\Local\Programs\Bridge`,
		`"D:\My Apps\Bridge\Uninstall Bridge.exe" /currentuser /S`:                      `D:\My Apps\Bridge`,
		`"C:\Program Files\Other\uninstall.exe"`:                                        ``,
		``:                                                                              ``,
	}
	for in, want := range cases {
		if got := dirOfUninstaller(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}
