package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeClock lets ratelimit tests advance time deterministically instead of
// sleeping.
type fakeClock struct {
	now time.Time
}

func (c *fakeClock) Now() time.Time { return c.now }

func (c *fakeClock) Advance(d time.Duration) { c.now = c.now.Add(d) }

// --- Task 3.1: capacity/refill/isolation, and no touching handler state over the limit ---

func TestIPRateLimiterAllows30RequestsPerMinuteThenDenies31st(t *testing.T) {
	t.Parallel()

	clock := &fakeClock{now: time.Now()}
	limiter := NewIPRateLimiter(30, 0.5)
	limiter.now = clock.Now

	for i := 0; i < 30; i++ {
		if !limiter.Allow("203.0.113.10") {
			t.Fatalf("request %d denied, want allowed (within capacity)", i+1)
		}
	}

	if limiter.Allow("203.0.113.10") {
		t.Fatal("31st request within the same window was allowed, want denied")
	}
}

func TestIPRateLimiterHasIndependentBucketsPerIP(t *testing.T) {
	t.Parallel()

	clock := &fakeClock{now: time.Now()}
	limiter := NewIPRateLimiter(30, 0.5)
	limiter.now = clock.Now

	for i := 0; i < 30; i++ {
		if !limiter.Allow("203.0.113.1") {
			t.Fatalf("IP 1 request %d denied, want allowed", i+1)
		}
	}
	if limiter.Allow("203.0.113.1") {
		t.Fatal("IP 1's 31st request was allowed, want denied")
	}

	// A different IP has its own, untouched bucket.
	if !limiter.Allow("203.0.113.2") {
		t.Fatal("IP 2's first request was denied, want allowed (independent bucket)")
	}
}

func TestIPRateLimiterRefillsOverTime(t *testing.T) {
	t.Parallel()

	clock := &fakeClock{now: time.Now()}
	limiter := NewIPRateLimiter(30, 0.5)
	limiter.now = clock.Now

	for i := 0; i < 30; i++ {
		if !limiter.Allow("203.0.113.20") {
			t.Fatalf("request %d denied, want allowed", i+1)
		}
	}
	if limiter.Allow("203.0.113.20") {
		t.Fatal("request over capacity was allowed, want denied")
	}

	// 0.5 tokens/sec * 4s = 2 tokens refilled.
	clock.Advance(4 * time.Second)
	if !limiter.Allow("203.0.113.20") {
		t.Fatal("request after refill window was denied, want allowed")
	}
	if !limiter.Allow("203.0.113.20") {
		t.Fatal("second request after refill window was denied, want allowed (2 tokens refilled)")
	}
	if limiter.Allow("203.0.113.20") {
		t.Fatal("third request after only 2 tokens refilled was allowed, want denied")
	}
}

// spyHandler records whether it was ever invoked, to prove a 429 never
// reaches the wrapped handler (and therefore never touches secret state).
type spyHandler struct {
	calls int
}

func (s *spyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.calls++
	w.WriteHeader(http.StatusOK)
}

func TestIPRateLimiterMiddlewareDoesNotCallHandlerWhenOverLimit(t *testing.T) {
	t.Parallel()

	clock := &fakeClock{now: time.Now()}
	limiter := NewIPRateLimiter(30, 0.5)
	limiter.now = clock.Now
	spy := &spyHandler{}
	wrapped := limiter.Middleware(spy)

	for i := 0; i < 30; i++ {
		r := httptest.NewRequest(http.MethodGet, "/secrets/tok", nil)
		r.RemoteAddr = "198.51.100.5:5555"
		w := httptest.NewRecorder()
		wrapped.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200", i+1, w.Code)
		}
	}
	if spy.calls != 30 {
		t.Fatalf("spy calls after 30 allowed requests = %d, want 30", spy.calls)
	}

	r := httptest.NewRequest(http.MethodGet, "/secrets/tok", nil)
	r.RemoteAddr = "198.51.100.5:5555"
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, r)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("31st request status = %d, want %d", w.Code, http.StatusTooManyRequests)
	}
	if spy.calls != 30 {
		t.Fatalf("spy calls after 31st (denied) request = %d, want unchanged 30 (must never touch secret state)", spy.calls)
	}
}

// --- Task 3.2: ClientIP ---

func TestClientIPPrefersFirstXForwardedForEntry(t *testing.T) {
	t.Parallel()

	r := httptest.NewRequest(http.MethodGet, "/secrets/tok", nil)
	r.RemoteAddr = "10.0.0.1:12345"
	r.Header.Set("X-Forwarded-For", "203.0.113.99, 10.0.0.1")

	if got := ClientIP(r); got != "203.0.113.99" {
		t.Fatalf("ClientIP = %q, want %q (first X-Forwarded-For entry)", got, "203.0.113.99")
	}
}

func TestClientIPFallsBackToRemoteAddrWithoutXForwardedFor(t *testing.T) {
	t.Parallel()

	r := httptest.NewRequest(http.MethodGet, "/secrets/tok", nil)
	r.RemoteAddr = "198.51.100.7:54321"

	if got := ClientIP(r); got != "198.51.100.7" {
		t.Fatalf("ClientIP = %q, want %q (SplitHostPort of RemoteAddr)", got, "198.51.100.7")
	}
}
