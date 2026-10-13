package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/inajaf/dombook/server/internal/crypto"
	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// refreshTokenSeparator splits the family id from the secret in a refresh token.
//
// The family id travels in the token rather than being looked up first, so reuse
// detection works even for a token whose row has been consumed: the server can
// identify the family from the presented value alone, without a database lookup
// that would fail precisely because the row is already spent.
const refreshTokenSeparator = "."

// RefreshTokenStore is the persistence refresh-token rotation needs.
type RefreshTokenStore interface {
	IssueRefreshToken(ctx context.Context, tokenID, familyID, accountID, userID string, deviceID *string, tokenHash string, expiresAt time.Time) error
	ConsumeRefreshToken(ctx context.Context, tokenHash string) (*store.RefreshTokenRecord, error)
	RefreshTokenFamily(ctx context.Context, tokenHash string) (*store.RefreshTokenFamily, error)
	RevokeRefreshFamily(ctx context.Context, familyID string) (int, error)
	RevokeUserRefreshTokens(ctx context.Context, userID string) (int, error)
	LookupUserForRefresh(ctx context.Context, userID string) (*store.AuthenticatedIdentity, error)
}

// issueRefreshToken mints a refresh token and records its hash.
//
// The returned value is "<familyId>.<secret>". The secret is 32 bytes of entropy;
// the family id is not a secret and is carried in clear so that a replayed token
// can be attributed to its chain without a lookup.
func (s *Service) issueRefreshToken(ctx context.Context, user *store.User, deviceID *string, now time.Time) (string, error) {
	refreshStore, ok := s.store.(RefreshTokenStore)
	if !ok {
		return "", fmt.Errorf("auth: store does not support refresh tokens")
	}

	familyID, err := crypto.NewUUID()
	if err != nil {
		return "", err
	}
	return s.rotateRefreshToken(ctx, refreshStore, familyID, user.ID, user.AccountID, deviceID, now)
}

// rotateRefreshToken creates a new token inside an existing family.
func (s *Service) rotateRefreshToken(
	ctx context.Context,
	refreshStore RefreshTokenStore,
	familyID, userID, accountID string,
	deviceID *string,
	now time.Time,
) (string, error) {
	secret, err := crypto.RandomToken(32)
	if err != nil {
		return "", err
	}
	tokenID, err := crypto.NewUUID()
	if err != nil {
		return "", err
	}
	token := familyID + refreshTokenSeparator + secret

	expiresAt := now.Add(s.config.RefreshTTL)
	if err := refreshStore.IssueRefreshToken(
		ctx, tokenID, familyID, accountID, userID, deviceID, crypto.SHA256Hex(token), expiresAt,
	); err != nil {
		return "", err
	}
	return token, nil
}

// RefreshResult is the outcome of a token refresh.
type RefreshResult struct {
	Token        string   `json:"token"`
	RefreshToken string   `json:"refreshToken"`
	User         UserView `json:"user"`
	AccountID    string   `json:"accountId"`
	AccountName  string   `json:"accountName"`
	Plan         string   `json:"plan"`
	ExpiresAt    string   `json:"expiresAt"`
}

// Refresh exchanges a refresh token for a new access token and a new refresh
// token.
//
// Rotation with reuse detection: presenting a token that has already been consumed
// means either an attacker replayed a stolen value or a client double-submitted.
// Both revoke the entire family and all sessions for the user, because the cheap
// false positive — one forced re-login — is far preferable to leaving a stolen
// credential live.
func (s *Service) Refresh(ctx context.Context, presentedToken string) (*RefreshResult, error) {
	refreshStore, ok := s.store.(RefreshTokenStore)
	if !ok {
		return nil, fmt.Errorf("auth: store does not support refresh tokens")
	}
	token := strings.TrimSpace(presentedToken)
	if token == "" {
		return nil, httpapi.BadRequest("validation_error", "Укажите refresh-токен", nil)
	}

	// Identify the family before consuming, so a rejected token can still be
	// attributed to its chain.
	family, familyErr := refreshStore.RefreshTokenFamily(ctx, crypto.SHA256Hex(token))
	if familyErr != nil && !errors.Is(familyErr, store.ErrNotFound) {
		return nil, familyErr
	}

	record, err := refreshStore.ConsumeRefreshToken(ctx, crypto.SHA256Hex(token))
	switch {
	case err == nil:
		// Live token: the normal path.
	case errors.Is(err, store.ErrNotFound):
		// Unknown, expired, or revoked. If it belongs to a known family whose
		// token was already used, this is a replay.
		if family != nil && family.Used && !family.Revoked {
			revoked, revokeErr := refreshStore.RevokeRefreshFamily(ctx, family.FamilyID)
			if revokeErr != nil {
				slog.Error("revoke refresh family after reuse", "error", revokeErr, "familyId", family.FamilyID)
			}
			// Sessions are killed too: a replayed refresh token may already have
			// minted an access token, and revoking only the refresh chain would
			// leave that access token valid until it expired.
			if _, sessionErr := s.store.RevokeUserSessions(ctx, family.UserID); sessionErr != nil {
				slog.Error("revoke sessions after refresh reuse", "error", sessionErr, "userId", family.UserID)
			}
			slog.Warn("refresh token reuse detected; family revoked",
				"familyId", family.FamilyID, "userId", family.UserID, "tokensRevoked", revoked)
			return nil, httpapi.Unauthorized("Сессия недействительна: обнаружено повторное использование токена")
		}
		return nil, httpapi.Unauthorized("Сессия истекла, войдите заново")
	default:
		return nil, err
	}

	// Already used when read, or consumed by a concurrent request: same treatment
	// as a replay, since we cannot tell the two apart.
	if record.WasUsed {
		revoked, revokeErr := refreshStore.RevokeRefreshFamily(ctx, record.FamilyID)
		if revokeErr != nil {
			slog.Error("revoke refresh family after concurrent reuse", "error", revokeErr)
		}
		if _, sessionErr := s.store.RevokeUserSessions(ctx, record.UserID); sessionErr != nil {
			slog.Error("revoke sessions after concurrent reuse", "error", sessionErr)
		}
		slog.Warn("refresh token reuse detected (concurrent); family revoked",
			"familyId", record.FamilyID, "userId", record.UserID, "tokensRevoked", revoked)
		return nil, httpapi.Unauthorized("Сессия недействительна: обнаружено повторное использование токена")
	}

	now := s.config.Now()
	identity, err := refreshStore.LookupUserForRefresh(ctx, record.UserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, httpapi.Unauthorized("Учётная запись не найдена")
		}
		return nil, err
	}

	sessionID, err := crypto.NewUUID()
	if err != nil {
		return nil, err
	}
	expiresAt := now.Add(s.config.AccessTTL)
	if err := s.store.CreateSession(ctx, sessionID, identity.UserID, identity.AccountID, record.DeviceID, expiresAt); err != nil {
		return nil, err
	}

	accessToken, err := crypto.SignJWT(crypto.Claims{
		Subject:   identity.UserID,
		Account:   identity.AccountID,
		Role:      string(identity.Role),
		Email:     identity.Email,
		SessionID: sessionID,
	}, s.config.JWTSecret, s.config.AccessTTL, now)
	if err != nil {
		return nil, err
	}

	// The successor stays in the same family so a later reuse anywhere in the
	// chain still revokes every descendant.
	newRefreshToken, err := s.rotateRefreshToken(
		ctx, refreshStore, record.FamilyID, identity.UserID, identity.AccountID, record.DeviceID, now)
	if err != nil {
		return nil, err
	}

	return &RefreshResult{
		Token:        accessToken,
		RefreshToken: newRefreshToken,
		User: UserView{
			ID: identity.UserID, Email: identity.Email, Name: identity.UserName, Role: string(identity.Role),
		},
		AccountID:   identity.AccountID,
		AccountName: identity.AccountName,
		Plan:        string(identity.Plan.Effective()),
		ExpiresAt:   expiresAt.UTC().Format(time.RFC3339),
	}, nil
}
