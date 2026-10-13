package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/inajaf/dombook/server/internal/crypto"
	"github.com/inajaf/dombook/server/internal/store"
)

// repoStore returns a Store connected as the unprivileged application role, so
// every query below is subject to the RLS policies. Running these tests as an
// admin would bypass tenant isolation and make them pass for the wrong reason.
func repoStore(t *testing.T) *store.Store {
	t.Helper()
	migrate(t)
	// create the role password and assert it cannot bypass RLS
	newAdminPool(t)
	return newAppStore(t)
}

// newAccountWithOwner exercises the real signup path: one atomic call that creates
// the account and its owner. Tests that need a pre-existing tenant use this rather
// than assembling rows directly, so the bootstrap function is always covered.
func newAccountWithOwner(t *testing.T, app *store.Store, name, email string) (*store.Account, *store.User) {
	t.Helper()
	account, user, err := app.CreateAccountWithOwner(
		context.Background(), name, email, name+" Owner", store.PlanFree)
	if err != nil {
		t.Fatalf("CreateAccountWithOwner: %v", err)
	}
	return account, user
}

func TestCreateAccountInitialisesTenantState(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()

	account, user, err := app.CreateAccountWithOwner(ctx, "Лесная долина", "owner@les.test", "Owner", store.PlanFree)
	if err != nil {
		t.Fatalf("CreateAccountWithOwner: %v", err)
	}

	if account.ID == "" {
		t.Error("account has no id")
	}
	if user.AccountID != account.ID {
		t.Errorf("owner account = %q, want %q", user.AccountID, account.ID)
	}
	if user.Role != store.RoleOwner {
		t.Errorf("bootstrap role = %q, want owner", user.Role)
	}
	if account.Plan != store.PlanFree {
		t.Errorf("plan = %q, want free", account.Plan)
	}
	// The booking policy column has a database default; it must round-trip into
	// the typed config so the caller never sees a zero-value policy.
	if account.BookingPolicy.MaximumAdvanceDays == nil || *account.BookingPolicy.MaximumAdvanceDays != 21 {
		t.Errorf("booking policy not loaded from the column default: %+v", account.BookingPolicy)
	}
	if account.BookingPolicy.TimeZone == nil || *account.BookingPolicy.TimeZone != "Asia/Baku" {
		t.Errorf("booking policy timezone missing: %+v", account.BookingPolicy)
	}

	// tenant_state must exist immediately, otherwise the first sync pull has to
	// special-case a missing row.
	state, err := app.GetTenantState(ctx, account.ID)
	if err != nil {
		t.Fatalf("GetTenantState: %v", err)
	}
	if state.Version != 0 {
		t.Errorf("initial tenant version = %d, want 0", state.Version)
	}
}

func TestCreateAccountRejectsUnknownPlan(t *testing.T) {
	app := repoStore(t)
	// Failing in Go is better than a CHECK violation, because the caller learns
	// the plan name it passed was wrong.
	if _, _, err := app.CreateAccountWithOwner(
		context.Background(), "X", "x@example.test", "X", store.AccountPlan("enterprise")); err == nil {
		t.Error("CreateAccountWithOwner accepted an unknown plan")
	}
}

func TestEmailLookupIsCaseInsensitive(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	_, user := newAccountWithOwner(t, app, "Case Test", "Owner@Example.test")

	// citext is what makes this work. If the column were plain text, a login with
	// a differently-cased address would fail to find the user, and a second
	// registration would create a duplicate identity.
	for _, variant := range []string{"owner@example.test", "OWNER@EXAMPLE.TEST", "Owner@Example.TEST"} {
		found, err := app.GetUserByEmail(ctx, variant)
		if err != nil {
			t.Fatalf("GetUserByEmail(%q): %v", variant, err)
		}
		if found.ID != user.ID {
			t.Errorf("GetUserByEmail(%q) returned %q, want %q", variant, found.ID, user.ID)
		}
	}
}

func TestDuplicateEmailIsRejected(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, _ := newAccountWithOwner(t, app, "Dup A", "dup@example.test")

	// Same address, different case: the unique index on citext must still refuse.
	secondID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	_, err = app.AddUserToAccount(ctx, secondID, account.ID, "DUP@example.test", "Second", store.RoleStaff)
	if err == nil {
		t.Fatal("expected a duplicate email to be refused")
	}
	if !store.IsUniqueViolation(err) {
		t.Errorf("expected a unique violation, got %v", err)
	}
}

// TestVerificationCodeIsSingleUse is the security-critical property of the login
// flow: a code must be burnable exactly once, even when two requests race. A
// SELECT-then-UPDATE implementation passes the sequential case and fails this one.
func TestVerificationCodeIsSingleUse(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	const email = "otp@example.test"
	const code = "123456"
	hash := crypto.SHA256Hex(code)

	id, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if err := app.CreateVerificationCode(ctx, id, email, hash, time.Now().Add(10*time.Minute)); err != nil {
		t.Fatalf("CreateVerificationCode: %v", err)
	}

	if ok, err := app.ConsumeVerificationCode(ctx, email, hash); err != nil || !ok {
		t.Fatalf("first consume = %v, %v; want true, nil", ok, err)
	}
	// Replay of a consumed code must fail.
	if ok, err := app.ConsumeVerificationCode(ctx, email, hash); err != nil || ok {
		t.Fatalf("second consume = %v, %v; want false, nil", ok, err)
	}
}

func TestVerificationCodeConcurrentConsumeOnlyOneWins(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	const email = "race@example.test"
	const code = "654321"
	hash := crypto.SHA256Hex(code)

	id, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if err := app.CreateVerificationCode(ctx, id, email, hash, time.Now().Add(10*time.Minute)); err != nil {
		t.Fatalf("CreateVerificationCode: %v", err)
	}

	const attempts = 8
	var (
		waitGroup sync.WaitGroup
		mutex     sync.Mutex
		wins      int
	)
	waitGroup.Add(attempts)
	for i := 0; i < attempts; i++ {
		go func() {
			defer waitGroup.Done()
			ok, err := app.ConsumeVerificationCode(ctx, email, hash)
			if err != nil {
				return
			}
			if ok {
				mutex.Lock()
				wins++
				mutex.Unlock()
			}
		}()
	}
	waitGroup.Wait()

	if wins != 1 {
		t.Fatalf("%d concurrent attempts succeeded, want exactly 1", wins)
	}
}

func TestVerificationCodeRejectsWrongAndExpiredCodes(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()

	wrongID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if err := app.CreateVerificationCode(ctx, wrongID, "a@example.test",
		crypto.SHA256Hex("111111"), time.Now().Add(time.Minute)); err != nil {
		t.Fatalf("CreateVerificationCode: %v", err)
	}
	if ok, _ := app.ConsumeVerificationCode(ctx, "a@example.test", crypto.SHA256Hex("222222")); ok {
		t.Error("a wrong code was accepted")
	}

	expiredID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if err := app.CreateVerificationCode(ctx, expiredID, "b@example.test",
		crypto.SHA256Hex("333333"), time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("CreateVerificationCode: %v", err)
	}
	if ok, _ := app.ConsumeVerificationCode(ctx, "b@example.test", crypto.SHA256Hex("333333")); ok {
		t.Error("an expired code was accepted")
	}
}

func TestCountRecentCodesBacksRateLimiting(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	const email = "rate@example.test"

	for i := 0; i < 3; i++ {
		id, err := store.NewID()
		if err != nil {
			t.Fatalf("NewID: %v", err)
		}
		if err := app.CreateVerificationCode(ctx, id, email,
			crypto.SHA256Hex("000000"), time.Now().Add(time.Minute)); err != nil {
			t.Fatalf("CreateVerificationCode: %v", err)
		}
	}

	recent, err := app.CountRecentCodes(ctx, email, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatalf("CountRecentCodes: %v", err)
	}
	if recent != 3 {
		t.Errorf("recent codes = %d, want 3", recent)
	}

	// A window that ends before the codes were issued counts none, so the limiter
	// cannot be tripped by unrelated history.
	older, err := app.CountRecentCodes(ctx, email, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("CountRecentCodes: %v", err)
	}
	if older != 0 {
		t.Errorf("codes in the future window = %d, want 0", older)
	}
}

func TestSessionLifecycle(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	_, user := newAccountWithOwner(t, app, "Session Test", "session@example.test")

	sessionID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if err := app.CreateSession(ctx, sessionID, user.ID, user.AccountID, nil, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	identity, err := app.ResolveSessionToken(ctx, sessionID)
	if err != nil {
		t.Fatalf("ResolveSessionToken: %v", err)
	}
	if identity.UserID != user.ID || identity.AccountID != user.AccountID {
		t.Errorf("session resolved to the wrong identity: %+v", identity)
	}
	if identity.Role != store.RoleOwner {
		t.Errorf("resolved role = %q, want owner", identity.Role)
	}
	if identity.AccountName == "" || !identity.Plan.Known() {
		t.Errorf("resolved identity is missing account details: %+v", identity)
	}

	if err := app.RevokeSession(ctx, sessionID); err != nil {
		t.Fatalf("RevokeSession: %v", err)
	}
	// Revocation must take effect immediately, not at the token's natural expiry.
	if _, err := app.ResolveSessionToken(ctx, sessionID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("revoked session is still resolvable: %v", err)
	}

	// Logging out twice is not an error: the client may retry.
	if err := app.RevokeSession(ctx, sessionID); err != nil {
		t.Errorf("second RevokeSession should be a no-op, got %v", err)
	}
}

func TestExpiredSessionIsNotActive(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	_, user := newAccountWithOwner(t, app, "Expired Test", "expired@example.test")

	sessionID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	// The row exists but its expiry has passed, so the database — not the JWT
	// alone — decides that the session is dead.
	if err := app.CreateSession(ctx, sessionID, user.ID, user.AccountID, nil, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := app.ResolveSessionToken(ctx, sessionID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expired session resolved as live: %v", err)
	}
}

func TestRevokeUserSessionsRevokesEveryDevice(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	_, user := newAccountWithOwner(t, app, "Revoke All", "revokeall@example.test")

	for i := 0; i < 3; i++ {
		sessionID, err := store.NewID()
		if err != nil {
			t.Fatalf("NewID: %v", err)
		}
		if err := app.CreateSession(ctx, sessionID, user.ID, user.AccountID, nil, time.Now().Add(time.Hour)); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
	}

	revoked, err := app.RevokeUserSessions(ctx, user.ID)
	if err != nil {
		t.Fatalf("RevokeUserSessions: %v", err)
	}
	if revoked != 3 {
		t.Errorf("revoked %d sessions, want 3", revoked)
	}
	// A second call has nothing left to revoke.
	again, err := app.RevokeUserSessions(ctx, user.ID)
	if err != nil {
		t.Fatalf("RevokeUserSessions: %v", err)
	}
	if again != 0 {
		t.Errorf("second call revoked %d, want 0", again)
	}
}

func TestInviteLifecycle(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, owner := newAccountWithOwner(t, app, "Invite Test", "inviteowner@example.test")

	inviteID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	invite, err := app.CreateInvite(ctx, inviteID, account.ID, "Guest@Example.test",
		store.RoleStaff, crypto.SHA256Hex("token"), owner.ID, time.Now().Add(72*time.Hour))
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if invite.Status != "pending" {
		t.Errorf("new invite status = %q, want pending", invite.Status)
	}

	// Lookup is case-insensitive, so a differently-cased invite email still matches.
	found, err := app.GetPendingInvite(ctx, "guest@example.test")
	if err != nil {
		t.Fatalf("GetPendingInvite: %v", err)
	}
	if found.ID != invite.ID {
		t.Errorf("found invite %q, want %q", found.ID, invite.ID)
	}

	if err := app.AcceptInvite(ctx, account.ID, invite.ID); err != nil {
		t.Fatalf("AcceptInvite: %v", err)
	}
	// Once accepted it is no longer pending, so a second acceptance cannot join
	// the account twice.
	if _, err := app.GetPendingInvite(ctx, "guest@example.test"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("accepted invite is still pending: %v", err)
	}
	if err := app.AcceptInvite(ctx, account.ID, invite.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("double accept should be refused, got %v", err)
	}
}

func TestExpiredInviteIsNotPending(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, owner := newAccountWithOwner(t, app, "Expired Invite", "expinvite@example.test")

	inviteID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if _, err := app.CreateInvite(ctx, inviteID, account.ID, "late@example.test",
		store.RoleStaff, crypto.SHA256Hex("t"), owner.ID, time.Now().Add(-time.Hour)); err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if _, err := app.GetPendingInvite(ctx, "late@example.test"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expired invite reported as pending: %v", err)
	}
}

func TestCountUsersIsClusterWide(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()

	before, err := app.CountUsers(ctx)
	if err != nil {
		t.Fatalf("CountUsers: %v", err)
	}

	newAccountWithOwner(t, app, "Count A", "counta@example.test")
	newAccountWithOwner(t, app, "Count B", "countb@example.test")

	after, err := app.CountUsers(ctx)
	if err != nil {
		t.Fatalf("CountUsers: %v", err)
	}
	// The bootstrap gate on /auth/setup depends on this being a whole-installation
	// count, not a per-tenant one.
	if after != before+2 {
		t.Errorf("CountUsers went from %d to %d, want +2", before, after)
	}
}

func TestUpdateAccountPlanAndPolicy(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, _ := newAccountWithOwner(t, app, "Plan Test", "plantest@example.test")

	updated, err := app.UpdateAccountPlan(ctx, account.ID, store.PlanBusiness)
	if err != nil {
		t.Fatalf("UpdateAccountPlan: %v", err)
	}
	if updated.Plan != store.PlanBusiness {
		t.Errorf("plan = %q, want business", updated.Plan)
	}
	// An unknown plan must be refused before it reaches the CHECK constraint, so
	// the caller gets a usable error instead of a constraint violation.
	if _, err := app.UpdateAccountPlan(ctx, account.ID, store.AccountPlan("nope")); err == nil {
		t.Error("UpdateAccountPlan accepted an unknown plan")
	}

	advance, months, zone := 30, 6, "Europe/Moscow"
	policyAccount, err := app.UpdateBookingPolicy(ctx, account.ID, store.BookingPolicyConfig{
		MaximumAdvanceDays: &advance,
		MaximumStayMonths:  &months,
		TimeZone:           &zone,
	})
	if err != nil {
		t.Fatalf("UpdateBookingPolicy: %v", err)
	}
	if policyAccount.BookingPolicy.MaximumAdvanceDays == nil || *policyAccount.BookingPolicy.MaximumAdvanceDays != 30 {
		t.Errorf("policy was not persisted: %+v", policyAccount.BookingPolicy)
	}

	// Reload to prove the value is stored rather than only echoed back.
	reloaded, err := app.GetAccountByID(ctx, account.ID)
	if err != nil {
		t.Fatalf("GetAccountByID: %v", err)
	}
	if reloaded.BookingPolicy.TimeZone == nil || *reloaded.BookingPolicy.TimeZone != "Europe/Moscow" {
		t.Errorf("reloaded policy timezone = %+v, want Europe/Moscow", reloaded.BookingPolicy.TimeZone)
	}
}

func TestGetAccountByIDMissingReturnsNotFound(t *testing.T) {
	app := repoStore(t)
	missing, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if _, err := app.GetAccountByID(context.Background(), missing); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestPlanEffectiveFailsClosed(t *testing.T) {
	// An unrecognized stored plan must be treated as the most restrictive tier.
	// Reading it as "unlimited" would hand out free capacity on corrupted data.
	if got := store.AccountPlan("enterprise").Effective(); got != store.PlanFree {
		t.Errorf("unknown plan effective = %q, want free", got)
	}
	if got := store.PlanBusiness.Effective(); got != store.PlanBusiness {
		t.Errorf("business effective = %q, want business", got)
	}
	if store.AccountPlan("enterprise").Known() {
		t.Error("unknown plan reported as known")
	}
}

func TestRolePermissions(t *testing.T) {
	// These predicates gate invite management and billing, so they are asserted
	// directly rather than only through an endpoint.
	if !store.RoleOwner.CanManageInvites() || !store.RoleOwner.CanManageBilling() {
		t.Error("owner should manage both invites and billing")
	}
	if !store.RoleAdmin.CanManageInvites() {
		t.Error("admin should manage invites")
	}
	if store.RoleAdmin.CanManageBilling() {
		t.Error("admin must not manage billing")
	}
	if store.RoleStaff.CanManageInvites() || store.RoleStaff.CanManageBilling() {
		t.Error("staff should manage neither")
	}
}
