package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/inajaf/dombook/server/internal/crypto"
)

// ErrNotFound is returned when a lookup matches no row. It is distinct from an
// empty result so callers can answer 404 without inspecting pgx error types.
var ErrNotFound = errors.New("store: not found")

// NewID returns a fresh UUID for a row about to be inserted. The id is generated
// by the application rather than by the database default so that a client can be
// told the id before the transaction commits — which sync depends on, since an
// offline client must be able to reference a row it has not yet pushed.
func NewID() (string, error) {
	return crypto.NewUUID()
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

// CountUsers returns the number of user rows across all tenants.
//
// This decides whether the bootstrap /auth/setup endpoint is still open, which is
// a question about the whole installation rather than one tenant — and it is asked
// before any tenant context exists. Under the tenant-scoped users policy an
// unauthenticated connection sees zero rows, so a plain count would report an
// empty installation forever and leave signup permanently open. Hence the
// elevated count function, which returns a number and nothing else.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, "SELECT count_users_for_bootstrap()").Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count users: %w", err)
	}
	return count, nil
}

// CreateAccountWithOwner creates an account and its first owner atomically.
//
// Signup is the one flow that runs with no tenant context at all: the account
// being created becomes the tenant, and its owner is the credential that will
// authenticate against it. Neither insert can satisfy a tenant-scoped policy, so
// both happen inside bootstrap_account(), the narrow SECURITY DEFINER exception
// documented in migrations/20260811000004_bootstrap_functions.sql. Keeping them in
// one statement is what prevents a half-created account that nobody can log into.
func (s *Store) CreateAccountWithOwner(
	ctx context.Context,
	name string,
	email, userName string,
	plan AccountPlan,
) (*Account, *User, error) {
	if plan == "" {
		plan = PlanFree
	}
	if !plan.Known() {
		return nil, nil, fmt.Errorf("create account: unknown plan %q", plan)
	}

	accountID, err := NewID()
	if err != nil {
		return nil, nil, err
	}
	userID, err := NewID()
	if err != nil {
		return nil, nil, err
	}

	var account Account
	var user User
	var policyJSON []byte
	var scannedPlan, scannedRole string
	err = s.pool.QueryRow(ctx, `
		SELECT account_id, account_name, plan, booking_policy, created_at, updated_at,
		       user_id, user_email, user_name, user_role
		FROM bootstrap_account($1, $2, $3, $4, $5, $6)`,
		accountID, name, string(plan), userID, email, userName,
	).Scan(&account.ID, &account.Name, &scannedPlan, &policyJSON, &account.CreatedAt, &account.UpdatedAt,
		&user.ID, &user.Email, &user.Name, &scannedRole)
	if err != nil {
		return nil, nil, TranslateError(err)
	}

	account.Plan = AccountPlan(scannedPlan)
	account.BookingPolicy = decodeBookingPolicy(policyJSON)
	user.AccountID = account.ID
	user.Role = UserRole(scannedRole)
	return &account, &user, nil
}

// GetAccountByID loads an account for a given tenant.
//
// The accounts policy authorizes a row only when its id equals the current
// tenant, so the lookup sets that tenant context first. Callers that genuinely
// need to read an arbitrary account (platform admin, sync bootstrap) go through
// the admin connection instead of widening this.
func (s *Store) GetAccountByID(ctx context.Context, accountID string) (*Account, error) {
	var account Account
	var policyJSON []byte
	err := s.WithTenant(ctx, accountID, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			SELECT id, name, plan, booking_policy, created_at, updated_at
			FROM accounts WHERE id = $1`, accountID)
		return scanAccount(row, &account, &policyJSON)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	account.BookingPolicy = decodeBookingPolicy(policyJSON)
	return &account, nil
}

// UpdateAccountPlan changes the subscription tier.
func (s *Store) UpdateAccountPlan(ctx context.Context, accountID string, plan AccountPlan) (*Account, error) {
	if !plan.Known() {
		return nil, fmt.Errorf("update plan: unknown plan %q", plan)
	}

	var account Account
	var policyJSON []byte
	err := s.WithTenant(ctx, accountID, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			UPDATE accounts SET plan = $2, updated_at = now()
			WHERE id = $1
			RETURNING id, name, plan, booking_policy, created_at, updated_at`,
			accountID, string(plan))
		return scanAccount(row, &account, &policyJSON)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, TranslateError(err)
	}
	account.BookingPolicy = decodeBookingPolicy(policyJSON)
	return &account, nil
}

// UpdateBookingPolicy replaces the account's booking window.
func (s *Store) UpdateBookingPolicy(ctx context.Context, accountID string, policy BookingPolicyConfig) (*Account, error) {
	encoded, err := json.Marshal(policy)
	if err != nil {
		return nil, fmt.Errorf("encode booking policy: %w", err)
	}

	var account Account
	var policyJSON []byte
	err = s.WithTenant(ctx, accountID, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			UPDATE accounts SET booking_policy = $2::jsonb, updated_at = now()
			WHERE id = $1
			RETURNING id, name, plan, booking_policy, created_at, updated_at`,
			accountID, string(encoded))
		return scanAccount(row, &account, &policyJSON)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, TranslateError(err)
	}
	account.BookingPolicy = decodeBookingPolicy(policyJSON)
	return &account, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAccount(row rowScanner, account *Account, policyJSON *[]byte) error {
	var plan string
	if err := row.Scan(&account.ID, &account.Name, &plan, policyJSON,
		&account.CreatedAt, &account.UpdatedAt); err != nil {
		return err
	}
	account.Plan = AccountPlan(plan)
	return nil
}

// decodeBookingPolicy turns the stored jsonb into the typed config. A malformed
// or absent policy yields the zero config, whose fields are pointers: the caller
// fills the gaps from the compiled defaults, so a bad stored value degrades to
// the shipped policy instead of locking the account out of booking.
func decodeBookingPolicy(raw []byte) BookingPolicyConfig {
	var policy BookingPolicyConfig
	if len(raw) == 0 {
		return policy
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		return BookingPolicyConfig{}
	}
	return policy
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

// AddUserToAccount attaches an identity to an existing account.
//
// Unlike signup, this runs when an identity already exists and has authenticated
// — accepting an invite — so a tenant context is available and the users RLS
// policy authorizes the insert. That is why it does not need a SECURITY DEFINER
// function, and why the tenant context is required rather than optional: an insert
// with no tenant set would fail the policy, which is the intended outcome.
func (s *Store) AddUserToAccount(ctx context.Context, userID, tenantID, email, name string, role UserRole) (*User, error) {
	var user User
	var scannedRole string
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO users(id, account_id, email, name, role) VALUES ($1, $2, $3, $4, $5)
			RETURNING id, account_id, email, name, role, created_at, updated_at`,
			userID, tenantID, email, name, string(role),
		).Scan(&user.ID, &user.AccountID, &user.Email, &user.Name, &scannedRole,
			&user.CreatedAt, &user.UpdatedAt)
	})
	if err != nil {
		return nil, TranslateError(err)
	}
	user.Role = UserRole(scannedRole)
	return &user, nil
}

// GetUserByEmail looks up an identity by email.
//
// The login flow needs this before a session exists, so it cannot pass the users
// RLS policy. lookup_user_for_login() is the SECURITY DEFINER exception; it
// requires an exact email and returns the single matching row.
func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, account_id, email, name, role, created_at, updated_at
		FROM lookup_user_for_login($1)`, email)
	return scanUser(row)
}

// GetUserByID looks up an identity by id.
func (s *Store) GetUserByID(ctx context.Context, userID string) (*User, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, account_id, email, name, role, created_at, updated_at
		FROM users WHERE id = $1`, userID)
	return scanUser(row)
}

func scanUser(row rowScanner) (*User, error) {
	var user User
	var role string
	err := row.Scan(&user.ID, &user.AccountID, &user.Email, &user.Name, &role,
		&user.CreatedAt, &user.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	user.Role = UserRole(role)
	return &user, nil
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

// CreateSession records an issued access token.
//
// The client is not authenticated yet — this call IS the authentication — so no
// tenant context exists. create_auth_session() is the bounded SECURITY DEFINER
// exception; see migrations/20260811000005_auth_flow_functions.sql.
func (s *Store) CreateSession(ctx context.Context, sessionID, userID, accountID string, deviceID *string, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx,
		"SELECT create_auth_session($1, $2, $3, $4, $5)",
		sessionID, userID, accountID, deviceID, expiresAt)
	return TranslateError(err)
}

// AuthenticatedIdentity is the result of resolving a session token.
type AuthenticatedIdentity struct {
	SessionID   string
	UserID      string
	AccountID   string
	Role        UserRole
	Email       string
	UserName    string
	AccountName string
	Plan        AccountPlan
	ExpiresAt   time.Time
}

// ResolveSessionToken resolves a jti into the identity behind it.
//
// The account id is an OUTPUT of this call, so it cannot be an input to a tenant
// policy: this is the one place where the session table must be read without a
// tenant context. lookup_session_for_auth() returns live sessions only, so a
// revoked or expired token yields ErrNotFound.
func (s *Store) ResolveSessionToken(ctx context.Context, sessionID string) (*AuthenticatedIdentity, error) {
	var identity AuthenticatedIdentity
	var role, plan string
	err := s.pool.QueryRow(ctx, `
		SELECT session_id, user_id, account_id, role, email, user_name, account_name, plan, expires_at
		FROM lookup_session_for_auth($1)`, sessionID,
	).Scan(&identity.SessionID, &identity.UserID, &identity.AccountID, &role,
		&identity.Email, &identity.UserName, &identity.AccountName, &plan, &identity.ExpiresAt)
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

// RevokeSession revokes one session by jti. Revoking an already-revoked session is
// a no-op rather than an error, so a repeated logout does not surface a failure.
func (s *Store) RevokeSession(ctx context.Context, sessionID string) error {
	var revoked bool
	err := s.pool.QueryRow(ctx, "SELECT revoke_auth_session($1)", sessionID).Scan(&revoked)
	if err != nil {
		return TranslateError(err)
	}
	return nil
}

// RevokeUserSessions revokes every active session for a user, across devices.
func (s *Store) RevokeUserSessions(ctx context.Context, userID string) (int64, error) {
	var revoked int
	if err := s.pool.QueryRow(ctx, "SELECT revoke_user_sessions($1)", userID).Scan(&revoked); err != nil {
		return 0, TranslateError(err)
	}
	return int64(revoked), nil
}

// ---------------------------------------------------------------------------
// Verification codes (one-time login codes)
// ---------------------------------------------------------------------------

// CreateVerificationCode stores a hashed login code.
//
// Issuing a code happens before authentication, so the verification_codes table
// has no policy at all and is reachable only through issue_login_code().
func (s *Store) CreateVerificationCode(ctx context.Context, codeID, email, codeHash string, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx,
		"SELECT issue_login_code($1, $2, $3, $4)", codeID, email, codeHash, expiresAt)
	return TranslateError(err)
}

// ConsumeVerificationCode atomically validates and burns a login code.
//
// Single-use under concurrency is enforced inside consume_login_code(): the
// UPDATE's "used_at IS NULL" predicate means two simultaneous verifications
// cannot both match. Splitting this into SELECT-then-UPDATE would allow a replay.
func (s *Store) ConsumeVerificationCode(ctx context.Context, email, codeHash string) (bool, error) {
	var consumed bool
	err := s.pool.QueryRow(ctx, "SELECT consume_login_code($1, $2)", email, codeHash).Scan(&consumed)
	if err != nil {
		return false, TranslateError(err)
	}
	return consumed, nil
}

// CountRecentCodes returns how many codes were issued for an email since the
// given instant. Backs the /auth/send rate limit: without it, an unauthenticated
// caller could make the server mail an address repeatedly.
func (s *Store) CountRecentCodes(ctx context.Context, email string, since time.Time) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, "SELECT count_recent_login_codes($1, $2)", email, since).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count recent codes: %w", err)
	}
	return count, nil
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

// ListUsersForAccount returns the people who may sign in to an account.
//
// Runs under RLS: the users policy filters on current_tenant_id(), so an account can only ever
// see its own members — there is no WHERE clause here to forget, and a second account's rows are
// not merely filtered out but invisible to the query.
func (s *Store) ListUsersForAccount(ctx context.Context, accountID string) ([]User, error) {
	users := []User{}
	err := s.WithTenant(ctx, accountID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, account_id, email, name, role, created_at, updated_at
			FROM users
			ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var user User
			var role string
			if err := rows.Scan(&user.ID, &user.AccountID, &user.Email, &user.Name, &role, &user.CreatedAt, &user.UpdatedAt); err != nil {
				return err
			}
			user.Role = UserRole(role)
			users = append(users, user)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return users, nil
}

// CreateInvite stores a pending invitation.
//
// The invited email typically has no user row yet, so the insert cannot be
// authorized by the users policy. It is authorized by the inviter's role, which
// the handler checks before calling, and create_login_invite() enforces that the
// granted role is never owner — an invite that could grant owner would be a
// privilege-escalation path.
func (s *Store) CreateInvite(ctx context.Context, inviteID, accountID, email string, role UserRole, tokenHash, createdBy string, expiresAt time.Time) (*Invite, error) {
	var invite Invite
	var scannedRole, status string
	err := s.pool.QueryRow(ctx, `
		SELECT id, account_id, email, role, status, expires_at, created_at
		FROM create_login_invite($1, $2, $3, $4, $5, $6, $7)`,
		inviteID, accountID, email, string(role), tokenHash, createdBy, expiresAt,
	).Scan(&invite.ID, &invite.AccountID, &invite.Email, &scannedRole, &status,
		&invite.ExpiresAt, &invite.CreatedAt)
	if err != nil {
		return nil, TranslateError(err)
	}
	invite.Role = UserRole(scannedRole)
	invite.Status = status
	invite.TokenHash = tokenHash
	invite.CreatedBy = createdBy
	return &invite, nil
}

// GetPendingInvite finds an unexpired pending invitation for an email.
//
// Called from /auth/send and /auth/verify, i.e. before the invited person has any
// session, so it runs through lookup_pending_invite() rather than under a tenant
// policy it could not satisfy.
func (s *Store) GetPendingInvite(ctx context.Context, email string) (*Invite, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, account_id, email, role, token_hash, created_by, status, expires_at, created_at
		FROM lookup_pending_invite($1)`, email)

	var invite Invite
	var role, status string
	err := row.Scan(&invite.ID, &invite.AccountID, &invite.Email, &role, &invite.TokenHash,
		&invite.CreatedBy, &status, &invite.ExpiresAt, &invite.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	invite.Role = UserRole(role)
	invite.Status = status
	return &invite, nil
}

// FindPendingInvite reports whether an account already has a live invitation for an address.
//
// Distinct from GetPendingInvite, which looks up an invitation across the whole database so
// the login flow can accept one before the user belongs to any account. This one is
// tenant-scoped, because an account asking "have I already invited them" must not see, or be
// influenced by, another account's invitation to the same person.
func (s *Store) FindPendingInvite(ctx context.Context, tenantID, email string) (*Invite, error) {
	var invite *Invite
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			SELECT id, account_id, email, role, token_hash, created_by, status, expires_at, created_at, updated_at
			FROM invites
			WHERE email = $1 AND status = 'pending' AND deleted_at IS NULL
			LIMIT 1`, email)

		var found Invite
		var role, status string
		scanErr := row.Scan(&found.ID, &found.AccountID, &found.Email, &role, &found.TokenHash,
			&found.CreatedBy, &status, &found.ExpiresAt, &found.CreatedAt, &found.UpdatedAt)
		if errors.Is(scanErr, pgx.ErrNoRows) {
			return nil
		}
		if scanErr != nil {
			return scanErr
		}
		found.Role = UserRole(role)
		found.Status = status
		invite = &found
		return nil
	})
	if err != nil {
		return nil, TranslateError(err)
	}
	return invite, nil
}

// AcceptInvite marks an invitation accepted within the inviting account's tenant
// context.
//
// The caller supplies the account because the accepting user may not have been a
// member yet when the invite was read. The status = 'pending' guard makes a
// double-acceptance a no-op instead of a second join.
func (s *Store) AcceptInvite(ctx context.Context, tenantID, inviteID string) error {
	return s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE invites SET status = 'accepted', updated_at = now()
			WHERE id = $1 AND status = 'pending'`, inviteID)
		if err != nil {
			return TranslateError(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// ListInvites returns invitations for a tenant.
func (s *Store) ListInvites(ctx context.Context, tenantID string) ([]Invite, error) {
	var invites []Invite
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, account_id, email, role, token_hash, created_by, status, expires_at, created_at, updated_at
			FROM invites WHERE deleted_at IS NULL ORDER BY created_at DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			var invite Invite
			var role, status string
			if err := rows.Scan(&invite.ID, &invite.AccountID, &invite.Email, &role,
				&invite.TokenHash, &invite.CreatedBy, &status, &invite.ExpiresAt,
				&invite.CreatedAt, &invite.UpdatedAt); err != nil {
				return err
			}
			invite.Role = UserRole(role)
			invite.Status = status
			invites = append(invites, invite)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return invites, nil
}

// RevokeInvite marks an invitation revoked.
func (s *Store) RevokeInvite(ctx context.Context, tenantID, inviteID string) error {
	return s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE invites SET status = 'revoked', updated_at = now()
			WHERE id = $1 AND status = 'pending'`, inviteID)
		if err != nil {
			return TranslateError(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}
