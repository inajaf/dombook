package auth

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// fakeStore is an in-memory Store. It exists so the flow's decisions — bootstrap
// gating, enumeration resistance, single-use codes, lockout, invite conversion —
// can be tested exhaustively without a database. SQL correctness is covered
// separately by the store integration tests.
type fakeStore struct {
	mu sync.Mutex

	// now is the harness clock. All expiry decisions use it, so tests can move
	// time without sleeping and still exercise real expiry logic.
	now func() time.Time

	users       map[string]*store.User // by email
	usersByID   map[string]*store.User
	accounts    map[string]*store.Account
	codes       []fakeCode
	sessions    map[string]fakeSession
	invites     []*store.Invite
	refresh     map[string]*fakeRefresh // by token hash
	nextErr     error
	accountName string
}

type fakeCode struct {
	id        string
	email     string
	hash      string
	expiresAt time.Time
	used      bool
	createdAt time.Time
}

type fakeSession struct {
	userID    string
	accountID string
	expiresAt time.Time
	revoked   bool
}

type fakeRefresh struct {
	id        string
	familyID  string
	accountID string
	userID    string
	hash      string
	expiresAt time.Time
	used      bool
	revoked   bool
}

func newFakeStore(now func() time.Time) *fakeStore {
	return &fakeStore{
		users:     map[string]*store.User{},
		usersByID: map[string]*store.User{},
		accounts:  map[string]*store.Account{},
		sessions:  map[string]fakeSession{},
		refresh:   map[string]*fakeRefresh{},
		now:       now,
	}
}

func (f *fakeStore) seedAccountWithOwner(accountID, accountName, email string) *store.User {
	user := &store.User{
		ID: "user-" + email, AccountID: accountID, Email: email,
		Name: "Owner", Role: store.RoleOwner,
	}
	f.users[email] = user
	f.usersByID[user.ID] = user
	policy := 21
	f.accounts[accountID] = &store.Account{
		ID: accountID, Name: accountName, Plan: store.PlanFree,
		BookingPolicy: store.BookingPolicyConfig{MaximumAdvanceDays: &policy},
	}
	return user
}

func (f *fakeStore) CountUsers(context.Context) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.users), nil
}

func (f *fakeStore) CreateAccountWithOwner(_ context.Context, name, email, userName string, plan store.AccountPlan) (*store.Account, *store.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, exists := f.users[email]; exists {
		return nil, nil, &store.IntegrityError{Code: "23505", Message: "duplicate email"}
	}
	accountID := "acct-" + email
	user := &store.User{
		ID: "user-" + email, AccountID: accountID, Email: email,
		Name: userName, Role: store.RoleOwner,
	}
	f.users[email] = user
	f.usersByID[user.ID] = user
	account := &store.Account{ID: accountID, Name: name, Plan: plan}
	f.accounts[accountID] = account
	return account, user, nil
}

func (f *fakeStore) GetUserByEmail(_ context.Context, email string) (*store.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if user, ok := f.users[email]; ok {
		return user, nil
	}
	return nil, store.ErrNotFound
}

func (f *fakeStore) GetUserByID(_ context.Context, userID string) (*store.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if user, ok := f.usersByID[userID]; ok {
		return user, nil
	}
	return nil, store.ErrNotFound
}

func (f *fakeStore) AddUserToAccount(_ context.Context, userID, tenantID, email, name string, role store.UserRole) (*store.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, exists := f.users[email]; exists {
		return nil, &store.IntegrityError{Code: "23505", Message: "duplicate email"}
	}
	user := &store.User{ID: userID, AccountID: tenantID, Email: email, Name: name, Role: role}
	f.users[email] = user
	f.usersByID[userID] = user
	return user, nil
}

func (f *fakeStore) GetAccountByID(_ context.Context, accountID string) (*store.Account, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if account, ok := f.accounts[accountID]; ok {
		return account, nil
	}
	return nil, store.ErrNotFound
}

func (f *fakeStore) CreateVerificationCode(_ context.Context, codeID, email, codeHash string, expiresAt time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.codes = append(f.codes, fakeCode{
		id: codeID, email: email, hash: codeHash, expiresAt: expiresAt, createdAt: f.now(),
	})
	return nil
}

func (f *fakeStore) ConsumeVerificationCode(_ context.Context, email, codeHash string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.codes {
		code := &f.codes[i]
		if code.email == email && code.hash == codeHash && !code.used {
			code.used = true
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeStore) CountRecentCodes(_ context.Context, email string, since time.Time) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, code := range f.codes {
		if code.email == email && code.createdAt.After(since) {
			count++
		}
	}
	return count, nil
}

func (f *fakeStore) CreateSession(_ context.Context, sessionID, userID, accountID string, _ *string, expiresAt time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions[sessionID] = fakeSession{userID: userID, accountID: accountID, expiresAt: expiresAt}
	return nil
}

// CountActiveRefreshTokens reports live tokens for a user, so reuse detection can
// be asserted to revoke the whole family rather than only what was replayed.
func (f *fakeStore) CountActiveRefreshTokens(_ context.Context, userID string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, record := range f.refresh {
		if record.userID == userID && !record.revoked && !record.used && record.expiresAt.After(f.now()) {
			count++
		}
	}
	return count, nil
}

func (f *fakeStore) ResolveSessionToken(_ context.Context, sessionID string) (*store.AuthenticatedIdentity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	session, ok := f.sessions[sessionID]
	if !ok || session.revoked {
		return nil, store.ErrNotFound
	}
	user, ok := f.usersByID[session.userID]
	if !ok {
		return nil, store.ErrNotFound
	}
	account, ok := f.accounts[session.accountID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return &store.AuthenticatedIdentity{
		SessionID: sessionID, UserID: user.ID, AccountID: session.accountID,
		Role: user.Role, Email: user.Email, UserName: user.Name,
		AccountName: account.Name, Plan: account.Plan, ExpiresAt: session.expiresAt,
	}, nil
}

func (f *fakeStore) RevokeSession(_ context.Context, sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if session, ok := f.sessions[sessionID]; ok {
		session.revoked = true
		f.sessions[sessionID] = session
	}
	return nil
}

func (f *fakeStore) RevokeUserSessions(_ context.Context, userID string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var count int64
	for id, session := range f.sessions {
		if session.userID == userID && !session.revoked {
			session.revoked = true
			f.sessions[id] = session
			count++
		}
	}
	return count, nil
}

func (f *fakeStore) CreateInvite(_ context.Context, inviteID, accountID, email string, role store.UserRole, tokenHash, createdBy string, expiresAt time.Time) (*store.Invite, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if role == store.RoleOwner {
		return nil, &store.IntegrityError{Code: "23514", Message: "invites may not grant owner"}
	}
	invite := &store.Invite{
		ID: inviteID, AccountID: accountID, Email: email, Role: role,
		TokenHash: tokenHash, CreatedBy: createdBy, Status: "pending", ExpiresAt: expiresAt,
	}
	f.invites = append(f.invites, invite)
	return invite, nil
}

func (f *fakeStore) GetPendingInvite(_ context.Context, email string) (*store.Invite, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, invite := range f.invites {
		if invite.Email == email && invite.Status == "pending" && invite.ExpiresAt.After(f.now()) {
			return invite, nil
		}
	}
	return nil, store.ErrNotFound
}

func (f *fakeStore) AcceptInvite(_ context.Context, tenantID, inviteID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, invite := range f.invites {
		if invite.ID == inviteID && invite.AccountID == tenantID && invite.Status == "pending" {
			invite.Status = "accepted"
			return nil
		}
	}
	return store.ErrNotFound
}

func (f *fakeStore) ListInvites(context.Context, string) ([]store.Invite, error) { return nil, nil }

func (f *fakeStore) RevokeInvite(context.Context, string, string) error { return nil }

func (f *fakeStore) GetTenantState(_ context.Context, tenantID string) (*store.TenantState, error) {
	return &store.TenantState{TenantID: tenantID, Version: 0}, nil
}

func (f *fakeStore) IssueRefreshToken(_ context.Context, tokenID, familyID, accountID, userID string, _ *string, tokenHash string, expiresAt time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refresh[tokenHash] = &fakeRefresh{
		id: tokenID, familyID: familyID, accountID: accountID, userID: userID,
		hash: tokenHash, expiresAt: expiresAt,
	}
	return nil
}

func (f *fakeStore) ConsumeRefreshToken(_ context.Context, tokenHash string) (*store.RefreshTokenRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	record, ok := f.refresh[tokenHash]
	if !ok || record.revoked || !record.expiresAt.After(f.now()) {
		return nil, store.ErrNotFound
	}
	wasUsed := record.used
	if !record.used {
		record.used = true
	}
	return &store.RefreshTokenRecord{
		TokenID: record.id, FamilyID: record.familyID, AccountID: record.accountID,
		UserID: record.userID, WasUsed: wasUsed,
	}, nil
}

func (f *fakeStore) RefreshTokenFamily(_ context.Context, tokenHash string) (*store.RefreshTokenFamily, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	record, ok := f.refresh[tokenHash]
	if !ok {
		return nil, store.ErrNotFound
	}
	return &store.RefreshTokenFamily{
		TokenID: record.id, FamilyID: record.familyID, AccountID: record.accountID,
		UserID: record.userID, Revoked: record.revoked, Used: record.used,
		Expired: !record.expiresAt.After(f.now()),
	}, nil
}

func (f *fakeStore) RevokeRefreshFamily(_ context.Context, familyID string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, record := range f.refresh {
		if record.familyID == familyID && !record.revoked {
			record.revoked = true
			count++
		}
	}
	return count, nil
}

func (f *fakeStore) RevokeUserRefreshTokens(_ context.Context, userID string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, record := range f.refresh {
		if record.userID == userID && !record.revoked {
			record.revoked = true
			count++
		}
	}
	return count, nil
}

func (f *fakeStore) LookupUserForRefresh(_ context.Context, userID string) (*store.AuthenticatedIdentity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	user, ok := f.usersByID[userID]
	if !ok {
		return nil, store.ErrNotFound
	}
	account, ok := f.accounts[user.AccountID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return &store.AuthenticatedIdentity{
		UserID: user.ID, AccountID: user.AccountID, Role: user.Role,
		Email: user.Email, UserName: user.Name, AccountName: account.Name, Plan: account.Plan,
	}, nil
}

// --- test harness -----------------------------------------------------------

type recordingMessenger struct {
	sent []struct {
		email string
		code  string
	}
	fail bool
	// observed keys every code the service generated by address, including codes
	// for non-loginable addresses that are never actually delivered. Tests that
	// must verify such an address need the plaintext, which by design never
	// appears in the database.
	observed map[string]string
}

// note records a generated code. It is wired to Options.OnCodeGenerated, the only
// point where the plaintext exists.
func (m *recordingMessenger) note(email, code string) {
	if m.observed == nil {
		m.observed = map[string]string{}
	}
	m.observed[email] = code
}

func (m *recordingMessenger) codeFor(email string) string {
	if m.observed == nil {
		return ""
	}
	return m.observed[email]
}

func (m *recordingMessenger) SendLoginCode(_ context.Context, email, code string, _ time.Time) error {
	if m.fail {
		return errors.New("smtp unavailable")
	}
	m.sent = append(m.sent, struct {
		email string
		code  string
	}{email, code})
	return nil
}

func (m *recordingMessenger) lastCode() string {
	if len(m.sent) == 0 {
		return ""
	}
	return m.sent[len(m.sent)-1].code
}

// harness bundles a service with its fake dependencies and a controllable clock.
type harness struct {
	service   *Service
	store     *fakeStore
	limiter   *RateLimiter
	messenger *recordingMessenger
	now       time.Time
}

func newHarness(t *testing.T, exposeCode bool, setupToken string) *harness {
	t.Helper()

	h := &harness{
		messenger: &recordingMessenger{},
		now:       time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC),
	}
	h.store = newFakeStore(func() time.Time { return h.now })
	h.limiter = NewRateLimiter(RateLimiterOptions{
		MinInterval: 60 * time.Second,
		SendLimit:   5,
		SendWindow:  15 * time.Minute,
		MaxAttempts: 5,
		LockWindow:  15 * time.Minute,
	})
	h.service = New(h.store, Options{
		AppName:    "ДомБук",
		JWTSecret:  "test-secret-value-16chars",
		AccessTTL:  15 * time.Minute,
		RefreshTTL: 30 * 24 * time.Hour,
		OTPTTL:     10 * time.Minute,
		OTPLength:  6,
		ExposeCode: exposeCode,
		SetupToken: setupToken,
		Now:        func() time.Time { return h.now },
		// The service stores only the hash, so the harness captures plaintext here:
		// tests that verify an address whose message is never delivered still need
		// the original value.
		OnCodeGenerated: h.messenger.note,
	}, h.limiter, h.messenger)
	return h
}

// advance moves the clock forward, which is how cooldown and expiry behavior is
// tested without sleeping.
func (h *harness) advance(d time.Duration) { h.now = h.now.Add(d) }

// loginWithCode performs a complete send+verify so tests can reach an
// authenticated state.
func (h *harness) loginWithCode(t *testing.T, email string) *SessionView {
	t.Helper()
	result, err := h.service.SendCode(context.Background(), email)
	if err != nil {
		t.Fatalf("SendCode(%s): %v", email, err)
	}
	if !result.Loginable {
		t.Fatalf("SendCode reported %s as not loginable", email)
	}
	code := result.Code
	if code == "" {
		code = h.messenger.lastCode()
	}
	session, err := h.service.Verify(context.Background(), VerifyInput{Email: email, Code: code})
	if err != nil {
		t.Fatalf("Verify(%s): %v", email, err)
	}
	return session
}

func apiCode(t *testing.T, err error) string {
	t.Helper()
	var apiErr *httpapi.ApiError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected an ApiError, got %T: %v", err, err)
	}
	return apiErr.Code
}

// --- setup ------------------------------------------------------------------

func TestSetupCreatesFirstAccountAndOwner(t *testing.T) {
	h := newHarness(t, false, "")

	account, user, err := h.service.Setup(context.Background(), SetupInput{
		Email: "Owner@Example.test", Name: "Али", AccountName: "Лесная долина",
	})
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if account.Name != "Лесная долина" {
		t.Errorf("account name = %q", account.Name)
	}
	// The email is normalized, so a later login with different casing matches.
	if user.Email != "owner@example.test" {
		t.Errorf("email = %q, want lowercase", user.Email)
	}
	if user.Role != store.RoleOwner {
		t.Errorf("role = %q, want owner", user.Role)
	}
}

func TestSetupIsOpenOnlyUntilTheFirstUserExists(t *testing.T) {
	// No setup token configured: after the first account exists, signup must be
	// closed rather than accepting anyone who finds the endpoint.
	h := newHarness(t, false, "")
	ctx := context.Background()

	if _, _, err := h.service.Setup(ctx, SetupInput{Email: "first@example.test"}); err != nil {
		t.Fatalf("first Setup should succeed: %v", err)
	}

	_, _, err := h.service.Setup(ctx, SetupInput{Email: "second@example.test"})
	if err == nil {
		t.Fatal("second Setup must be refused")
	}
	if code := apiCode(t, err); code != "setup_denied" {
		t.Errorf("code = %q, want setup_denied", code)
	}
}

func TestSetupAcceptsTheTokenOnceConfigured(t *testing.T) {
	h := newHarness(t, false, "s3cret-setup-token")
	ctx := context.Background()

	if _, _, err := h.service.Setup(ctx, SetupInput{Email: "first@example.test"}); err != nil {
		t.Fatalf("first Setup: %v", err)
	}

	// A wrong token must be refused, and the comparison is constant-time so a
	// wrong prefix cannot be discovered by timing.
	_, _, err := h.service.Setup(ctx, SetupInput{Email: "second@example.test", SetupToken: "wrong"})
	if code := apiCode(t, err); code != "setup_denied" {
		t.Errorf("wrong token: code = %q, want setup_denied", code)
	}

	if _, _, err := h.service.Setup(ctx, SetupInput{
		Email: "second@example.test", SetupToken: "s3cret-setup-token",
	}); err != nil {
		t.Fatalf("correct token should be accepted: %v", err)
	}
}

func TestSetupRejectsMalformedEmailAndDuplicates(t *testing.T) {
	h := newHarness(t, false, "")
	ctx := context.Background()

	for _, bad := range []string{"", "not-an-email", "a@b", "@example.test", "spaces in@example.test"} {
		if _, _, err := h.service.Setup(ctx, SetupInput{Email: bad}); err == nil {
			t.Errorf("Setup accepted malformed email %q", bad)
		}
	}

	if _, _, err := h.service.Setup(ctx, SetupInput{Email: "dup@example.test"}); err != nil {
		t.Fatalf("first Setup: %v", err)
	}
	// Same address, different case: the citext column makes them the same user.
	_, _, err := h.service.Setup(ctx, SetupInput{Email: "DUP@example.test", SetupToken: ""})
	if err == nil {
		t.Fatal("duplicate setup must be refused")
	}
	if code := apiCode(t, err); code != "user_exists" {
		t.Errorf("code = %q, want user_exists", code)
	}
}

func TestSetupDefaultsTheAccountName(t *testing.T) {
	h := newHarness(t, false, "")
	account, _, err := h.service.Setup(context.Background(), SetupInput{Email: "a@example.test"})
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	// An account must always have a display name; the sidebar renders it directly.
	if account.Name == "" {
		t.Error("account name should default rather than be empty")
	}
}

// --- send -------------------------------------------------------------------

func TestSendCodeIsLoginableForKnownUsersAndInvites(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "member@example.test")
	h.store.invites = append(h.store.invites, &store.Invite{
		ID: "inv-1", AccountID: "acct-1", Email: "invited@example.test",
		Role: store.RoleStaff, Status: "pending", ExpiresAt: h.now.Add(time.Hour),
	})

	for _, email := range []string{"member@example.test", "invited@example.test"} {
		result, err := h.service.SendCode(context.Background(), email)
		if err != nil {
			t.Fatalf("SendCode(%s): %v", email, err)
		}
		if !result.Loginable {
			t.Errorf("%s should be loginable", email)
		}
		if result.Code == "" {
			t.Errorf("%s: code should be exposed in development mode", email)
		}
	}
}

// TestSendCodeDoesNotRevealWhetherAnAddressExists is the account-enumeration
// guard. The response for an unknown address must be indistinguishable in shape
// and status from the response for a known one; only the Loginable flag differs,
// and even that is not an error.
func TestSendCodeDoesNotRevealWhetherAnAddressExists(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "known@example.test")
	ctx := context.Background()

	known, err := h.service.SendCode(ctx, "known@example.test")
	if err != nil {
		t.Fatalf("SendCode(known): %v", err)
	}
	unknown, err := h.service.SendCode(ctx, "stranger@example.test")
	if err != nil {
		t.Fatalf("SendCode(unknown) must not be an error: %v", err)
	}

	if !known.OK || !unknown.OK {
		t.Error("both responses must report ok")
	}
	if unknown.Loginable {
		t.Error("an unknown address must not be reported as loginable")
	}
	// A code row is written for both, so the database work — and therefore the
	// timing — is comparable. Without it, response latency reveals whether the
	// address exists, regardless of how similar the bodies look.
	if len(h.store.codes) != 2 {
		t.Errorf("expected a code row for both addresses, got %d", len(h.store.codes))
	}
	// The bodies differ in exactly one field. A missing `code` on the unknown
	// response would be a second tell, so both carry one.
	if known.Code == "" {
		t.Error("the loginable response should expose a code in development mode")
	}
	if unknown.Code == "" {
		t.Error("the unknown-address response must match the loginable body shape")
	}
}

func TestSendCodeIsThrottledPerAddress(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	if _, err := h.service.SendCode(ctx, "user@example.test"); err != nil {
		t.Fatalf("first send: %v", err)
	}
	// Immediate retry violates the minimum interval.
	_, err := h.service.SendCode(ctx, "user@example.test")
	if err == nil {
		t.Fatal("immediate resend must be throttled")
	}
	if code := apiCode(t, err); code != "rate_limited" {
		t.Errorf("code = %q, want rate_limited", code)
	}

	// After the interval a resend is allowed again.
	h.advance(61 * time.Second)
	if _, err := h.service.SendCode(ctx, "user@example.test"); err != nil {
		t.Fatalf("send after the interval: %v", err)
	}
}

func TestSendCodeEnforcesTheWindowLimit(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "burst@example.test")
	ctx := context.Background()

	// The in-memory limit is 5 per window; step past the minimum interval each
	// time so only the window limit can trigger.
	for i := 0; i < 5; i++ {
		if _, err := h.service.SendCode(ctx, "burst@example.test"); err != nil {
			t.Fatalf("send %d: %v", i+1, err)
		}
		h.advance(61 * time.Second)
	}

	_, err := h.service.SendCode(ctx, "burst@example.test")
	if err == nil {
		t.Fatal("the sixth send within the window must be refused")
	}
	if code := apiCode(t, err); code != "rate_limited" {
		t.Errorf("code = %q, want rate_limited", code)
	}

	// Once the window passes, sending works again.
	h.advance(16 * time.Minute)
	if _, err := h.service.SendCode(ctx, "burst@example.test"); err != nil {
		t.Fatalf("send after the window: %v", err)
	}
}

func TestSendCodeFailsLoudlyWhenDeliveryFails(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	h.messenger.fail = true

	// Reporting success while the message was never sent would leave the user
	// waiting for a code that will not arrive.
	if _, err := h.service.SendCode(context.Background(), "user@example.test"); err == nil {
		t.Fatal("a delivery failure must surface as an error")
	}
}

func TestSendCodeScopesTheDatabaseRateLimitPerAddress(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	if _, err := h.service.SendCode(ctx, "user@example.test"); err != nil {
		t.Fatalf("send: %v", err)
	}
	// A different address is unaffected: the limit is per mailbox, so one user
	// cannot lock another out.
	if _, err := h.service.SendCode(ctx, "other@example.test"); err != nil {
		t.Fatalf("send for a different address: %v", err)
	}
}

// --- verify -----------------------------------------------------------------

func TestVerifyIssuesASessionAndConsumesTheCode(t *testing.T) {
	h := newHarness(t, true, "")
	user := h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	session := h.loginWithCode(t, "user@example.test")

	if session.Token == "" || session.RefreshToken == "" {
		t.Fatal("verify must return both tokens")
	}
	if session.AccountID != user.AccountID {
		t.Errorf("account = %q, want %q", session.AccountID, user.AccountID)
	}
	if session.Plan != string(store.PlanFree) {
		t.Errorf("plan = %q, want free", session.Plan)
	}
	if session.InviteAccepted {
		t.Error("a member login must not report an accepted invite")
	}

	// The code is single-use: replaying it must fail even though it was valid.
	_, err := h.service.Verify(ctx, VerifyInput{Email: "user@example.test", Code: h.messenger.lastCode()})
	if err == nil {
		t.Fatal("a consumed code must not be reusable")
	}
	if code := apiCode(t, err); code != "unauthorized" {
		t.Errorf("code = %q, want unauthorized", code)
	}
}

func TestVerifyRejectsWrongCodeAndLocksAfterRepeatedFailures(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	// A valid code must exist, otherwise "wrong code" and "no code" are the same
	// path and the lockout would not be exercised.
	if _, err := h.service.SendCode(ctx, "user@example.test"); err != nil {
		t.Fatalf("send: %v", err)
	}

	for i := 0; i < 5; i++ {
		_, err := h.service.Verify(ctx, VerifyInput{Email: "user@example.test", Code: "000000"})
		if err == nil {
			t.Fatalf("attempt %d with a wrong code must fail", i+1)
		}
	}

	// After the threshold the correct code is refused too, because a 6-digit code
	// is only a million possibilities and unlimited guesses defeat it.
	_, err := h.service.Verify(ctx, VerifyInput{Email: "user@example.test", Code: h.messenger.lastCode()})
	if err == nil {
		t.Fatal("verification must be locked after repeated failures")
	}
	if code := apiCode(t, err); code != "rate_limited" {
		t.Errorf("code = %q, want rate_limited", code)
	}

	// The lockout expires.
	h.advance(16 * time.Minute)
	if _, err := h.service.Verify(ctx, VerifyInput{Email: "user@example.test", Code: h.messenger.lastCode()}); err != nil {
		t.Fatalf("verification should work after the lockout expires: %v", err)
	}
}

func TestVerifyRejectsAnEmptyCode(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")

	_, err := h.service.Verify(context.Background(), VerifyInput{Email: "user@example.test", Code: "  "})
	if code := apiCode(t, err); code != "validation_error" {
		t.Errorf("code = %q, want validation_error", code)
	}
}

func TestVerifyConvertsAPendingInviteIntoMembership(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "owner@example.test")
	h.store.invites = append(h.store.invites, &store.Invite{
		ID: "inv-1", AccountID: "acct-1", Email: "newbie@example.test",
		Role: store.RoleAdmin, Status: "pending", ExpiresAt: h.now.Add(time.Hour),
	})

	session := h.loginWithCode(t, "newbie@example.test")

	if !session.InviteAccepted {
		t.Error("the first login of an invited address must report the invite as accepted")
	}
	if session.AccountID != "acct-1" {
		t.Errorf("account = %q, want acct-1", session.AccountID)
	}
	if session.User.Role != string(store.RoleAdmin) {
		t.Errorf("role = %q, want the invited role admin", session.User.Role)
	}

	// The invitation is consumed, so the same address cannot join twice.
	if invite, err := h.store.GetPendingInvite(context.Background(), "newbie@example.test"); err == nil && invite.Status == "pending" {
		t.Error("the invite should no longer be pending")
	}
}

func TestVerifyRefusesAnAddressWithNoAccountOrInvite(t *testing.T) {
	h := newHarness(t, true, "")
	ctx := context.Background()

	// A code is issued for the unknown address (so the send endpoint does not
	// leak existence), but exchanging it must not create an account.
	result, err := h.service.SendCode(ctx, "stranger@example.test")
	if err != nil {
		t.Fatalf("SendCode: %v", err)
	}
	if result.Loginable {
		t.Fatal("a stranger must not be loginable")
	}
	// Nothing was delivered — there is no mailbox owner to send to — so the code
	// that was stored is read back directly. Providing it proves the rejection
	// comes from the missing account, not from an unparseable code.
	_, err = h.service.Verify(ctx, VerifyInput{Email: "stranger@example.test", Code: h.messenger.codeFor("stranger@example.test")})
	if err == nil {
		t.Fatal("verify must refuse an address with no account")
	}
	if code := apiCode(t, err); code != "no_account" {
		t.Errorf("code = %q, want no_account", code)
	}
}

// --- current / logout -------------------------------------------------------

func TestCurrentResolvesTheSessionAndLogoutRevokesIt(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	session := h.loginWithCode(t, "user@example.test")

	current, err := h.service.Current(ctx, session.Token)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}
	if current.AccountID != "acct-1" || current.User.Email != "user@example.test" {
		t.Errorf("unexpected current identity: %+v", current)
	}

	if err := h.service.Logout(ctx, session.Token); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	// Logout must take effect immediately, not at the token's natural expiry.
	if _, err := h.service.Current(ctx, session.Token); err == nil {
		t.Fatal("a revoked session must not resolve")
	}
}

func TestCurrentRejectsForgedAndExpiredTokens(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	session := h.loginWithCode(t, "user@example.test")

	// Signed with the wrong key.
	other := New(h.store, Options{
		JWTSecret: "another-secret-16-chars", AccessTTL: time.Minute, RefreshTTL: time.Hour,
		OTPTTL: time.Minute, OTPLength: 6, Now: func() time.Time { return h.now },
	}, h.limiter, h.messenger)
	if _, err := other.Current(ctx, session.Token); err == nil {
		t.Error("a token signed with a different secret must be rejected")
	}

	// Expired: the session row outlives the token, but the token's exp is checked.
	h.advance(16 * time.Minute)
	if _, err := h.service.Current(ctx, session.Token); err == nil {
		t.Error("an expired token must be rejected")
	}
}

func TestLogoutIsIdempotent(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	session := h.loginWithCode(t, "user@example.test")
	if err := h.service.Logout(ctx, session.Token); err != nil {
		t.Fatalf("first Logout: %v", err)
	}
	// The client may retry a logout it is unsure about.
	if err := h.service.Logout(ctx, session.Token); err != nil {
		t.Errorf("second Logout should be a no-op, got %v", err)
	}
	// A malformed token has no session to revoke; reporting success lets the
	// client clear local state without special-casing.
	if err := h.service.Logout(ctx, "not-a-token"); err != nil {
		t.Errorf("Logout with a malformed token should not error, got %v", err)
	}
}

// --- refresh ----------------------------------------------------------------

func TestRefreshRotatesTheToken(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	session := h.loginWithCode(t, "user@example.test")

	refreshed, err := h.service.Refresh(ctx, session.RefreshToken)
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if refreshed.Token == "" || refreshed.RefreshToken == "" {
		t.Fatal("refresh must return both tokens")
	}
	// Rotation: the successor must differ from the token that was presented.
	if refreshed.RefreshToken == session.RefreshToken {
		t.Error("refresh token must rotate")
	}
	// The new access token must be usable.
	if _, err := h.service.Current(ctx, refreshed.Token); err != nil {
		t.Errorf("the refreshed access token should resolve: %v", err)
	}

	// The old refresh token is spent, and the rejection is a 401 so the client
	// knows to send the user back to the login screen rather than retrying.
	_, err = h.service.Refresh(ctx, session.RefreshToken)
	if err == nil {
		t.Fatal("a consumed refresh token must not be reusable")
	}
	if code := apiCode(t, err); code != "unauthorized" {
		t.Errorf("replaying a consumed token: code = %q, want unauthorized", code)
	}
}

// TestRefreshDetectsReuseAndRevokesTheFamily is the security property that makes
// rotation worth doing: a stolen token used after the legitimate client refreshed
// must invalidate the entire chain, not just the value that was replayed.
func TestRefreshDetectsReuseAndRevokesTheFamily(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	session := h.loginWithCode(t, "user@example.test")

	// The legitimate client refreshes, consuming the original token.
	refreshed, err := h.service.Refresh(ctx, session.RefreshToken)
	if err != nil {
		t.Fatalf("first Refresh: %v", err)
	}

	// The attacker replays the stolen original.
	_, err = h.service.Refresh(ctx, session.RefreshToken)
	if err == nil {
		t.Fatal("a replayed refresh token must be rejected")
	}
	if code := apiCode(t, err); code != "unauthorized" {
		t.Errorf("code = %q, want unauthorized", code)
	}

	// The whole family is now dead, including the legitimate client's successor.
	if _, err := h.service.Refresh(ctx, refreshed.RefreshToken); err == nil {
		t.Error("the successor token must be revoked after reuse is detected")
	}
	remaining, err := h.store.CountActiveRefreshTokens(ctx, "user-"+session.User.Email)
	if err != nil {
		t.Fatalf("CountActiveRefreshTokens: %v", err)
	}
	if remaining != 0 {
		t.Errorf("%d refresh tokens still active after reuse was detected, want 0", remaining)
	}
}

func TestRefreshRejectsUnknownAndEmptyTokens(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	if _, err := h.service.Refresh(ctx, "  "); err == nil {
		t.Error("an empty refresh token must be rejected")
	}
	if _, err := h.service.Refresh(ctx, "some-family.unknown-secret"); err == nil {
		t.Error("an unknown refresh token must be rejected")
	}
}

func TestRefreshRejectsAnExpiredToken(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	session := h.loginWithCode(t, "user@example.test")

	// Past the refresh lifetime.
	h.advance(31 * 24 * time.Hour)
	_, err := h.service.Refresh(ctx, session.RefreshToken)
	if err == nil {
		t.Fatal("an expired refresh token must be rejected")
	}
	if code := apiCode(t, err); code != "unauthorized" {
		t.Errorf("code = %q, want unauthorized", code)
	}
}

// TestRefreshRejectsARevokedFamilyWithoutClaimingReuse covers the branch where a
// token is known but its whole family was revoked for another reason (a device
// revocation or "sign out everywhere"). It must be rejected as an ordinary dead
// session — reporting a compromise here would cry wolf on every deliberate logout.
func TestRefreshRejectsARevokedFamilyWithoutClaimingReuse(t *testing.T) {
	h := newHarness(t, true, "")
	user := h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	session := h.loginWithCode(t, "user@example.test")

	// Revoke every token the user holds, as "sign out everywhere" would.
	if _, err := h.store.RevokeUserRefreshTokens(ctx, user.ID); err != nil {
		t.Fatalf("RevokeUserRefreshTokens: %v", err)
	}

	_, err := h.service.Refresh(ctx, session.RefreshToken)
	if err == nil {
		t.Fatal("a revoked refresh token must be rejected")
	}
	if code := apiCode(t, err); code != "unauthorized" {
		t.Errorf("code = %q, want unauthorized", code)
	}
}

// TestRefreshKeepsADeviceRevocationFromEscalating documents that revoking one
// family does not invalidate an unrelated device's chain. Broad "reuse" handling
// must not become a blunt instrument that signs every device out at once.
func TestRefreshKeepsUnrelatedFamiliesIndependent(t *testing.T) {
	h := newHarness(t, true, "")
	h.store.seedAccountWithOwner("acct-1", "Resort", "user@example.test")
	ctx := context.Background()

	// Two logins, so two independent families. The clock steps past the send
	// cooldown between them, since the same address cannot request two codes
	// back-to-back.
	first := h.loginWithCode(t, "user@example.test")
	h.advance(2 * time.Minute)
	second := h.loginWithCode(t, "user@example.test")

	if _, err := h.service.Refresh(ctx, first.RefreshToken); err != nil {
		t.Fatalf("refreshing the first family: %v", err)
	}

	// The second family is untouched by the first family's rotation.
	if _, err := h.service.Refresh(ctx, second.RefreshToken); err != nil {
		t.Errorf("the second device's family must remain usable: %v", err)
	}
}

// --- rate limiter -----------------------------------------------------------

// TestRateLimiterSweepBoundsMemory covers the flood case that matters: a swarm of
// one-shot addresses, each of which looks harmless on its own. Pruning on access
// cannot help here, because no individual key is visited again — only an explicit
// sweep bounds the map.
func TestRateLimiterSweepBoundsMemory(t *testing.T) {
	limiter := NewRateLimiter(RateLimiterOptions{
		MinInterval: time.Minute, SendLimit: 3, SendWindow: time.Minute,
		MaxAttempts: 2, LockWindow: time.Minute,
	})

	base := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 200; i++ {
		key := fmt.Sprintf("spray-%d@example.test", i)
		limiter.RecordSend(key, base)
	}
	if size := limiter.Size(); size != 200 {
		t.Fatalf("tracked %d entries, want 200", size)
	}

	// Inside the windows nothing may be dropped: the limits are still live.
	if removed := limiter.Sweep(base.Add(30 * time.Second)); removed != 0 {
		t.Errorf("sweep removed %d live entries, want 0", removed)
	}
	if size := limiter.Size(); size != 200 {
		t.Errorf("size = %d after sweeping live entries, want 200", size)
	}

	// Past every window, all of them go.
	if removed := limiter.Sweep(base.Add(time.Hour)); removed != 200 {
		t.Errorf("sweep removed %d entries, want 200", removed)
	}
	if size := limiter.Size(); size != 0 {
		t.Errorf("size = %d after sweeping expired entries, want 0", size)
	}
}

// TestRateLimiterReleasesTheSendLimitOnTheSendWindow pins when the send cap lets go.
//
// The bug this guards against is quiet: if the wait is measured from the NEWEST
// request instead of the oldest, each rejected attempt pushes the deadline further
// out and the address never recovers. Nothing errors — the endpoint simply stays
// closed — so only an explicit assertion catches it.
//
// Note on what this does NOT pin: the retention bound used while pruning is not
// observable here, because the staleness test filters by the send window
// regardless. Keeping timestamps longer only delays when an idle entry is swept,
// which the sweep tests below cover.
func TestRateLimiterReleasesTheSendLimitOnTheSendWindow(t *testing.T) {
	sendWindow := 15 * time.Minute
	lockWindow := 60 * time.Minute
	limiter := NewRateLimiter(RateLimiterOptions{
		MinInterval: time.Minute, SendLimit: 3, SendWindow: sendWindow,
		MaxAttempts: 5, LockWindow: lockWindow,
	})
	base := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	const key = "window@example.test"

	// Fill the send budget, one request per minute so only the window limit binds.
	for i := 0; i < 3; i++ {
		limiter.RecordSend(key, base.Add(time.Duration(i)*time.Minute))
	}

	allowed, retryAfter := limiter.AllowSend(key, base.Add(3*time.Minute))
	if allowed {
		t.Fatal("the send limit should be in force immediately after filling it")
	}
	// The oldest request is 3 minutes old, so the wait is the send window minus
	// those 3 minutes. A deadline measured from the newest request would report
	// the full window instead.
	if want := sendWindow - 3*time.Minute; retryAfter != want {
		t.Errorf("retryAfter = %s, want %s (measured from the oldest request)", retryAfter, want)
	}

	// Once the oldest request leaves the send window the cap releases, even though
	// the longer lock window has not elapsed.
	released := base.Add(3*time.Minute + sendWindow)
	if allowed, retryAfter := limiter.AllowSend(key, released); !allowed {
		t.Errorf("the send limit should release after the send window; retryAfter=%s", retryAfter)
	}
}

// TestRateLimiterDoesNotExtendTheDeadlineOnRepeatedAttempts is the sharper form of
// the same hazard: a client that keeps retrying while throttled must not be able
// to push its own release time further away.
func TestRateLimiterDoesNotExtendTheDeadlineOnRepeatedAttempts(t *testing.T) {
	limiter := NewRateLimiter(RateLimiterOptions{
		MinInterval: 0, SendLimit: 2, SendWindow: 10 * time.Minute,
		MaxAttempts: 5, LockWindow: 10 * time.Minute,
	})
	base := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	const key = "retry@example.test"

	limiter.RecordSend(key, base)
	limiter.RecordSend(key, base)

	// Retry repeatedly; the reported wait must shrink, never grow.
	previous := 11 * time.Minute
	for i := 1; i <= 8; i++ {
		at := base.Add(time.Duration(i) * time.Minute)
		allowed, retryAfter := limiter.AllowSend(key, at)
		if allowed {
			t.Fatalf("attempt %d should still be throttled", i)
		}
		if retryAfter > previous {
			t.Fatalf("attempt %d pushed the release time out: %s then %s", i, previous, retryAfter)
		}
		previous = retryAfter
	}

	// And it genuinely releases at the window boundary.
	if allowed, _ := limiter.AllowSend(key, base.Add(10*time.Minute)); !allowed {
		t.Error("the limit should release exactly at the send window")
	}
}

// TestRateLimiterKeepsLiveLocksThroughASweep guards the obvious over-correction:
// a sweep must never clear a lockout that is still in force, or the burst
// protection could be bypassed by simply waiting for the janitor.
func TestRateLimiterKeepsLiveLocksThroughASweep(t *testing.T) {
	limiter := NewRateLimiter(RateLimiterOptions{
		MinInterval: time.Minute, SendLimit: 3, SendWindow: time.Minute,
		MaxAttempts: 2, LockWindow: 15 * time.Minute,
	})
	base := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	const key = "locked@example.test"

	limiter.RecordFailedVerification(key, base)
	limiter.RecordFailedVerification(key, base)
	if locked, _ := limiter.VerificationLocked(key, base); !locked {
		t.Fatal("two failures should lock the address")
	}

	if removed := limiter.Sweep(base.Add(time.Minute)); removed != 0 {
		t.Errorf("sweep removed %d entries while a lock was live, want 0", removed)
	}
	if locked, _ := limiter.VerificationLocked(key, base.Add(time.Minute)); !locked {
		t.Error("the lock must survive a sweep")
	}

	// Once the lock expires the entry becomes sweepable.
	if removed := limiter.Sweep(base.Add(16 * time.Minute)); removed != 1 {
		t.Errorf("sweep removed %d entries after the lock expired, want 1", removed)
	}
}
