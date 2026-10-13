// Package store owns every SQL statement in the server. Other packages never
// touch the database directly, which keeps the schema in one place and makes the
// tenant boundary impossible to forget in a handler.
//
// Tenant isolation is enforced in the database, not here: every request runs in
// a transaction that sets `app.tenant_id`, and the RLS policies in
// migrations/20260811000002_security.sql filter on it. This package's job is to
// guarantee that the variable is set before any query runs.
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Querier is the subset of pgx shared by *pgxpool.Pool and pgx.Tx. Repository
// methods accept it so the same SQL works inside or outside a transaction
// without duplication.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Store wraps a connection pool.
type Store struct {
	pool *pgxpool.Pool
}

// OpenPool opens a raw connection pool without wrapping it in a Store.
//
// Exposed for tooling that needs administrative access to the same database —
// migrations, test provisioning — where a tenant-scoped Store would be the wrong
// abstraction. Request paths must not use this: they need WithTenant so the RLS
// variable is set.
func OpenPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("open database pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// New opens a pool. The caller owns Close.
func New(ctx context.Context, dsn string) (*Store, error) {
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse database dsn: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open database pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Pool exposes the raw pool for health checks and admin paths. Application
// request paths must use WithTenant instead so the RLS variable is always set.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// ErrNoTenant is returned when a tenant-scoped operation is attempted without a
// tenant. It exists so that "forgot to scope this query" is an immediate,
// diagnosable error instead of an empty result set that looks like missing data.
var ErrNoTenant = errors.New("store: tenant id is required")

// WithTenant runs fn in a transaction scoped to one tenant, so that every query
// inside is filtered by the RLS policies.
//
// set_config(..., is_local = true) is used rather than `SET LOCAL` because it
// accepts the tenant as a bound parameter — the tenant id is never interpolated
// into SQL text. Being transaction-local, the setting also cannot leak to the
// next request that borrows the same pooled connection.
func (s *Store) WithTenant(ctx context.Context, tenantID string, fn func(tx pgx.Tx) error) error {
	if tenantID == "" {
		return ErrNoTenant
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
			return fmt.Errorf("set tenant context: %w", err)
		}
		return fn(tx)
	})
}

// WithAdmin runs fn with no tenant context, intended for the dombook_admin role
// whose BYPASSRLS privilege makes cross-tenant queries possible. It exists to
// keep admin SQL visibly separate from request-path SQL.
func (s *Store) WithAdmin(ctx context.Context, fn func(tx pgx.Tx) error) error {
	return s.withTx(ctx, fn)
}

func (s *Store) withTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	// Rollback is a no-op after a successful commit, so it is safe to defer
	// unconditionally and it guarantees the connection is released on panic.
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// IntegrityError describes a constraint violation, translated from a PostgreSQL
// error into something the HTTP layer can map to a status without importing pgx.
//
// The database constraint is the authority here: a quota trigger or the
// double-booking exclusion constraint decides, and the application translates
// the verdict. Re-checking in Go would reintroduce the race those constraints
// exist to close.
type IntegrityError struct {
	Constraint string
	Code       string // PostgreSQL SQLSTATE
	Message    string
	Hint       string
}

func (e *IntegrityError) Error() string {
	if e.Constraint != "" {
		return fmt.Sprintf("%s (constraint %s)", e.Message, e.Constraint)
	}
	return e.Message
}

// TranslateError converts a pgx error into an *IntegrityError when it is a
// constraint violation, and returns the error unchanged otherwise.
func TranslateError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23505", // unique_violation
		"23503", // foreign_key_violation
		"23514", // check_violation
		"23P01", // exclusion_violation
		"40001": // serialization_failure
		return &IntegrityError{
			Constraint: pgErr.ConstraintName,
			Code:       pgErr.Code,
			Message:    pgErr.Message,
			Hint:       pgErr.Hint,
		}
	}
	return err
}

// IsExclusionViolation reports whether err is the double-booking constraint.
// Named separately because it is the one constraint whose violation is a
// routine, expected outcome in the sync path rather than a bug.
func IsExclusionViolation(err error) bool {
	var integrity *IntegrityError
	return errors.As(err, &integrity) && integrity.Code == "23P01"
}

// IsUniqueViolation reports whether err is a unique constraint violation.
func IsUniqueViolation(err error) bool {
	var integrity *IntegrityError
	return errors.As(err, &integrity) && integrity.Code == "23505"
}

// ConstraintName extracts the violated constraint name, or "" if err is not a
// constraint violation.
func ConstraintName(err error) string {
	var integrity *IntegrityError
	if errors.As(err, &integrity) {
		return integrity.Constraint
	}
	return ""
}
