package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

// Bridge Setup is this program with Bridge's own installer (electron-builder's, which also does
// the updates) appended to it, then a small description and a trailer:
//
//	[setup.exe][installer][meta JSON][meta length: 8][installer length: 8]["BRSETUP1"]
//
// scripts/build-setup.mjs writes it; Windows runs the exe part and ignores the rest.
const magic = "BRSETUP1"

// Meta describes the appended installer.
type Meta struct {
	Version string `json:"version"`
	// The size of an installed Bridge, to show how far copying has got.
	Unpacked int64 `json:"unpacked"`
}

// Payload is where the installer sits inside a file.
type Payload struct {
	Meta   Meta
	offset int64
	size   int64
}

func ReadPayload(f io.ReaderAt, fileSize int64) (*Payload, error) {
	if fileSize < 24 {
		return nil, errors.New("no installer inside")
	}
	tail := make([]byte, 24)
	if _, err := f.ReadAt(tail, fileSize-24); err != nil {
		return nil, err
	}
	if string(tail[16:]) != magic {
		return nil, errors.New("no installer inside")
	}
	metaLen := int64(binary.LittleEndian.Uint64(tail[0:8]))
	size := int64(binary.LittleEndian.Uint64(tail[8:16]))
	metaAt := fileSize - 24 - metaLen
	offset := metaAt - size
	if metaLen <= 0 || size <= 0 || offset < 0 {
		return nil, errors.New("the installer inside is damaged")
	}
	raw := make([]byte, metaLen)
	if _, err := f.ReadAt(raw, metaAt); err != nil {
		return nil, err
	}
	p := &Payload{offset: offset, size: size}
	if err := json.Unmarshal(raw, &p.Meta); err != nil {
		return nil, err
	}
	return p, nil
}

// Extract copies the installer out to a file of its own.
func (p *Payload) Extract(f io.ReaderAt, to string) error {
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, io.NewSectionReader(f, p.offset, p.size)); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// dirOfUninstaller is Bridge's folder from its uninstall command, `"<dir>\Uninstall Bridge.exe" /currentuser`
// (electron-builder leaves InstallLocation empty), or "" for anything else.
func dirOfUninstaller(command string) string {
	const exe = `\Uninstall Bridge.exe`
	path := strings.TrimPrefix(command, `"`)
	at := strings.Index(path, exe)
	if at <= 0 {
		return ""
	}
	return path[:at]
}

// Append writes what Bridge Setup carries after the program (used by the build and the tests).
func Append(w io.Writer, installer io.Reader, size int64, meta Meta) error {
	if _, err := io.CopyN(w, installer, size); err != nil {
		return err
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	tail := make([]byte, 24)
	binary.LittleEndian.PutUint64(tail[0:8], uint64(len(raw)))
	binary.LittleEndian.PutUint64(tail[8:16], uint64(size))
	copy(tail[16:], magic)
	if _, err := w.Write(raw); err != nil {
		return err
	}
	_, err = w.Write(tail)
	return err
}
