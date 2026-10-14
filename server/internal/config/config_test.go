package config

import (
	"os"
	"strings"
	"testing"
	"time"
)

// clearEnv removes every variable NewFromEnv reads, so one test cannot leak
// configuration into the next.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"DOMBOOK_ADDR", "DOMBOOK_DSN", "DOMBOOK_ENV", "JWT_SECRET", "SETUP_TOKEN",
		"ADMIN_API_KEY", "APP_NAME", "AUTH_EXPOSE_CODE", "AUTH_ACCESS_TTL_SECONDS",
		"AUTH_REFRESH_TTL_SECONDS", "AUTH_OTP_TTL_SECONDS", "AUTH_LOGIN_RATE_LIMIT",
		"AUTH_LOGIN_RATE_WINDOW_SECONDS", "AUTH_MIN_SEND_INTERVAL_SECONDS",
		"AUTH_MAX_VERIFY_ATTEMPTS", "AUTH_VERIFY_LOCK_WINDOW_SECONDS",
	} {
		t.Setenv(key, "")
		os.Unsetenv(key)
	}
}

func TestSecretsAreRequired(t *testing.T) {
	// A missing JWT secret must fail the boot. A defaulted or empty HMAC key makes
	// every session token forgeable, which is the worst possible failure mode: the
	// server looks healthy while accepting tokens anyone could mint.
	clearEnv(t)
	if _, err := NewFromEnv(); err == nil {
		t.Fatal("NewFromEnv must fail without a database DSN and JWT secret")
	}

	clearEnv(t)
	t.Setenv("DOMBOOK_DSN", "postgres://localhost/db")
	if _, err := NewFromEnv(); err == nil {
		t.Fatal("NewFromEnv must fail without JWT_SECRET")
	}

	clearEnv(t)
	t.Setenv("DOMBOOK_DSN", "postgres://localhost/db")
	t.Setenv("JWT_SECRET", "short")
	_, err := NewFromEnv()
	if err == nil {
		t.Fatal("a too-short JWT secret must be rejected")
	}
	if !strings.Contains(err.Error(), "16 characters") {
		t.Errorf("error should name the minimum length, got: %v", err)
	}
}

func TestDefaultsAreSane(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOMBOOK_DSN", "postgres://localhost/db")
	t.Setenv("JWT_SECRET", "a-sufficiently-long-secret")

	cfg, err := NewFromEnv()
	if err != nil {
		t.Fatalf("NewFromEnv: %v", err)
	}

	if cfg.Address != ":8787" {
		t.Errorf("address = %q, want :8787", cfg.Address)
	}
	if cfg.AuthExposeCode {
		// Echoing login codes must be opt-in: it makes /auth/send equivalent to
		// "log in as anyone".
		t.Error("AuthExposeCode must default to false")
	}
	if cfg.AccessTokenTTL != 15*time.Minute {
		t.Errorf("access TTL = %s, want 15m", cfg.AccessTokenTTL)
	}
	if cfg.RefreshTokenTTL != 30*24*time.Hour {
		t.Errorf("refresh TTL = %s, want 30d", cfg.RefreshTokenTTL)
	}
	if cfg.OTPTTL != 10*time.Minute {
		t.Errorf("otp TTL = %s, want 10m", cfg.OTPTTL)
	}
	// The product was renamed from DomBook. The default is asserted rather than left
	// implicit because a stale default brands every outgoing message with a name the
	// user cannot find anywhere in the app they installed.
	if cfg.AppName != "RentKeeper" {
		t.Errorf("app name = %q, want RentKeeper", cfg.AppName)
	}
	if cfg.LoginRateLimit <= 0 || cfg.MaxVerifyAttempts <= 0 || cfg.MinSendInterval <= 0 {
		t.Errorf("rate limits must have positive defaults: %+v", cfg)
	}
}

func TestEnvOverridesAreApplied(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOMBOOK_DSN", "postgres://localhost/db")
	t.Setenv("JWT_SECRET", "a-sufficiently-long-secret")
	t.Setenv("DOMBOOK_ADDR", "127.0.0.1:9999")
	t.Setenv("AUTH_ACCESS_TTL_SECONDS", "600")
	t.Setenv("AUTH_EXPOSE_CODE", "true")
	t.Setenv("APP_NAME", "TestBook")

	cfg, err := NewFromEnv()
	if err != nil {
		t.Fatalf("NewFromEnv: %v", err)
	}
	if cfg.Address != "127.0.0.1:9999" {
		t.Errorf("address = %q", cfg.Address)
	}
	if cfg.AccessTokenTTL != 10*time.Minute {
		t.Errorf("access TTL = %s, want 10m", cfg.AccessTokenTTL)
	}
	if !cfg.AuthExposeCode {
		t.Error("AUTH_EXPOSE_CODE=true should be honored")
	}
	if cfg.AppName != "TestBook" {
		t.Errorf("app name = %q", cfg.AppName)
	}
}

func TestExposeCodeIsRefusedInProduction(t *testing.T) {
	// This is a hard failure rather than a warning: in production, exposing codes
	// lets anyone who knows an address log in as that person.
	clearEnv(t)
	t.Setenv("DOMBOOK_DSN", "postgres://localhost/db")
	t.Setenv("JWT_SECRET", "a-sufficiently-long-secret")
	t.Setenv("AUTH_EXPOSE_CODE", "true")
	t.Setenv("DOMBOOK_ENV", "production")

	_, err := NewFromEnv()
	if err == nil {
		t.Fatal("AUTH_EXPOSE_CODE must be refused in production")
	}
	if !strings.Contains(err.Error(), "AUTH_EXPOSE_CODE") {
		t.Errorf("error should name the offending setting, got: %v", err)
	}
}

func TestInvalidNumbersFallBackToDefaults(t *testing.T) {
	// A garbled value must not silently become zero, which for a TTL would mean
	// "already expired" and for a limit would mean "deny everything".
	clearEnv(t)
	t.Setenv("DOMBOOK_DSN", "postgres://localhost/db")
	t.Setenv("JWT_SECRET", "a-sufficiently-long-secret")
	t.Setenv("AUTH_ACCESS_TTL_SECONDS", "not-a-number")
	t.Setenv("AUTH_LOGIN_RATE_LIMIT", "0")
	t.Setenv("AUTH_OTP_TTL_SECONDS", "-5")

	cfg, err := NewFromEnv()
	if err != nil {
		t.Fatalf("NewFromEnv: %v", err)
	}
	if cfg.AccessTokenTTL != 15*time.Minute {
		t.Errorf("garbled TTL should fall back, got %s", cfg.AccessTokenTTL)
	}
	if cfg.LoginRateLimit <= 0 {
		t.Errorf("zero limit should fall back, got %d", cfg.LoginRateLimit)
	}
	if cfg.OTPTTL <= 0 {
		t.Errorf("negative TTL should fall back, got %s", cfg.OTPTTL)
	}
}

func TestValidateRejectsNonPositiveDurations(t *testing.T) {
	// Validate is called directly by tests and by any caller building a Config in
	// code, so it must reject what NewFromEnv's fallbacks would have repaired.
	base := Config{
		DatabaseDSN:       "postgres://localhost/db",
		JWTSecret:         "a-sufficiently-long-secret",
		AccessTokenTTL:    time.Minute,
		RefreshTokenTTL:   time.Hour,
		OTPTTL:            time.Minute,
		LoginRateLimit:    5,
		MaxVerifyAttempts: 5,
	}
	if err := base.Validate(); err != nil {
		t.Fatalf("a complete config should validate, got %v", err)
	}

	for name, mutate := range map[string]func(*Config){
		"no dsn":            func(c *Config) { c.DatabaseDSN = "" },
		"no jwt secret":     func(c *Config) { c.JWTSecret = "" },
		"short jwt secret":  func(c *Config) { c.JWTSecret = "tiny" },
		"zero access ttl":   func(c *Config) { c.AccessTokenTTL = 0 },
		"zero refresh ttl":  func(c *Config) { c.RefreshTokenTTL = 0 },
		"zero otp ttl":      func(c *Config) { c.OTPTTL = 0 },
		"zero rate limit":   func(c *Config) { c.LoginRateLimit = 0 },
		"zero max attempts": func(c *Config) { c.MaxVerifyAttempts = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			broken := base
			mutate(&broken)
			if err := broken.Validate(); err == nil {
				t.Error("Validate should have rejected this configuration")
			}
		})
	}
}
