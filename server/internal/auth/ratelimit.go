package auth

import (
	"sync"
	"time"
)

// RateLimiter throttles the unauthenticated login endpoints.
//
// Two limits, because they defend against different things:
//
//   - send: how often a code may be requested for one address. Without it,
//     /auth/send is an open relay that mails a stranger on demand.
//   - verify: how many wrong codes may be tried. A 6-digit code is only a million
//     possibilities; unlimited guesses turn it into a formality.
//
// State is in memory, keyed by email. That is a deliberate trade-off: it adds no
// database round trip on the hot path, and it resets on restart. A durable
// backstop for the send limit lives in the database (count_recent_login_codes),
// which is what keeps the limit meaningful across a restart or across more than
// one server instance. For verify attempts the in-memory limit is the only bound,
// so a restart briefly reopens the budget — acceptable for a code that also
// expires, and noted here rather than left as a surprise.
//
// The map is swept lazily on access. An explicit background sweeper would be more
// thorough but would also add a goroutine whose lifecycle must be managed for a
// structure whose entries are tiny and short-lived.
type RateLimiter struct {
	mu      sync.Mutex
	entries map[string]*rateEntry

	// minInterval is the minimum gap between two code requests for one address.
	minInterval time.Duration
	// sendLimit is the number of codes allowed per address per sendWindow.
	sendLimit  int
	sendWindow time.Duration
	// maxAttempts locks an address after this many failures within lockWindow.
	maxAttempts int
	lockWindow  time.Duration
}

type rateEntry struct {
	// sendTimes holds the timestamps of recent code requests, oldest first.
	sendTimes []time.Time
	// failedAttempts counts consecutive wrong codes.
	failedAttempts int
	// firstFailure is when the current failure streak began.
	firstFailure time.Time
	// lockedUntil is non-zero while the address is locked out.
	lockedUntil time.Time
}

// RateLimiterOptions configures the limiter.
type RateLimiterOptions struct {
	MinInterval time.Duration
	SendLimit   int
	SendWindow  time.Duration
	MaxAttempts int
	LockWindow  time.Duration
}

// NewRateLimiter builds a limiter.
func NewRateLimiter(options RateLimiterOptions) *RateLimiter {
	return &RateLimiter{
		entries:     map[string]*rateEntry{},
		minInterval: options.MinInterval,
		sendLimit:   options.SendLimit,
		sendWindow:  options.SendWindow,
		maxAttempts: options.MaxAttempts,
		lockWindow:  options.LockWindow,
	}
}

// AllowSend reports whether a code may be issued for key right now, and how long
// the caller must wait when it may not.
func (r *RateLimiter) AllowSend(key string, now time.Time) (allowed bool, retryAfter time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry := r.entryLocked(key, now)

	// Most recent request first: the minimum interval applies to consecutive
	// requests, not to the window as a whole.
	if len(entry.sendTimes) > 0 {
		sinceLast := now.Sub(entry.sendTimes[len(entry.sendTimes)-1])
		if sinceLast < r.minInterval {
			return false, r.minInterval - sinceLast
		}
	}

	// The window limit releases when the OLDEST request leaves the window, so the
	// wait is measured from that oldest timestamp. Measuring from the newest would
	// never release: each blocked attempt would push the deadline forward, and an
	// address that once hit the cap would stay blocked forever.
	if len(entry.sendTimes) >= r.sendLimit {
		oldest := entry.sendTimes[0]
		wait := r.sendWindow - now.Sub(oldest)
		if wait > 0 {
			return false, wait
		}
	}
	return true, 0
}

// RecordSend notes that a code was issued for key.
func (r *RateLimiter) RecordSend(key string, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry := r.entryLocked(key, now)
	entry.sendTimes = append(entry.sendTimes, now)
	// Drop timestamps that have left the window so the slice cannot grow without
	// bound on a long-lived process.
	cutoff := now.Add(-r.sendWindow)
	kept := entry.sendTimes[:0]
	for _, stamp := range entry.sendTimes {
		if stamp.After(cutoff) {
			kept = append(kept, stamp)
		}
	}
	entry.sendTimes = kept
}

// VerificationLocked reports whether verification is locked out for key, and for
// how much longer.
func (r *RateLimiter) VerificationLocked(key string, now time.Time) (locked bool, retryAfter time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry := r.entryLocked(key, now)
	if entry.lockedUntil.After(now) {
		return true, entry.lockedUntil.Sub(now)
	}
	return false, 0
}

// RecordFailedVerification counts a wrong code and locks the key once the
// threshold is reached.
func (r *RateLimiter) RecordFailedVerification(key string, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry := r.entryLocked(key, now)

	// A failure streak older than the window is stale; start a new one rather
	// than letting occasional typos accumulate into a lockout over days.
	if entry.firstFailure.IsZero() || now.Sub(entry.firstFailure) > r.lockWindow {
		entry.firstFailure = now
		entry.failedAttempts = 1
	} else {
		entry.failedAttempts++
	}

	if entry.failedAttempts >= r.maxAttempts {
		entry.lockedUntil = now.Add(r.lockWindow)
		entry.failedAttempts = 0
		entry.firstFailure = time.Time{}
	}
}

// RecordSuccessfulVerification clears the failure streak for key. A correct code
// proves the caller is the mailbox owner, so the penalty for earlier typos should
// not persist.
func (r *RateLimiter) RecordSuccessfulVerification(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if entry, ok := r.entries[key]; ok {
		entry.failedAttempts = 0
		entry.firstFailure = time.Time{}
		entry.lockedUntil = time.Time{}
	}
}

// entryLocked returns the entry for key, creating it and sweeping expired state.
// Callers must hold the mutex.
func (r *RateLimiter) entryLocked(key string, now time.Time) *rateEntry {
	entry, ok := r.entries[key]
	if !ok {
		entry = &rateEntry{}
		r.entries[key] = entry
		return entry
	}

	// Lazy sweep. An entry is worthless once it holds no live lock and no
	// timestamp inside the window; without this, a spray of distinct addresses
	// grows the map without bound.
	//
	// Expired state is discarded first, then staleness is retested. Clearing
	// matters because `AllowSend` also calls this: a client that polls while
	// throttled would otherwise keep its own expired timestamps alive forever,
	// and the same addresses would never be swept.
	r.pruneExpired(entry, now)
	if r.isStale(entry, now) {
		delete(r.entries, key)
		// A fresh entry is returned rather than recursing: recursing re-enters
		// this same branch forever and overflows the stack.
		fresh := &rateEntry{}
		r.entries[key] = fresh
		return fresh
	}
	return entry
}

// pruneExpired drops timestamps and counters whose windows have passed. Callers
// must hold the mutex.
//
// Each field is measured against its OWN window. Using the larger of the two for
// both would make the send limit over-enforce: a timestamp retained past the send
// window still counts toward the cap, so an address that once hit it stays blocked
// until the longer lock window elapsed — in the shipped defaults, fifteen minutes
// instead of the intended window.
func (r *RateLimiter) pruneExpired(entry *rateEntry, now time.Time) {
	kept := entry.sendTimes[:0]
	for _, stamp := range entry.sendTimes {
		if now.Sub(stamp) <= r.sendWindow {
			kept = append(kept, stamp)
		}
	}
	entry.sendTimes = kept

	if entry.lockedUntil.Before(now) {
		entry.lockedUntil = time.Time{}
	}
	if entry.failedAttempts > 0 && now.Sub(entry.firstFailure) > r.lockWindow {
		entry.failedAttempts = 0
		entry.firstFailure = time.Time{}
	}
}

// isStale reports whether an entry has nothing left to enforce. Callers must hold
// the mutex and should call pruneExpired first.
func (r *RateLimiter) isStale(entry *rateEntry, now time.Time) bool {
	if entry.lockedUntil.After(now) {
		return false
	}
	if entry.failedAttempts > 0 {
		return false
	}
	// Any timestamp still inside the send window keeps the entry alive.
	for _, stamp := range entry.sendTimes {
		if now.Sub(stamp) <= r.sendWindow {
			return false
		}
	}
	return true
}

// Size reports the number of tracked keys. Used by tests to confirm entries are
// swept rather than accumulating forever.
func (r *RateLimiter) Size() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries)
}

// Sweep drops every entry that has nothing left to enforce and reports how many
// were removed.
//
// This is the bound on memory. The pruning inside entryLocked only cleans keys
// that are touched again, so a flood of one-shot addresses — the exact shape of a
// credential-stuffing attempt — would otherwise grow the map without limit while
// no individual key looks worth visiting. A caller should invoke this
// periodically; the returned count is worth logging, since a persistently large
// sweep is a signal about traffic rather than a routine housekeeping detail.
func (r *RateLimiter) Sweep(now time.Time) int {
	r.mu.Lock()
	defer r.mu.Unlock()

	removed := 0
	for key, entry := range r.entries {
		r.pruneExpired(entry, now)
		if r.isStale(entry, now) {
			delete(r.entries, key)
			removed++
		}
	}
	return removed
}
