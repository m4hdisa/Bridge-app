//go:build windows

package main

import "testing"

func TestLibraryLogGivesUpOnlyWhenTheWindowFailed(t *testing.T) {
	for text, want := range map[string]bool{
		"Creating environment failed with 80070005": true,
		"Creating controller failed with 8007139f":  true,
		"Result: 80070002":                          false,
		"invalid RPC message: EOF":                  false,
	} {
		got := ""
		if _, err := (libraryLog{func(r string) { got = r }}).Write([]byte(text + "\n")); err != nil {
			t.Fatal(err)
		}
		if (got != "") != want || (want && got != text) {
			t.Errorf("%q: gave up with %q", text, got)
		}
	}
}
