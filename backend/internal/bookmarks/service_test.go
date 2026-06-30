package bookmarks

import (
	"encoding/json"
	"testing"
)

func TestValidateURL(t *testing.T) {
	tests := []struct {
		name    string
		rawURL  string
		wantErr bool
	}{
		{name: "accepts https", rawURL: "https://example.com/docs"},
		{name: "accepts http", rawURL: "http://example.com/docs"},
		{name: "rejects missing host", rawURL: "https:///docs", wantErr: true},
		{name: "rejects unsupported scheme", rawURL: "ftp://example.com/file", wantErr: true},
		{name: "rejects malformed URL", rawURL: "://bad-url", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateURL(tt.rawURL)
			if tt.wantErr && err == nil {
				t.Fatalf("expected error for %q", tt.rawURL)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected no error for %q, got %v", tt.rawURL, err)
			}
		})
	}
}

func TestOptionalStringUnmarshalJSON(t *testing.T) {
	tests := []struct {
		name      string
		payload   string
		wantSet   bool
		wantNil   bool
		wantValue string
		wantErr   bool
	}{
		{name: "null clears value", payload: `null`, wantSet: true, wantNil: true},
		{name: "string gets trimmed", payload: `"  Team Space  "`, wantSet: true, wantValue: "Team Space"},
		{name: "invalid type errors", payload: `123`, wantSet: true, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var value OptionalString
			err := json.Unmarshal([]byte(tt.payload), &value)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for payload %s", tt.payload)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if value.Set != tt.wantSet {
				t.Fatalf("expected Set=%t, got %t", tt.wantSet, value.Set)
			}
			if tt.wantNil {
				if value.Value != nil {
					t.Fatalf("expected nil value, got %q", *value.Value)
				}
				return
			}
			if value.Value == nil || *value.Value != tt.wantValue {
				got := "<nil>"
				if value.Value != nil {
					got = *value.Value
				}
				t.Fatalf("expected value %q, got %s", tt.wantValue, got)
			}
		})
	}
}
