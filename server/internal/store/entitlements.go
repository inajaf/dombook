package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Entitlement is one thing an account has been granted.
//
// A row is evidence of a grant, never edited in place. A refund or revocation sets
// revoked_at, so the history of what a customer paid for survives a dispute about it.
type Entitlement struct {
	ID        string     `json:"id"`
	SKU       string     `json:"sku"`
	Source    string     `json:"source"`
	GrantedAt time.Time  `json:"grantedAt"`
	ExpiresAt *time.Time `json:"expiresAt"`
	Reference string     `json:"reference"`
}

// GrantEntitlement records a grant.
//
// Idempotent on (account, sku, reference) when a reference is supplied: a payment webhook
// is retried on any non-2xx, so a repeated delivery must not create a second entitlement
// for one purchase.
func (s *Store) GrantEntitlement(
	ctx context.Context,
	accountID, sku, source, reference string,
	expiresAt *time.Time,
	metadata map[string]any,
) (string, error) {
	id, err := NewID()
	if err != nil {
		return "", err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}

	var granted string
	err = s.WithAdmin(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT grant_entitlement($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)`,
			id, accountID, sku, source, expiresAt, reference, metadata,
		).Scan(&granted)
	})
	if err != nil {
		return "", TranslateError(err)
	}
	return granted, nil
}

// RevokeEntitlement withdraws every live grant of a SKU.
//
// Returns how many grants were withdrawn, so a caller can report "nothing to revoke"
// rather than appearing to succeed.
func (s *Store) RevokeEntitlement(ctx context.Context, accountID, sku, reason string) (int, error) {
	var affected int
	err := s.WithAdmin(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT revoke_entitlement($1::uuid, $2, $3)`,
			accountID, sku, reason,
		).Scan(&affected)
	})
	if err != nil {
		return 0, TranslateError(err)
	}
	return affected, nil
}

// ActiveEntitlements lists the grants that currently count.
//
// Runs through the SECURITY DEFINER function rather than the table, because a client has to
// be able to ask "what have I paid for" as part of startup — and a signed-out app must
// still learn that its cached licence is valid instead of silently dropping to the free
// tier.
func (s *Store) ActiveEntitlements(ctx context.Context, accountID string) ([]Entitlement, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, sku, source, granted_at, expires_at
		   FROM active_entitlements_for_account($1::uuid)`, accountID)
	if err != nil {
		return nil, TranslateError(err)
	}
	defer rows.Close()

	entitlements := []Entitlement{}
	for rows.Next() {
		var item Entitlement
		if err := rows.Scan(&item.ID, &item.SKU, &item.Source, &item.GrantedAt, &item.ExpiresAt); err != nil {
			return nil, TranslateError(err)
		}
		entitlements = append(entitlements, item)
	}
	if err := rows.Err(); err != nil {
		return nil, TranslateError(err)
	}
	return entitlements, nil
}

// EntitlementHistory lists every grant, including revoked and expired ones, for an operator
// investigating a payment.
//
// Kept separate from ActiveEntitlements on purpose: "what does this account have" and "what
// has ever happened to this account" are different questions, and answering the second with
// the first would hide exactly the revoked grant a dispute is about.
func (s *Store) EntitlementHistory(ctx context.Context, accountID string, limit int) ([]Entitlement, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	// Through the SECURITY DEFINER function rather than a plain SELECT. The table is under
	// RLS, so a query without a tenant context returns zero rows and looks like a success —
	// which would report that a customer who paid has no history at all.
	rows, err := s.pool.Query(ctx,
		`SELECT id, sku, source, granted_at, expires_at, reference
		   FROM entitlement_history_for_account($1::uuid, $2)`, accountID, limit)
	if err != nil {
		return nil, TranslateError(err)
	}
	defer rows.Close()

	items := []Entitlement{}
	for rows.Next() {
		var item Entitlement
		if err := rows.Scan(&item.ID, &item.SKU, &item.Source, &item.GrantedAt, &item.ExpiresAt, &item.Reference); err != nil {
			return nil, TranslateError(err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, TranslateError(err)
	}
	return items, nil
}
