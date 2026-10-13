package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// GetTenantState reads the per-tenant sync watermark.
//
// It reads without a tenant context: the caller is usually authenticated by a
// token that already carries the account id, and requiring a tenant-scoped
// transaction just to read a counter would force a pointless nesting of
// transactions. The accounts/tenant_state RLS policy still applies, so a
// connection cannot read another tenant's watermark.
func (s *Store) GetTenantState(ctx context.Context, tenantID string) (*TenantState, error) {
	var state TenantState
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT tenant_id, version, updated_at FROM tenant_state WHERE tenant_id = $1`,
			tenantID).Scan(&state.TenantID, &state.Version, &state.UpdatedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get tenant state: %w", err)
	}
	return &state, nil
}

// BumpTenantVersion increments and returns the tenant's monotonic sync version.
//
// This is the ordering authority for the whole sync protocol. It is a server-side
// counter rather than a timestamp precisely so that a client with a skewed clock
// cannot win conflicts by claiming a later time.
//
// The UPDATE is its own statement, so it takes a row lock: concurrent pushes for
// the same tenant serialize here and each receives a distinct version. That is
// what makes "version is unique per applied row" hold under concurrency.
func (s *Store) BumpTenantVersion(ctx context.Context, tx pgx.Tx, tenantID string) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, `
		UPDATE tenant_state SET version = version + 1, updated_at = now()
		WHERE tenant_id = $1
		RETURNING version`, tenantID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		// An account without a tenant_state row is a data-integrity fault, not a
		// normal condition: the row is created with the account. Provision it
		// rather than failing the request, so one missing row cannot wedge sync.
		if err := tx.QueryRow(ctx, `
			INSERT INTO tenant_state(tenant_id, version) VALUES ($1, 1)
			ON CONFLICT (tenant_id) DO UPDATE SET version = tenant_state.version + 1, updated_at = now()
			RETURNING version`, tenantID).Scan(&version); err != nil {
			return 0, fmt.Errorf("provision tenant state: %w", err)
		}
		return version, nil
	}
	if err != nil {
		return 0, fmt.Errorf("bump tenant version: %w", err)
	}
	return version, nil
}

// BumpTenantVersionStandalone bumps the version outside an existing transaction.
// Used by paths that do not otherwise write rows (such as recording an audit
// entry on its own).
func (s *Store) BumpTenantVersionStandalone(ctx context.Context, tenantID string) (int64, error) {
	var version int64
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var err error
		version, err = s.BumpTenantVersion(ctx, tx, tenantID)
		return err
	})
	return version, err
}
