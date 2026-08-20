package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSHandlesAllowedPreflight(t *testing.T) {
	handler := NewCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("preflight should not reach next handler")
	}), []string{"http://localhost:5173", "http://127.0.0.1:5173"})

	request := httptest.NewRequest(http.MethodOptions, "/auth/login", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	request.Header.Set("Access-Control-Request-Headers", "content-type,x-client-id")

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	defer response.Body.Close()

	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d", http.StatusNoContent, response.StatusCode)
	}
	if got := response.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("expected allow origin header, got %q", got)
	}
	if got := response.Header.Get("Access-Control-Allow-Headers"); got != "Accept, Authorization, Content-Type, Idempotency-Key, X-Client-Id, X-Sync-Base-Cursor, X-Sync-Event-Id" {
		t.Fatalf("unexpected allow headers %q", got)
	}
	if got := response.Header.Get("Access-Control-Allow-Methods"); got != "DELETE, GET, OPTIONS, PATCH, POST, PUT" {
		t.Fatalf("unexpected allow methods %q", got)
	}
	if got := response.Header.Get("Access-Control-Expose-Headers"); got != "X-Sync-Cursor, X-Sync-Duplicate, X-Sync-Event-Id" {
		t.Fatalf("unexpected expose headers %q", got)
	}
	if got := response.Header.Values("Vary"); len(got) != 3 {
		t.Fatalf("expected 3 vary headers, got %v", got)
	}
}

func TestCORSAddsHeadersToAllowedRequest(t *testing.T) {
	handler := NewCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}), []string{"http://localhost:5173", "http://127.0.0.1:5173"})

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	request.Header.Set("Origin", "http://127.0.0.1:5173")

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, response.StatusCode)
	}
	if got := response.Header.Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:5173" {
		t.Fatalf("expected allow origin header, got %q", got)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}
	if string(body) != "{\"status\":\"ok\"}\n" {
		t.Fatalf("unexpected response body %q", string(body))
	}
}

func TestCORSDoesNotAllowUnknownOrigin(t *testing.T) {
	nextCalled := false
	handler := NewCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusTeapot)
	}), []string{"http://localhost:5173", "http://127.0.0.1:5173"})

	request := httptest.NewRequest(http.MethodOptions, "/auth/login", nil)
	request.Header.Set("Origin", "http://malicious.example")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	defer response.Body.Close()

	if !nextCalled {
		t.Fatalf("expected disallowed origin to fall through")
	}
	if response.StatusCode != http.StatusTeapot {
		t.Fatalf("expected status %d, got %d", http.StatusTeapot, response.StatusCode)
	}
	if got := response.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no allow origin header, got %q", got)
	}
}
