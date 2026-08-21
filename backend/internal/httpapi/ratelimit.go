package httpapi

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// evictAfter is the idle duration after which a per-IP bucket is
// opportunistically dropped from the map on the next Allow call that
// touches the map.
const evictAfter = 2 * time.Minute

// bucket is a per-IP token bucket. tokens is refilled lazily on each Allow
// call based on elapsed time since lastRefill — there is no background
// goroutine.
type bucket struct {
	tokens     float64
	lastRefill time.Time
}

// IPRateLimiter is an in-memory, per-IP token-bucket rate limiter. It is
// safe for concurrent use.
type IPRateLimiter struct {
	mu         sync.Mutex
	buckets    map[string]*bucket
	capacity   float64
	refillRate float64 // tokens per second
	now        func() time.Time
}

// NewIPRateLimiter constructs a limiter with the given bucket capacity
// (burst size) and refill rate in tokens per second. A new IP's bucket
// starts full, so capacity requests succeed immediately before refill-rate
// pacing applies.
func NewIPRateLimiter(capacity float64, refillRate float64) *IPRateLimiter {
	return &IPRateLimiter{
		buckets:    make(map[string]*bucket),
		capacity:   capacity,
		refillRate: refillRate,
		now:        time.Now,
	}
}

// Allow reports whether a request from ip may proceed, consuming one token
// if so. It also opportunistically evicts buckets idle longer than
// evictAfter.
func (l *IPRateLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.evictIdleBucketsLocked(now, ip)

	b, ok := l.buckets[ip]
	if !ok {
		b = &bucket{tokens: l.capacity, lastRefill: now}
		l.buckets[ip] = b
	} else {
		elapsed := now.Sub(b.lastRefill).Seconds()
		if elapsed > 0 {
			b.tokens += elapsed * l.refillRate
			if b.tokens > l.capacity {
				b.tokens = l.capacity
			}
			b.lastRefill = now
		}
	}

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// evictIdleBucketsLocked removes buckets (other than keep, the bucket about
// to be used) that have been idle longer than evictAfter. Callers must hold
// l.mu.
func (l *IPRateLimiter) evictIdleBucketsLocked(now time.Time, keep string) {
	for ip, b := range l.buckets {
		if ip == keep {
			continue
		}
		if now.Sub(b.lastRefill) > evictAfter {
			delete(l.buckets, ip)
		}
	}
}

// Middleware wraps next so that requests exceeding the per-IP rate limit
// are rejected with 429 before ever reaching next — next is never invoked
// for a denied request.
func (l *IPRateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.Allow(ClientIP(r)) {
			WriteError(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ClientIP returns the first X-Forwarded-For entry when present (the
// deployment sits behind a reverse proxy), else the host portion of
// r.RemoteAddr.
func ClientIP(r *http.Request) string {
	if forwardedFor := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwardedFor != "" {
		first := strings.SplitN(forwardedFor, ",", 2)[0]
		return strings.TrimSpace(first)
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
