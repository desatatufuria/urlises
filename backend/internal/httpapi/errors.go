package httpapi

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log"
	"net"
	"net/http"
	"time"
)

// NewErrorMiddleware adds a request ID and emits one sanitized event for each
// unexpected failure. It deliberately records no headers, URL query, body, or error.
func NewErrorMiddleware(next http.Handler, output io.Writer) http.Handler {
	logger := log.New(output, "", 0)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r.Header.Get("X-Request-ID"))
		w.Header().Set("X-Request-ID", requestID)
		recorder := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		started := time.Now()
		defer func() {
			if recover() != nil {
				if !recorder.wroteHeader {
					WriteError(recorder, http.StatusInternalServerError, "internal server error")
				}
				logRequestFailure(logger, r, recorder.status, requestID, started)
				return
			}
			if recorder.status >= http.StatusInternalServerError {
				logRequestFailure(logger, r, recorder.status, requestID, started)
			}
		}()
		next.ServeHTTP(wrapStatusWriter(recorder), r)
	})
}

func LogIdempotencyCleanupFailure(output io.Writer) {
	log.New(output, "", 0).Print("event=idempotency_cleanup_failed")
}

func logRequestFailure(logger *log.Logger, r *http.Request, status int, requestID string, started time.Time) {
	route := r.Pattern
	if route == "" {
		route = "unmatched"
	}
	logger.Printf("event=http_request_failed method=%q route=%q status=%d request_id=%q duration_ms=%d", r.Method, route, status, requestID, time.Since(started).Milliseconds())
}

func requestID(candidate string) string {
	if isUUID(candidate) {
		return candidate
	}
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buffer)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
}

func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		if !(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') && !(character >= 'A' && character <= 'F') {
			return false
		}
	}
	return true
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(status int) {
	if !w.wroteHeader {
		w.status = status
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func flush(w *statusWriter) {
	w.ResponseWriter.(http.Flusher).Flush()
}

func hijack(w *statusWriter) (net.Conn, *bufio.ReadWriter, error) {
	return w.ResponseWriter.(http.Hijacker).Hijack()
}

func push(w *statusWriter, target string, options *http.PushOptions) error {
	return w.ResponseWriter.(http.Pusher).Push(target, options)
}

func readFrom(w *statusWriter, reader io.Reader) (int64, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.(io.ReaderFrom).ReadFrom(reader)
}

func wrapStatusWriter(w *statusWriter) http.ResponseWriter {
	flags := 0
	if _, ok := w.ResponseWriter.(http.Flusher); ok {
		flags |= 1
	}
	if _, ok := w.ResponseWriter.(http.Hijacker); ok {
		flags |= 2
	}
	if _, ok := w.ResponseWriter.(http.Pusher); ok {
		flags |= 4
	}
	if _, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		flags |= 8
	}
	switch flags {
	case 0:
		return w
	case 1:
		return statusF{w}
	case 2:
		return statusH{w}
	case 3:
		return statusFH{w}
	case 4:
		return statusP{w}
	case 5:
		return statusFP{w}
	case 6:
		return statusHP{w}
	case 7:
		return statusFHP{w}
	case 8:
		return statusR{w}
	case 9:
		return statusFR{w}
	case 10:
		return statusHR{w}
	case 11:
		return statusFHR{w}
	case 12:
		return statusPR{w}
	case 13:
		return statusFPR{w}
	case 14:
		return statusHPR{w}
	default:
		return statusFHPR{w}
	}
}

type statusF struct{ *statusWriter }

func (w statusF) Flush() { flush(w.statusWriter) }

type statusH struct{ *statusWriter }

func (w statusH) Hijack() (net.Conn, *bufio.ReadWriter, error) { return hijack(w.statusWriter) }

type statusP struct{ *statusWriter }

func (w statusP) Push(target string, options *http.PushOptions) error {
	return push(w.statusWriter, target, options)
}

type statusR struct{ *statusWriter }

func (w statusR) ReadFrom(reader io.Reader) (int64, error) { return readFrom(w.statusWriter, reader) }

type statusFH struct{ *statusWriter }

func (w statusFH) Flush()                                       { flush(w.statusWriter) }
func (w statusFH) Hijack() (net.Conn, *bufio.ReadWriter, error) { return hijack(w.statusWriter) }

type statusFP struct{ *statusWriter }

func (w statusFP) Flush() { flush(w.statusWriter) }
func (w statusFP) Push(target string, options *http.PushOptions) error {
	return push(w.statusWriter, target, options)
}

type statusHP struct{ *statusWriter }

func (w statusHP) Hijack() (net.Conn, *bufio.ReadWriter, error) { return hijack(w.statusWriter) }
func (w statusHP) Push(target string, options *http.PushOptions) error {
	return push(w.statusWriter, target, options)
}

type statusFHP struct{ *statusWriter }

func (w statusFHP) Flush()                                       { flush(w.statusWriter) }
func (w statusFHP) Hijack() (net.Conn, *bufio.ReadWriter, error) { return hijack(w.statusWriter) }
func (w statusFHP) Push(target string, options *http.PushOptions) error {
	return push(w.statusWriter, target, options)
}

type statusFR struct{ *statusWriter }

func (w statusFR) Flush()                                   { flush(w.statusWriter) }
func (w statusFR) ReadFrom(reader io.Reader) (int64, error) { return readFrom(w.statusWriter, reader) }

type statusHR struct{ *statusWriter }

func (w statusHR) Hijack() (net.Conn, *bufio.ReadWriter, error) { return hijack(w.statusWriter) }
func (w statusHR) ReadFrom(reader io.Reader) (int64, error)     { return readFrom(w.statusWriter, reader) }

type statusFHR struct{ *statusWriter }

func (w statusFHR) Flush()                                       { flush(w.statusWriter) }
func (w statusFHR) Hijack() (net.Conn, *bufio.ReadWriter, error) { return hijack(w.statusWriter) }
func (w statusFHR) ReadFrom(reader io.Reader) (int64, error)     { return readFrom(w.statusWriter, reader) }

type statusPR struct{ *statusWriter }

func (w statusPR) Push(target string, options *http.PushOptions) error {
	return push(w.statusWriter, target, options)
}
func (w statusPR) ReadFrom(reader io.Reader) (int64, error) { return readFrom(w.statusWriter, reader) }

type statusFPR struct{ *statusWriter }

func (w statusFPR) Flush() { flush(w.statusWriter) }
func (w statusFPR) Push(target string, options *http.PushOptions) error {
	return push(w.statusWriter, target, options)
}
func (w statusFPR) ReadFrom(reader io.Reader) (int64, error) { return readFrom(w.statusWriter, reader) }

type statusHPR struct{ *statusWriter }

func (w statusHPR) Hijack() (net.Conn, *bufio.ReadWriter, error) { return hijack(w.statusWriter) }
func (w statusHPR) Push(target string, options *http.PushOptions) error {
	return push(w.statusWriter, target, options)
}
func (w statusHPR) ReadFrom(reader io.Reader) (int64, error) { return readFrom(w.statusWriter, reader) }

type statusFHPR struct{ *statusWriter }

func (w statusFHPR) Flush()                                       { flush(w.statusWriter) }
func (w statusFHPR) Hijack() (net.Conn, *bufio.ReadWriter, error) { return hijack(w.statusWriter) }
func (w statusFHPR) Push(target string, options *http.PushOptions) error {
	return push(w.statusWriter, target, options)
}
func (w statusFHPR) ReadFrom(reader io.Reader) (int64, error) {
	return readFrom(w.statusWriter, reader)
}
