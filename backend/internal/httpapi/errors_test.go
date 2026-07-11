package httpapi

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUnexpectedFailureIsSanitizedAndObservable(t *testing.T) {
	const (
		requestID = "123e4567-e89b-42d3-a456-426614174000"
		secret    = "Bearer top-secret-token"
		cookie    = "session=private-cookie"
		body      = "password=never-log"
		query     = "replay-payload=unsafe"
		dbError   = "pq: SELECT private_token FROM users"
	)
	var logs bytes.Buffer
	handler := NewErrorMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, http.StatusInternalServerError, dbError)
	}), &logs)

	req := httptest.NewRequest(http.MethodPost, "/organizations?"+query, strings.NewReader(body))
	req.Header.Set("Authorization", secret)
	req.Header.Set("Cookie", cookie)
	req.Header.Set("X-Request-ID", requestID)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d", res.Code)
	}
	if got := res.Header().Get("X-Request-ID"); got != requestID {
		t.Fatalf("request ID=%q", got)
	}
	if !strings.Contains(res.Body.String(), `"error":"internal server error"`) {
		t.Fatalf("unsafe response=%q", res.Body.String())
	}
	if count := strings.Count(logs.String(), "http_request_failed"); count != 1 {
		t.Fatalf("failure events=%d logs=%q", count, logs.String())
	}
	for _, value := range []string{secret, cookie, body, query, dbError, "top-secret-token", "private-cookie"} {
		if strings.Contains(res.Body.String(), value) || strings.Contains(logs.String(), value) {
			t.Fatalf("sensitive value %q leaked: response=%q logs=%q", value, res.Body.String(), logs.String())
		}
	}
}

func TestErrorMiddlewareRecoversPanicsWithoutRewritingCommittedResponses(t *testing.T) {
	for _, tc := range []struct {
		name       string
		handler    http.Handler
		wantStatus int
		wantBody   string
	}{
		{name: "before commit", handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("secret panic") }), wantStatus: http.StatusInternalServerError, wantBody: `"error":"internal server error"`},
		{name: "after commit", handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte("created"))
			panic("secret panic")
		}), wantStatus: http.StatusCreated, wantBody: "created"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			response := httptest.NewRecorder()
			NewErrorMiddleware(tc.handler, &logs).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/organizations", nil))
			if response.Code != tc.wantStatus || !strings.Contains(response.Body.String(), tc.wantBody) {
				t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
			}
			if count := strings.Count(logs.String(), "http_request_failed"); count != 1 || strings.Contains(logs.String(), "secret panic") {
				t.Fatalf("logs=%q", logs.String())
			}
		})
	}
}

func TestErrorMiddlewareAcceptsOnlyUUIDRequestIDs(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value string
		keep  bool
	}{
		{name: "valid UUID", value: "123e4567-e89b-42d3-a456-426614174000", keep: true},
		{name: "invalid secret", value: "Bearer top-secret-token", keep: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			handler := NewErrorMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				WriteError(w, http.StatusInternalServerError, "database password")
			}), &logs)
			req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
			req.Header.Set("X-Request-ID", tc.value)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			got := response.Header().Get("X-Request-ID")
			if tc.keep && got != tc.value {
				t.Fatalf("request ID=%q", got)
			}
			if !tc.keep && (!isUUID(got) || got == tc.value || strings.Contains(logs.String(), tc.value)) {
				t.Fatalf("request ID=%q logs=%q", got, logs.String())
			}
		})
	}
}

func TestErrorMiddlewarePreservesOptionalInterfacesAndImplicitStatus(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	for _, tc := range []struct {
		name   string
		writer http.ResponseWriter
		want   []any
	}{
		{name: "does not expose absent capabilities", writer: newBasicResponseWriter(), want: nil},
		{name: "preserves available capabilities", writer: newOptionalResponseWriter(), want: []any{(*http.Flusher)(nil), (*http.Hijacker)(nil), (*http.Pusher)(nil), (*io.ReaderFrom)(nil)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			NewErrorMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				for _, capability := range tc.want {
					switch capability.(type) {
					case *http.Flusher:
						if _, ok := w.(http.Flusher); !ok {
							t.Fatal("missing flusher")
						}
					case *http.Hijacker:
						if _, ok := w.(http.Hijacker); !ok {
							t.Fatal("missing hijacker")
						}
					case *http.Pusher:
						if _, ok := w.(http.Pusher); !ok {
							t.Fatal("missing pusher")
						}
					case *io.ReaderFrom:
						if _, ok := w.(io.ReaderFrom); !ok {
							t.Fatal("missing reader from")
						}
					}
				}
				if len(tc.want) == 0 {
					if _, ok := w.(http.Flusher); ok {
						t.Fatal("unexpected flusher")
					}
					if _, ok := w.(http.Hijacker); ok {
						t.Fatal("unexpected hijacker")
					}
					if _, ok := w.(http.Pusher); ok {
						t.Fatal("unexpected pusher")
					}
					if _, ok := w.(io.ReaderFrom); ok {
						t.Fatal("unexpected reader from")
					}
				}
				_, _ = w.Write([]byte("implicit ok"))
			}), io.Discard).ServeHTTP(tc.writer, request)
			if writer, ok := tc.writer.(*basicResponseWriter); ok && writer.status != http.StatusOK {
				t.Fatalf("implicit status=%d", writer.status)
			}
		})
	}
}

func TestIdempotencyCleanupFailureEventIsGeneric(t *testing.T) {
	const rawError = "pgx: password=unsafe"
	var logs bytes.Buffer
	LogIdempotencyCleanupFailure(&logs)
	if got := logs.String(); strings.Count(got, "idempotency_cleanup_failed") != 1 || strings.Contains(got, rawError) || strings.Contains(got, "%v") {
		t.Fatalf("logs=%q", got)
	}
}

type basicResponseWriter struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func newBasicResponseWriter() *basicResponseWriter {
	return &basicResponseWriter{header: make(http.Header)}
}
func (w *basicResponseWriter) Header() http.Header { return w.header }
func (w *basicResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *basicResponseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(data)
}

type optionalResponseWriter struct{ *basicResponseWriter }

func newOptionalResponseWriter() *optionalResponseWriter {
	return &optionalResponseWriter{newBasicResponseWriter()}
}
func (w *optionalResponseWriter) Flush() {}
func (w *optionalResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, http.ErrNotSupported
}
func (w *optionalResponseWriter) Push(string, *http.PushOptions) error { return nil }
func (w *optionalResponseWriter) ReadFrom(reader io.Reader) (int64, error) {
	return io.Copy(w.basicResponseWriter, reader)
}

func TestErrorMiddlewareGeneratesRequestIDAndPreservesNonFailures(t *testing.T) {
	var logs bytes.Buffer
	handler := NewErrorMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusConflict, map[string]string{"error": "idempotency_key_conflict"})
	}), &logs)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/organizations", nil))
	if res.Code != http.StatusConflict || res.Header().Get("X-Request-ID") == "" {
		t.Fatalf("status=%d requestID=%q", res.Code, res.Header().Get("X-Request-ID"))
	}
	if logs.Len() != 0 {
		t.Fatalf("non-5xx logged: %q", logs.String())
	}
}
