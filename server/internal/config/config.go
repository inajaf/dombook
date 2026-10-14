// Package config reads the server's runtime configuration from the environment.
//
// Configuration is parsed and validated once at startup rather than read at each
// use site, so a missing secret fails the boot instead of surfacing later as a
// confusing 500 on one endpoint. Secrets are never defaulted: a default JWT
// secret would let anyone mint tokens for any deployment that forgot to set one.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the validated server configuration.
type Config struct {
	// Address is the listen address, e.g. ":8787".
	Address string
	// DatabaseDSN is the application-role connection string. It must NOT be a
	// role with BYPASSRLS: tenant isolation depends on the role being subject to
	// the policies.
	DatabaseDSN string

	JWTSecret string
	// AccessTokenTTL is deliberately short. Offline clients keep working from
	// cached data and refresh when they reconnect; see RefreshTokenTTLSeconds.
	AccessTokenTTL time.Duration
	// RefreshTokenTTL bounds how long a client can stay signed in without
	// re-authenticating. Refresh tokens rotate on every use.
	RefreshTokenTTL time.Duration
	// OTPTTL bounds a login code's life.
	OTPTTL time.Duration

	// AuthExposeCode returns the login code in the /auth/send response. Local
	// development only: in production the code is emailed, and echoing it would
	// let anyone who knows an address log in as that user.
	AuthExposeCode bool

	// SetupToken gates POST /auth/setup once the first account exists. Without
	// it, whoever finds the endpoint first could claim the installation.
	SetupToken string

	// AdminAPIKey authenticates the /admin surface. It is compared in constant time and
	// must be long enough that guessing is hopeless: it grants access to every tenant's
	// data at once.
	AdminAPIKey string

	// SkipMigrations disables the startup migration pass.
	//
	// Needed in production, where the API connects as the unprivileged application role and
	// therefore CANNOT migrate: applying a migration needs to create objects in the schema,
	// and the role is deliberately denied that. Without this switch a correctly-configured
	// deployment would refuse to start, and the tempting workaround would be to run the API
	// as a privileged role — which would hand the request path the ability to bypass RLS.
	//
	// Migrations are then applied out of band by `cmd/migrate` as the owner.
	SkipMigrations bool

	// AdminDatabaseDSN connects as the BYPASSRLS operator role. It is a separate
	// connection from DatabaseDSN on purpose: the customer path must not be able to
	// escalate into cross-tenant reads, so the two never share a credential. Empty means
	// the admin surface is disabled entirely.
	AdminDatabaseDSN string

	// AppName brands outgoing messages. It must match the name the desktop and web
	// clients show, or a user is told a product they do not have is writing to them.
	AppName string

	// LoginRateLimit is the number of login codes allowed per email per window.
	LoginRateLimit int
	// LoginRateWindow is the window for LoginRateLimit.
	LoginRateWindow time.Duration
	// MinSendInterval throttles back-to-back code requests for one address.
	MinSendInterval time.Duration
	// MaxVerifyAttempts locks an address after repeated wrong codes, so a 6-digit
	// code cannot be brute-forced.
	MaxVerifyAttempts int
	// VerifyLockWindow is how long failed attempts are remembered.
	VerifyLockWindow time.Duration
}

// NewFromEnv builds a Config from environment variables.
func NewFromEnv() (*Config, error) {
	cfg := &Config{
		Address:           envOr("RENTKEEPER_ADDR", envOr("DOMBOOK_ADDR", ":8787")),
		DatabaseDSN:       envFallback("RENTKEEPER_DSN", "DOMBOOK_DSN"),
		AdminDatabaseDSN:  envFallback("RENTKEEPER_ADMIN_DSN", "DOMBOOK_ADMIN_DSN"),
		SkipMigrations:    envBool("RENTKEEPER_SKIP_MIGRATE", envBool("DOMBOOK_SKIP_MIGRATE", false)),
		JWTSecret:         os.Getenv("JWT_SECRET"),
		SetupToken:        os.Getenv("SETUP_TOKEN"),
		AdminAPIKey:       os.Getenv("ADMIN_API_KEY"),
		AppName:           envOr("APP_NAME", "RentKeeper"),
		AuthExposeCode:    envBool("RENTKEEPER_EXPOSE_CODE", envBool("AUTH_EXPOSE_CODE", false)),
		AccessTokenTTL:    time.Duration(envInt("AUTH_ACCESS_TTL_SECONDS", 900)) * time.Second,
		RefreshTokenTTL:   time.Duration(envInt("AUTH_REFRESH_TTL_SECONDS", 30*24*3600)) * time.Second,
		OTPTTL:            time.Duration(envInt("AUTH_OTP_TTL_SECONDS", 600)) * time.Second,
		LoginRateLimit:    envInt("AUTH_LOGIN_RATE_LIMIT", 5),
		LoginRateWindow:   time.Duration(envInt("AUTH_LOGIN_RATE_WINDOW_SECONDS", 900)) * time.Second,
		MinSendInterval:   time.Duration(envInt("AUTH_MIN_SEND_INTERVAL_SECONDS", 60)) * time.Second,
		MaxVerifyAttempts: envInt("AUTH_MAX_VERIFY_ATTEMPTS", 5),
		VerifyLockWindow:  time.Duration(envInt("AUTH_VERIFY_LOCK_WINDOW_SECONDS", 900)) * time.Second,
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// envFallback reads the current variable name, falling back to the name the product used
// before it was renamed from DomBook.
//
// The fallback exists because these are DEPLOYMENT inputs: an existing installation has the
// old names in its systemd unit, its compose file or its secret store, and a rename that
// silently stopped honouring them would leave a server without a DSN — or, worse for
// AUTH_EXPOSE_CODE, quietly revert to a default instead of the operator's explicit choice.
// Nothing on a user's disk is named after these variables, so unlike the userData directory
// and the SQLite filename (see AGENTS.md) they CAN be renamed; they just must not break anyone.
func envFallback(current, legacy string) string {
	if value := strings.TrimSpace(os.Getenv(current)); value != "" {
		return value
	}
	return strings.TrimSpace(os.Getenv(legacy))
}

// Validate reports missing or nonsensical settings. It is called at startup and
// by tests that build a Config directly.
func (c *Config) Validate() error {
	var problems []string

	if c.DatabaseDSN == "" {
		problems = append(problems, "DOMBOOK_DSN is required")
	}
	// Fail closed on an absent secret. A defaulted or empty HMAC key would make
	// every session token forgeable by anyone who knows the default.
	if c.JWTSecret == "" {
		problems = append(problems, "JWT_SECRET is required")
	}
	if len(c.JWTSecret) < 16 {
		problems = append(problems, "JWT_SECRET must be at least 16 characters")
	}
	// An admin key that is present but weak is worse than none: it looks configured while
	// being guessable. Absent is fine — the surface is then simply not mounted.
	if c.AdminAPIKey != "" && len(c.AdminAPIKey) < 24 {
		problems = append(problems, "ADMIN_API_KEY must be at least 24 characters, or unset to disable /admin")
	}
	if c.AccessTokenTTL <= 0 {
		problems = append(problems, "AUTH_ACCESS_TTL_SECONDS must be positive")
	}
	if c.RefreshTokenTTL <= 0 {
		problems = append(problems, "AUTH_REFRESH_TTL_SECONDS must be positive")
	}
	if c.OTPTTL <= 0 {
		problems = append(problems, "AUTH_OTP_TTL_SECONDS must be positive")
	}
	if c.LoginRateLimit <= 0 {
		problems = append(problems, "AUTH_LOGIN_RATE_LIMIT must be positive")
	}
	if c.MaxVerifyAttempts <= 0 {
		problems = append(problems, "AUTH_MAX_VERIFY_ATTEMPTS must be positive")
	}

	if len(problems) > 0 {
		return fmt.Errorf("invalid configuration: %s", strings.Join(problems, "; "))
	}

	// A loud warning rather than a hard failure: exposing the code is legitimate
	// for local development and for a self-hosted install with no mail provider,
	// but it makes the login endpoint equivalent to "log in as anyone". Surfacing
	// it at startup is the difference between a deliberate choice and an accident.
	if c.AuthExposeCode && envFallback("RENTKEEPER_ENV", "DOMBOOK_ENV") == "production" {
		return errors.New("AUTH_EXPOSE_CODE must be off in production: it returns login codes to the caller")
	}
	return nil
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

// envInt reads a positive integer setting, falling back when the value is absent,
// unparseable, or non-positive.
//
// Rejecting non-positive values here rather than letting them through matters for
// every setting this reads: a zero or negative TTL means "already expired", and a
// zero limit means "deny everything". A garbled environment variable should
// degrade to the documented default, not silently disable a feature. Callers that
// build a Config in code still go through Validate, which rejects these values
// outright.
func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envBool(key string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch raw {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	default:
		return fallback
	}
}
