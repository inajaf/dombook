// Command api runs the RentKeeper HTTP server.
//
// It is the composition root: the only place that reads environment
// configuration, opens the database, builds the services, and starts the listener.
// Everything below it takes its dependencies as arguments, which is what allows the
// route and service tests to run against a real database without booting a server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/inajaf/dombook/server/internal/admin"
	"github.com/inajaf/dombook/server/internal/api"
	"github.com/inajaf/dombook/server/internal/auth"
	"github.com/inajaf/dombook/server/internal/config"
	"github.com/inajaf/dombook/server/internal/domain"
	"github.com/inajaf/dombook/server/internal/domainservice"
	"github.com/inajaf/dombook/server/internal/store"
)

func main() {
	if err := run(); err != nil {
		// Log through the structured logger so a startup failure has the same shape
		// as any other error line, and exit non-zero so a supervisor restarts us.
		slog.Error("server exited with an error", "error", err)
		os.Exit(1)
	}
}

func run() error {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: logLevel(),
	})))

	cfg, err := config.NewFromEnv()
	if err != nil {
		return err
	}

	// Signal-aware context: Ctrl-C and SIGTERM both stop the listener, and the
	// same context bounds the graceful drain below.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Migrations run at startup so a fresh deployment cannot serve traffic against a schema
	// it does not expect. This is safe because Migrate is idempotent.
	//
	// They are skipped when DOMBOOK_SKIP_MIGRATE=1, which is how a production deployment runs:
	// the API connects as the unprivileged application role and cannot create objects, and
	// granting it that ability would also give the request path a way around RLS.
	if !cfg.SkipMigrations {
		if err := store.Migrate(ctx, cfg.DatabaseDSN); err != nil {
			return fmt.Errorf("apply migrations: %w", err)
		}
	}

	database, err := store.New(ctx, cfg.DatabaseDSN)
	if err != nil {
		return err
	}
	defer database.Close()

	limiter := auth.NewRateLimiter(auth.RateLimiterOptions{
		MinInterval: cfg.MinSendInterval,
		SendLimit:   cfg.LoginRateLimit,
		SendWindow:  cfg.LoginRateWindow,
		MaxAttempts: cfg.MaxVerifyAttempts,
		LockWindow:  cfg.VerifyLockWindow,
	})

	authService := auth.New(database, auth.Options{
		AppName:    cfg.AppName,
		JWTSecret:  cfg.JWTSecret,
		AccessTTL:  cfg.AccessTokenTTL,
		RefreshTTL: cfg.RefreshTokenTTL,
		OTPTTL:     cfg.OTPTTL,
		OTPLength:  6,
		ExposeCode: cfg.AuthExposeCode,
		SetupToken: cfg.SetupToken,
	}, limiter, nil)

	domainService := domainservice.New(database, domainservice.Options{
		TimeZone: domain.DefaultPolicy.TimeZone,
	})

	cors := api.CORSConfig{
		// The desktop and web clients authenticate with a bearer token rather than
		// cookies, so a wildcard origin does not expose anyone's data. Tighten this
		// to an explicit list before introducing cookie-based sessions.
		AllowedOrigins: []string{"*"},
	}

	customerHandler, err := api.BuildHandler(api.Deps{Auth: authService, Domain: domainService, Store: database}, cors)
	if err != nil {
		return err
	}

	// The admin surface is mounted only when both a key and a dedicated DSN are present.
	// The separate connection is what keeps the operator's cross-tenant access from being
	// reachable through the customer path: they are different credentials, so a bug in
	// request handling cannot escalate.
	handler := customerHandler
	if cfg.AdminAPIKey != "" && cfg.AdminDatabaseDSN != "" {
		adminStore, adminErr := store.New(ctx, cfg.AdminDatabaseDSN)
		if adminErr != nil {
			return fmt.Errorf("connect as admin role: %w", adminErr)
		}
		defer adminStore.Close()

		adminHandler := admin.Server(admin.Deps{Store: adminStore, APIKey: cfg.AdminAPIKey})
		handler = routeByPrefix(customerHandler, adminHandler)
		slog.Info("admin surface enabled", "path", "/admin/*")
	} else {
		slog.Warn("admin surface disabled: set ADMIN_API_KEY and DOMBOOK_ADMIN_DSN to enable")
	}

	server := &http.Server{
		Addr:    cfg.Address,
		Handler: handler,
		// A slow or stalled client must not be able to hold a connection open
		// indefinitely; without deadlines one socket can consume a worker forever.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Periodic sweep bounds the rate limiter's memory. Pruning on access only
	// cleans keys that are visited again, so a flood of one-shot addresses needs a
	// janitor; a large sweep count is also a useful intrusion signal in the log.
	sweeperDone := make(chan struct{})
	go func() {
		defer close(sweeperDone)
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if removed := limiter.Sweep(time.Now()); removed > 0 {
					slog.Debug("swept expired rate-limit entries", "removed", removed)
				}
			}
		}
	}()

	serverErrors := make(chan error, 1)
	go func() {
		slog.Info("listening", "address", cfg.Address, "app", cfg.AppName)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErrors <- err
		}
	}()

	select {
	case err := <-serverErrors:
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
		slog.Info("shutdown signal received; draining connections")
	}

	// A bounded drain: in-flight requests get a chance to finish, but a stuck one
	// cannot prevent the process from exiting. Without the timeout, a single slow
	// request would make a deploy hang until it was killed.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	<-sweeperDone
	slog.Info("shutdown complete")
	return nil
}

// routeByPrefix dispatches /admin/* to the operator router and everything else to the
// customer router.
//
// A prefix split rather than two listeners: one port is simpler to deploy and secure, and
// the admin router carries its own guard so no request can reach an operator endpoint
// without the key.
func routeByPrefix(customer, adminHandler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/admin/") {
			adminHandler.ServeHTTP(w, r)
			return
		}
		customer.ServeHTTP(w, r)
	})
}

// logLevel reads the level from the environment, defaulting to info.
func logLevel() slog.Level {
	// RENTKEEPER_LOG_LEVEL first, then the legacy name an existing deployment exports.
	level := os.Getenv("RENTKEEPER_LOG_LEVEL")
	if level == "" {
		level = os.Getenv("DOMBOOK_LOG_LEVEL")
	}
	switch level {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
