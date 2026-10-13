package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// RefreshTokenRecord is a consumed refresh token.
type RefreshTokenRecord struct {
	TokenID   string
	FamilyID  string
	AccountID string
	UserID    string
	DeviceID  *string
	// WasUsed reports that the token had already been consumed when it was read.
	// A true value is a compromise signal, not a routine condition.
	WasUsed bool
}

// RefreshTokenFamily describes a token's chain regardless of its state, which is
// what allows a rejected token to be attributed to a family.
type RefreshTokenFamily struct {
	TokenID   string
	FamilyID  string
	AccountID string
	UserID    string
	Revoked   bool
	Used      bool
	Expired   bool
}

// IssueRefreshToken records a refresh token by hash.
func (s *Store) IssueRefreshToken(
	ctx context.Context,
	tokenID, familyID, accountID, userID string,
	deviceID *string,
	tokenHash string,
	expiresAt time.Time,
) error {
	// Belt and braces: the family id is supplied by the caller, and a mismatch
	// between it and the token's embedded family would silently break reuse
	// detection by splitting one chain into two.
	if tokenID == "" || familyID == "" || tokenHash == "" {
		return errors.New("issue refresh token: id, family id and hash are required")
	}
	_, err := s.pool.Exec(ctx,
		"SELECT issue_refresh_token($1, $2, $3, $4, $5, $6, $7)",
		tokenID, familyID, accountID, userID, deviceID, tokenHash, expiresAt)
	return TranslateError(err)
}

// ConsumeRefreshToken atomically burns a refresh token and reports what it stood
// for. The consumption happens inside consume_refresh_token()'s conditional
// UPDATE, so two concurrent refreshes cannot both succeed.
func (s *Store) ConsumeRefreshToken(ctx context.Context, tokenHash string) (*RefreshTokenRecord, error) {
	var record RefreshTokenRecord
	err := s.pool.QueryRow(ctx, `
		SELECT token_id, family_id, account_id, user_id, device_id, was_used
		FROM consume_refresh_token($1)`, tokenHash,
	).Scan(&record.TokenID, &record.FamilyID, &record.AccountID, &record.UserID,
		&record.DeviceID, &record.WasUsed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, TranslateError(err)
	}
	return &record, nil
}

// RefreshTokenFamily reports the state of a token's chain, including for a token
// that has already been consumed or revoked.
func (s *Store) RefreshTokenFamily(ctx context.Context, tokenHash string) (*RefreshTokenFamily, error) {
	var family RefreshTokenFamily
	err := s.pool.QueryRow(ctx, `
		SELECT token_id, family_id, account_id, user_id, revoked, used, expired
		FROM refresh_token_family($1)`, tokenHash,
	).Scan(&family.TokenID, &family.FamilyID, &family.AccountID, &family.UserID,
		&family.Revoked, &family.Used, &family.Expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, TranslateError(err)
	}
	return &family, nil
}

// RevokeRefreshFamily revokes every token in a family and reports how many were
// affected, so the blast radius can be logged rather than assumed.
func (s *Store) RevokeRefreshFamily(ctx context.Context, familyID string) (int, error) {
	var revoked int
	if err := s.pool.QueryRow(ctx, "SELECT revoke_refresh_family($1)", familyID).Scan(&revoked); err != nil {
		return 0, TranslateError(err)
	}
	return revoked, nil
}

// RevokeUserRefreshTokens revokes every refresh token for a user, across devices.
func (s *Store) RevokeUserRefreshTokens(ctx context.Context, userID string) (int, error) {
	var revoked int
	if err := s.pool.QueryRow(ctx, "SELECT revoke_user_refresh_tokens($1)", userID).Scan(&revoked); err != nil {
		return 0, TranslateError(err)
	}
	return revoked, nil
}

// LookupUserForRefresh resolves the identity a refreshed session needs.
func (s *Store) LookupUserForRefresh(ctx context.Context, userID string) (*AuthenticatedIdentity, error) {
	var identity AuthenticatedIdentity
	var role, plan string
	err := s.pool.QueryRow(ctx, `
		SELECT id, account_id, email, name, role, account_name, plan
		FROM lookup_user_for_refresh($1)`, userID,
	).Scan(&identity.UserID, &identity.AccountID, &identity.Email, &identity.UserName,
		&role, &identity.AccountName, &plan)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, TranslateError(err)
	}
	identity.Role = UserRole(role)
	identity.Plan = AccountPlan(plan)
	return &identity, nil
}

// CountActiveRefreshTokens reports how many live tokens a user holds. Used by
// tests to assert that reuse detection actually revokes the chain instead of only
// the presented token.
func (s *Store) CountActiveRefreshTokens(ctx context.Context, userID string) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM refresh_tokens
		WHERE user_id = $1 AND revoked_at IS NULL AND used_at IS NULL AND expires_at > now()`,
		userID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count active refresh tokens: %w", err)
	}
	return count, nil
}
