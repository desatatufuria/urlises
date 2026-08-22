package activity

import (
	"testing"
	"time"
)

func TestCursorRoundTrip(t *testing.T) {
	t.Parallel()

	createdAt := time.Date(2026, 3, 15, 10, 30, 0, 123456789, time.UTC)
	id := "3f6a2c9e-1b4d-4e2a-8f3a-9c1d2e3f4a5b"

	encoded := encodeCursor(createdAt, id)
	if encoded == "" {
		t.Fatal("encodeCursor returned empty string")
	}

	gotCreatedAt, gotID, err := decodeCursor(encoded)
	if err != nil {
		t.Fatalf("decodeCursor: %v", err)
	}
	if !gotCreatedAt.Equal(createdAt) {
		t.Fatalf("decoded createdAt = %v, want %v", gotCreatedAt, createdAt)
	}
	if gotID != id {
		t.Fatalf("decoded id = %q, want %q", gotID, id)
	}
}

func TestCursorRoundTripDifferentValues(t *testing.T) {
	t.Parallel()

	createdAt := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	id := "00000000-0000-0000-0000-000000000000"

	encoded := encodeCursor(createdAt, id)
	gotCreatedAt, gotID, err := decodeCursor(encoded)
	if err != nil {
		t.Fatalf("decodeCursor: %v", err)
	}
	if !gotCreatedAt.Equal(createdAt) {
		t.Fatalf("decoded createdAt = %v, want %v", gotCreatedAt, createdAt)
	}
	if gotID != id {
		t.Fatalf("decoded id = %q, want %q", gotID, id)
	}
}

func TestDecodeCursorMalformedReturnsErrorNotPanic(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		cursor string
	}{
		{"not base64", "!!!not-base64!!!"},
		{"base64 but no separator", "aGVsbG8gd29ybGQ"},
		{"base64 with unparsable timestamp", "bm90LWEtdGltZXN0YW1wfGlk"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, _, err := decodeCursor(tc.cursor)
			if err == nil {
				t.Fatalf("decodeCursor(%q) returned nil error, want a clear error", tc.cursor)
			}
		})
	}
}
