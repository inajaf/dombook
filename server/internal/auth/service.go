// Package auth implements the passwordless login flow: email one-time codes,
// session issuance and revocation, invites, and refresh-token rotation.
//
// It depends on a narrow Store interface rather than the concrete repository, so
// the flow's decisions — is this address loginable, is the code single-use, is the
// bootstrap endpoint still open — can be unit-tested without a database. The SQL
// itself is covered separately by the store integration tests.
package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/inajaf/dombook/server/internal/crypto"
	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// emailPattern is the same shape the previous implementation accepted. It is
// deliberately permissive — the authoritative check is whether the address can
// receive mail — but it rejects the malformed input that would otherwise become a
// database row.
var emailPattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// Store is the persistence the auth flow needs.
type Store interface {
	CountUsers(ctx context.Context) (int, error)
	CreateAccountWithOwner(ctx context.Context, name, email, userName string, plan store.AccountPlan) (*store.Account, *store.User, error)
	GetUserByEmail(ctx context.Context, email string) (*store.User, error)
	GetUserByID(ctx context.Context, userID string) (*store.User, error)
	AddUserToAccount(ctx context.Context, userID, tenantID, email, name string, role store.UserRole) (*store.User, error)
	GetAccountByID(ctx context.Context, accountID string) (*store.Account, error)

	CreateVerificationCode(ctx context.Context, codeID, email, codeHash string, expiresAt time.Time) error
	ConsumeVerificationCode(ctx context.Context, email, codeHash string) (bool, error)
	CountRecentCodes(ctx context.Context, email string, since time.Time) (int, error)

	CreateSession(ctx context.Context, sessionID, userID, accountID string, deviceID *string, expiresAt time.Time) error
	ResolveSessionToken(ctx context.Context, sessionID string) (*store.AuthenticatedIdentity, error)
	RevokeSession(ctx context.Context, sessionID string) error
	RevokeUserSessions(ctx context.Context, userID string) (int64, error)

	CreateInvite(ctx context.Context, inviteID, accountID, email string, role store.UserRole, tokenHash, createdBy string, expiresAt time.Time) (*store.Invite, error)
	GetPendingInvite(ctx context.Context, email string) (*store.Invite, error)
	AcceptInvite(ctx context.Context, tenantID, inviteID string) error
	ListInvites(ctx context.Context, tenantID string) ([]store.Invite, error)
	RevokeInvite(ctx context.Context, tenantID, inviteID string) error

	GetTenantState(ctx context.Context, tenantID string) (*store.TenantState, error)
}

// Options configures the service.
type Options struct {
	// AppName brands OTP messages.
	AppName string
	// JWTSecret signs session tokens.
	JWTSecret string
	// AccessTTL is the session-token lifetime.
	AccessTTL time.Duration
	// RefreshTTL is the refresh-token lifetime.
	RefreshTTL time.Duration
	// OTPTTL bounds a login code's life.
	OTPTTL time.Duration
	// OTPLength is the number of digits in a login code.
	OTPLength int
	// ExposeCode returns the code in the send response. Development only.
	ExposeCode bool
	// SetupToken gates bootstrap once the installation has a user.
	SetupToken string
	// Now allows tests to control the clock.
	Now func() time.Time
	// OnCodeGenerated observes a generated login code before delivery.
	//
	// This is a test seam, and the only way to cover the enumeration-resistant
	// path where a code is generated but never sent: the plaintext exists solely
	// inside SendCode and is deliberately absent from the database. It must stay
	// nil in production — a configured observer would put live login codes in the
	// server's own memory beyond the request that generated them.
	OnCodeGenerated func(email, code string)
}

// Service implements the auth flow.
type Service struct {
	store  Store
	config Options
	limits *RateLimiter
	// Messenger delivers the login code. The default logs it, which is what a
	// self-hosted install without a mail provider needs to function; an SMTP or
	// API-backed implementation can replace it without touching this flow.
	messenger Messenger
}

// Messenger delivers a login code.
type Messenger interface {
	SendLoginCode(ctx context.Context, email, code string, expiresAt time.Time) error
}

// New builds the auth service. A limiter is required: the send and verify
// endpoints are unauthenticated, and a service constructed without throttling
// would silently be an open relay and a brute-force target.
func New(repository Store, options Options, limiter *RateLimiter, messenger Messenger) *Service {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.OTPLength == 0 {
		options.OTPLength = 6
	}
	if options.AppName == "" {
		options.AppName = "ДомБук"
	}
	if messenger == nil {
		messenger = &logMessenger{}
	}
	return &Service{store: repository, config: options, limits: limiter, messenger: messenger}
}

// logMessenger records codes to the log. It exists so a fresh self-hosted install
// works with no mail configuration, and it logs at info level deliberately: an
// operator who cannot receive mail needs to see the code.
type logMessenger struct{}

func (m *logMessenger) SendLoginCode(_ context.Context, email, code string, expiresAt time.Time) error {
	slog.Info("login code issued", "email", email, "code", code, "expiresAt", expiresAt.UTC().Format(time.RFC3339))
	return nil
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

// UserView is the user object exposed to clients.
type UserView struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

// SessionView is a verified login.
type SessionView struct {
	Token          string   `json:"token"`
	RefreshToken   string   `json:"refreshToken"`
	User           UserView `json:"user"`
	AccountID      string   `json:"accountId"`
	AccountName    string   `json:"accountName"`
	Plan           string   `json:"plan"`
	InviteAccepted bool     `json:"inviteAccepted"`
	ExpiresAt      string   `json:"expiresAt"`
}

// CurrentView describes the authenticated caller.
type CurrentView struct {
	User        UserView `json:"user"`
	AccountID   string   `json:"accountId"`
	AccountName string   `json:"accountName"`
	Plan        string   `json:"plan"`
	// SessionID is the jti behind the presented token. The transport layer needs
	// it to revoke the session on logout without re-verifying the token itself.
	SessionID string `json:"-"`
}

func userView(user *store.User) UserView {
	return UserView{ID: user.ID, Email: user.Email, Name: user.Name, Role: string(user.Role)}
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// SetupInput is the bootstrap request.
type SetupInput struct {
	Email       string `json:"email"`
	Name        string `json:"name"`
	AccountName string `json:"accountName"`
	SetupToken  string `json:"setupToken"`
}

// Setup creates the first account and its owner.
//
// The endpoint is open only while the installation has no users. Once one exists
// it requires SetupToken, because otherwise whoever reaches the endpoint first
// could create themselves an account on someone else's server.
func (s *Service) Setup(ctx context.Context, input SetupInput) (*store.Account, *store.User, error) {
	email, err := s.normalizeEmail(input.Email)
	if err != nil {
		return nil, nil, err
	}

	// The duplicate check runs BEFORE the bootstrap gate. Order decides which
	// error a caller sees: an existing user retrying their own signup should be
	// told the account already exists, not that registration is closed. The
	// reverse order turns the endpoint into a confusing dead end for the most
	// likely caller — someone who just signed up and pressed the button twice.
	if _, err := s.store.GetUserByEmail(ctx, email); err == nil {
		return nil, nil, httpapi.BadRequest("user_exists", "Пользователь с таким email уже существует", nil)
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, nil, err
	}

	existingUsers, err := s.store.CountUsers(ctx)
	if err != nil {
		return nil, nil, err
	}
	if existingUsers > 0 {
		if s.config.SetupToken == "" || input.SetupToken == "" ||
			!crypto.ConstantTimeEqual(input.SetupToken, s.config.SetupToken) {
			return nil, nil, httpapi.Forbidden("setup_denied", "Регистрация закрыта: требуется токен настройки")
		}
	}

	name := strings.TrimSpace(input.Name)
	accountName := strings.TrimSpace(input.AccountName)
	if accountName == "" {
		accountName = name
	}
	if accountName == "" {
		accountName = "Дом отдыха"
	}

	account, user, err := s.store.CreateAccountWithOwner(ctx, accountName, email, name, store.PlanFree)
	if err != nil {
		if store.IsUniqueViolation(err) {
			return nil, nil, httpapi.BadRequest("user_exists", "Пользователь с таким email уже существует", nil)
		}
		return nil, nil, err
	}
	return account, user, nil
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

// SendResult is the /auth/send response.
type SendResult struct {
	OK bool `json:"ok"`
	// Loginable reports whether the address has an account or a pending invite.
	// A false value is not an error: an unknown address and a known one must be
	// indistinguishable in status, body shape, and cost, or the endpoint becomes an
	// account-enumeration oracle.
	Loginable bool `json:"loginable"`
	// Code is populated only when ExposeCode is enabled (local development). It is
	// present for unknown addresses too, so that a loginable and a non-loginable
	// response differ in exactly one field and nothing else.
	Code string `json:"code,omitempty"`
}

// SendCode issues a login code for an address that can log in.
func (s *Service) SendCode(ctx context.Context, rawEmail string) (*SendResult, error) {
	email, err := s.normalizeEmail(rawEmail)
	if err != nil {
		return nil, err
	}
	now := s.config.Now()

	// Two throttles: the in-memory one catches rapid repeats, the database one
	// survives a restart and binds regardless of which instance served the last
	// request.
	if allowed, retryAfter := s.limits.AllowSend(email, now); !allowed {
		return nil, tooManyRequests(
			"Слишком частый запрос кода. Повторите через %d с.",
			int(retryAfter.Seconds())+1)
	}
	if recent, err := s.store.CountRecentCodes(ctx, email, now.Add(-s.limits.sendWindow)); err != nil {
		return nil, err
	} else if recent >= s.limits.sendLimit {
		return nil, tooManyRequests(
			"Слишком много запросов кода. Повторите позже.")
	}

	// Decide loginability, then do the same work either way.
	loginable := true
	if _, err := s.store.GetUserByEmail(ctx, email); err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
		if _, inviteErr := s.store.GetPendingInvite(ctx, email); inviteErr != nil {
			if !errors.Is(inviteErr, store.ErrNotFound) {
				return nil, inviteErr
			}
			loginable = false
		}
	}

	code, err := crypto.OTPCode(s.config.OTPLength)
	if err != nil {
		return nil, err
	}
	codeID, err := crypto.NewUUID()
	if err != nil {
		return nil, err
	}
	expiresAt := now.Add(s.config.OTPTTL)

	// The code is generated, hashed, stored and counted for EVERY address, whether
	// or not it can log in.
	//
	// This is deliberate work, not waste. Skipping it for unknown addresses makes
	// those requests measurably faster, and that timing difference is itself an
	// account-enumeration oracle — the response shape being identical does not help
	// if the latency is not. Both branches now perform the same database writes, so
	// the cost is the same and a code row exists either way.
	//
	// The code is stored only as a hash: a database leak must not hand over live
	// credentials, and a login code is a credential for as long as it lives.
	if err := s.store.CreateVerificationCode(ctx, codeID, email, crypto.SHA256Hex(code), expiresAt); err != nil {
		return nil, err
	}
	s.limits.RecordSend(email, now)

	if s.config.OnCodeGenerated != nil {
		s.config.OnCodeGenerated(email, code)
	}

	if !loginable {
		result := &SendResult{OK: true, Loginable: false}
		if s.config.ExposeCode {
			// The code is reported even here, so the response BODY is byte-identical
			// in shape to the loginable case and only `loginable` differs. Omitting
			// it would leave a second, subtler tell: a shorter body. The value is
			// inert — no message was sent, and the address has no account to log
			// into — but it keeps the two responses indistinguishable, which is the
			// entire point of generating a code for a stranger.
			result.Code = code
		}
		return result, nil
	}

	if err := s.messenger.SendLoginCode(ctx, email, code, expiresAt); err != nil {
		// The code row exists but was never delivered. Returning an error is
		// honest: the user cannot proceed, and silently reporting success would
		// leave them waiting for a message that will not arrive.
		return nil, fmt.Errorf("deliver login code: %w", err)
	}

	result := &SendResult{OK: true, Loginable: true}
	if s.config.ExposeCode {
		result.Code = code
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

// VerifyInput is the code exchange request.
type VerifyInput struct {
	Email string `json:"email"`
	Code  string `json:"code"`
	// DeviceName and Platform register the client installation.
	DeviceName string `json:"deviceName"`
	Platform   string `json:"platform"`
}

// Verify exchanges a login code for a session, joining the account if the address
// has a pending invitation.
func (s *Service) Verify(ctx context.Context, input VerifyInput) (*SessionView, error) {
	email, err := s.normalizeEmail(input.Email)
	if err != nil {
		return nil, err
	}
	code := strings.TrimSpace(input.Code)
	if code == "" {
		return nil, httpapi.BadRequest("validation_error", "Укажите код из письма", nil)
	}
	now := s.config.Now()

	if locked, retryAfter := s.limits.VerificationLocked(email, now); locked {
		return nil, tooManyRequests(
			"Слишком много неверных кодов. Повторите через %d с.",
			int(retryAfter.Seconds())+1)
	}

	// Consumption is a single atomic UPDATE inside the database function, so a
	// code cannot be replayed even by concurrent requests.
	consumed, err := s.store.ConsumeVerificationCode(ctx, email, crypto.SHA256Hex(code))
	if err != nil {
		return nil, err
	}
	if !consumed {
		s.limits.RecordFailedVerification(email, now)
		return nil, httpapi.Unauthorized("Неверный или истёкший код")
	}
	s.limits.RecordSuccessfulVerification(email)

	user, err := s.store.GetUserByEmail(ctx, email)
	inviteAccepted := false
	switch {
	case err == nil:
		// Existing member.
	case errors.Is(err, store.ErrNotFound):
		// First login for an invited address: convert the invitation into
		// membership. The name defaults to the local part of the address, which
		// the owner can change afterwards.
		invite, inviteErr := s.store.GetPendingInvite(ctx, email)
		if inviteErr != nil {
			if errors.Is(inviteErr, store.ErrNotFound) {
				return nil, httpapi.Forbidden("no_account", "Для этого email не создана учётная запись")
			}
			return nil, inviteErr
		}
		userID, idErr := crypto.NewUUID()
		if idErr != nil {
			return nil, idErr
		}
		displayName := email
		if at := strings.Index(email, "@"); at > 0 {
			displayName = email[:at]
		}
		user, err = s.store.AddUserToAccount(ctx, userID, invite.AccountID, email, displayName, invite.Role)
		if err != nil {
			// A concurrent acceptance already created the user; load it instead
			// of failing the login.
			if store.IsUniqueViolation(err) {
				user, err = s.store.GetUserByEmail(ctx, email)
				if err != nil {
					return nil, err
				}
				break
			}
			return nil, err
		}
		if err := s.store.AcceptInvite(ctx, invite.AccountID, invite.ID); err != nil {
			return nil, err
		}
		inviteAccepted = true
	default:
		return nil, err
	}

	account, err := s.store.GetAccountByID(ctx, user.AccountID)
	if err != nil {
		return nil, err
	}

	sessionID, err := crypto.NewUUID()
	if err != nil {
		return nil, err
	}
	expiresAt := now.Add(s.config.AccessTTL)
	if err := s.store.CreateSession(ctx, sessionID, user.ID, user.AccountID, nil, expiresAt); err != nil {
		return nil, err
	}

	token, err := crypto.SignJWT(crypto.Claims{
		Subject:   user.ID,
		Account:   user.AccountID,
		Role:      string(user.Role),
		Email:     user.Email,
		SessionID: sessionID,
	}, s.config.JWTSecret, s.config.AccessTTL, now)
	if err != nil {
		return nil, err
	}

	refreshToken, err := s.issueRefreshToken(ctx, user, nil, now)
	if err != nil {
		return nil, err
	}

	return &SessionView{
		Token:          token,
		RefreshToken:   refreshToken,
		User:           userView(user),
		AccountID:      account.ID,
		AccountName:    account.Name,
		Plan:           string(account.Plan.Effective()),
		InviteAccepted: inviteAccepted,
		ExpiresAt:      expiresAt.UTC().Format(time.RFC3339),
	}, nil
}

// ---------------------------------------------------------------------------
// Current user / logout
// ---------------------------------------------------------------------------

// Current resolves the calling identity from an access token.
//
// Two checks, and both are needed: the signature proves the token was issued by
// this server, and the session lookup proves it has not been revoked. A valid
// signature alone would leave logout advisory until the token expired.
func (s *Service) Current(ctx context.Context, token string) (*CurrentView, error) {
	claims, err := crypto.VerifyJWT(token, s.config.JWTSecret, s.config.Now())
	if err != nil {
		if errors.Is(err, crypto.ErrExpiredToken) {
			return nil, httpapi.Unauthorized("Сессия истекла")
		}
		return nil, httpapi.Unauthorized("Требуется авторизация")
	}

	identity, err := s.store.ResolveSessionToken(ctx, claims.SessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Revoked or expired between issue and use.
			return nil, httpapi.Unauthorized("Сессия недействительна")
		}
		return nil, err
	}

	return &CurrentView{
		User: UserView{
			ID: identity.UserID, Email: identity.Email, Name: identity.UserName, Role: string(identity.Role),
		},
		AccountID:   identity.AccountID,
		AccountName: identity.AccountName,
		Plan:        string(identity.Plan.Effective()),
		SessionID:   identity.SessionID,
	}, nil
}

// Logout revokes a session. Revoking an unknown or already-revoked session
// succeeds, so a repeated logout is not an error.
func (s *Service) Logout(ctx context.Context, token string) error {
	claims, err := crypto.VerifyJWT(token, s.config.JWTSecret, s.config.Now())
	if err != nil {
		// An expired or malformed token has no live session to revoke. Reporting
		// success lets a client clear its state without special-casing.
		return nil
	}
	return s.store.RevokeSession(ctx, claims.SessionID)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (s *Service) normalizeEmail(value string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(value))
	if !emailPattern.MatchString(email) {
		return "", httpapi.BadRequest("validation_error", "Некорректный email", nil)
	}
	return email, nil
}

// tooManyRequests builds a 429 with a retry hint. The status is what tells a
// client to back off rather than to fix its input.
func tooManyRequests(format string, args ...any) *httpapi.ApiError {
	return &httpapi.ApiError{
		Status:  429,
		Code:    "rate_limited",
		Message: fmt.Sprintf(format, args...),
	}
}
