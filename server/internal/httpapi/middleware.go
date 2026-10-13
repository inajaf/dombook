package httpapi

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/inajaf/dombook/server/internal/crypto"
)

// Middleware wraps a handler with cross-cutting behavior.
type Middleware func(http.Handler) http.Handler

// Chain applies middleware so the FIRST argument is the outermost layer.
//
// Order is spelled out rather than left to the caller's intuition because it is
// load-bearing: recovery must be outside logging so a panic is still reported, and
// logging must be outside the router so every response is measured.
func Chain(handler http.Handler, middleware ...Middleware) http.Handler {
	for i := len(middleware) - 1; i >= 0; i-- {
		handler = middleware[i](handler)
	}
	return handler
}

// RecoverPanic converts a panic into a 500 and keeps the process alive.
//
// Without it a single malformed request that trips a nil dereference takes the
// whole server down, turning one client's bug into an outage for every tenant. The
// stack goes to the log, never to the response: a Go stack trace names internal
// files and functions.
func RecoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Error("panic recovered",
					"error", recovered,
					"path", r.URL.Path,
					"method", r.Method,
					"stack", string(debug.Stack()))
				WriteError(w, &ApiError{
					Status:  http.StatusInternalServerError,
					Code:    "internal",
					Message: "Internal server error",
				})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the status code so the access log can report it.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	written, err := r.ResponseWriter.Write(data)
	r.bytes += written
	return written, err
}

// AccessLog records one line per request.
//
// Sensitive material is deliberately absent: no Authorization header, no request
// body, no query string. Guest names, phone numbers and login codes travel in
// those places, and an access log is the easiest place for personal data to leak
// into a third-party log aggregator.
func AccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}

		next.ServeHTTP(recorder, r)

		if recorder.status == 0 {
			recorder.status = http.StatusOK
		}
		level := slog.LevelInfo
		if recorder.status >= 500 {
			level = slog.LevelError
		} else if recorder.status >= 400 {
			level = slog.LevelWarn
		}
		slog.Log(r.Context(), level, "request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", recorder.status,
			"bytes", recorder.bytes,
			"duration", time.Since(started).Round(time.Millisecond).String())
	})
}

// RequestID tags each request with an id, echoed in the response, so a client
// report can be correlated with a server log line.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" || len(id) > 64 {
			generated, err := crypto.NewUUID()
			if err != nil {
				generated = "unknown"
			}
			id = generated
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r)
	})
}

// CORSConfig describes the allowed browser origins.
type CORSConfig struct {
	// AllowedOrigins is matched exactly against the Origin header. An entry of "*"
	// allows any origin and must only be used when credentials are not involved.
	AllowedOrigins []string
	// AllowCredentials permits cookies and Authorization headers on cross-origin
	// requests. It cannot be combined with a "*" origin.
	AllowCredentials bool
}

// CORS answers preflight requests and sets response headers.
//
// The previous implementation sent `access-control-allow-origin: *`. That is kept
// as the default because the desktop and web clients are not cookie-based: they
// authenticate with an explicit bearer token, so a permissive origin does not
// grant a hostile page access to anyone's data. The moment credentials or cookies
// are introduced this must become an exact allow-list — the configuration refuses
// `*` together with AllowCredentials for exactly that reason.
func CORS(config CORSConfig) Middleware {
	allowAll := len(config.AllowedOrigins) == 1 && config.AllowedOrigins[0] == "*"

	allowed := func(origin string) bool {
		if allowAll {
			return true
		}
		for _, candidate := range config.AllowedOrigins {
			if strings.EqualFold(candidate, origin) {
				return true
			}
		}
		return false
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && allowed(origin) {
				// Echo the specific origin rather than "*" so that a future
				// credentialed request cannot silently inherit a wildcard grant.
				if allowAll && !config.AllowCredentials {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				} else {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Add("Vary", "Origin")
				}
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "content-type, authorization, x-device-id, x-client-id, x-request-id")
				w.Header().Set("Access-Control-Max-Age", "86400")
				if config.AllowCredentials {
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				}
				// A client cannot read X-Request-Id cross-origin unless it is exposed.
				w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id")
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ValidateCORS reports a dangerous CORS configuration.
//
// A wildcard origin combined with credentials tells browsers to let any site read
// authenticated responses — the exact situation CORS exists to prevent. Browsers
// reject the combination, so the misconfiguration would surface as a mystifying
// client-side failure; catching it at startup is far more useful.
func ValidateCORS(config CORSConfig) error {
	if config.AllowCredentials {
		for _, origin := range config.AllowedOrigins {
			if origin == "*" {
				return &ApiError{
					Status:  http.StatusInternalServerError,
					Code:    "cors_misconfigured",
					Message: "allow-credentials cannot be combined with a wildcard origin",
				}
			}
		}
	}
	return nil
}
