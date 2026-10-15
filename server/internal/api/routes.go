// Package api wires HTTP routes to the services. It is the layer that decides
// which endpoint exists, which guard protects it, and how a decoded request maps
// onto a service call — nothing more. Business rules live in the service packages,
// SQL lives in store, and the wire shapes live here.
package api

import (
	"context"
	"net/http"
	"time"

	"github.com/inajaf/dombook/server/internal/auth"
	"github.com/inajaf/dombook/server/internal/domainservice"
	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// Deps is everything the routes need. Passing a struct rather than a long argument
// list keeps the composition root readable as the surface grows.
type Deps struct {
	Auth   *auth.Service
	Domain *domainservice.Service
	// Store is the narrow surface the invitation routes need. The domain service does not
	// expose invitations, so they are mounted directly against the store rather than
	// inventing a service method that only wraps one call.
	Store InviteStore
}

// InviteStore is the slice of the store the invitation routes use.
//
// An interface rather than the concrete store so the routes can be tested with a fake, and so
// it is obvious at a glance what these routes are allowed to touch.
type InviteStore interface {
	ListUsersForAccount(ctx context.Context, accountID string) ([]store.User, error)
	ListInvites(ctx context.Context, tenantID string) ([]store.Invite, error)
	FindPendingInvite(ctx context.Context, tenantID, email string) (*store.Invite, error)
	CreateInvite(ctx context.Context, inviteID, accountID, email string, role store.UserRole, tokenHash, createdBy string, expiresAt time.Time) (*store.Invite, error)
	RevokeInvite(ctx context.Context, tenantID, inviteID string) error
}

// CORSConfig is re-exported so the composition root does not need to import
// httpapi directly just to describe its origins.
type CORSConfig = httpapi.CORSConfig

// BuildHandler assembles the full middleware stack around the API routes.
//
// It lives here rather than in main so that tests can exercise the same stack the
// server serves. A test that assembled its own chain would be verifying a handler
// no client ever talks to — and the layers it skipped (panic recovery, request ids,
// CORS) are exactly the ones that fail silently.
func BuildHandler(deps Deps, cors CORSConfig) (http.Handler, error) {
	if err := httpapi.ValidateCORS(cors); err != nil {
		return nil, err
	}
	return httpapi.Chain(
		Server(deps),
		// Outermost first: recovery must catch a panic from anything inside, and the
		// request id must already be set so even a panic response is traceable.
		httpapi.RecoverPanic,
		httpapi.RequestID,
		httpapi.AccessLog,
		// Innermost, so a preflight request is answered before any auth applies.
		httpapi.CORS(cors),
	), nil
}

// Server builds the HTTP handler for the API routes alone, without middleware.
func Server(deps Deps) http.Handler {
	router := httpapi.NewRouter()
	resolver := identityResolver{auth: deps.Auth}

	registerAuthRoutes(router, deps, resolver)

	// Domain routes are only registered when the service is present, so the auth-only
	// handler used by the auth tests stays valid without a domain store.
	if deps.Domain != nil {
		registerPlaceRoutes(router, deps, resolver)
		registerUnitRoutes(router, deps, resolver)
		registerReservationRoutes(router, deps, resolver)
		registerAccountRoutes(router, deps, resolver)
		registerPolicyRoutes(router, deps, resolver)
		registerInviteRoutes(router, deps, resolver)
		registerEntitlementRoutes(router, deps, resolver)
		registerSyncRoutes(router, deps, resolver)
	}

	// Liveness. Deliberately unauthenticated and cheap: it must stay answerable
	// while the database is unreachable, otherwise it cannot distinguish "the
	// process is down" from "the database is down" for a load balancer.
	router.Handle(http.MethodGet, "/health", func(ctx *httpapi.Context) error {
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"ok": true})
	})

	return router
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

func registerAuthRoutes(router *httpapi.Router, deps Deps, resolver httpapi.TokenResolver) {
	router.Handle(http.MethodPost, "/auth/setup", func(ctx *httpapi.Context) error {
		var input auth.SetupInput
		if err := ctx.DecodeJSON(&input); err != nil {
			return err
		}
		account, user, err := deps.Auth.Setup(ctx.Request.Context(), input)
		if err != nil {
			return err
		}
		// 201 rather than 200: a resource was created, and a client that retries on
		// network failure benefits from the distinction.
		return httpapi.WriteJSONStatus(ctx, http.StatusCreated, map[string]any{
			"ok":        true,
			"accountId": account.ID,
			"user":      publicUser(user),
		})
	})

	router.Handle(http.MethodPost, "/auth/send", func(ctx *httpapi.Context) error {
		var input struct {
			Email string `json:"email"`
		}
		if err := ctx.DecodeJSON(&input); err != nil {
			return err
		}
		result, err := deps.Auth.SendCode(ctx.Request.Context(), input.Email)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, result)
	})

	router.Handle(http.MethodPost, "/auth/verify", func(ctx *httpapi.Context) error {
		var input auth.VerifyInput
		if err := ctx.DecodeJSON(&input); err != nil {
			return err
		}
		session, err := deps.Auth.Verify(ctx.Request.Context(), input)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, session)
	})

	router.Handle(http.MethodPost, "/auth/refresh", func(ctx *httpapi.Context) error {
		var input struct {
			RefreshToken string `json:"refreshToken"`
		}
		if err := ctx.DecodeJSON(&input); err != nil {
			return err
		}
		result, err := deps.Auth.Refresh(ctx.Request.Context(), input.RefreshToken)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, result)
	})

	router.Handle(http.MethodGet, "/auth/me", httpapi.RequireAuth(resolver, func(ctx *httpapi.Context) error {
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{
			"user": auth.UserView{
				ID:    ctx.UserID,
				Email: ctx.Email,
				Name:  ctx.Name,
				Role:  ctx.Role,
			},
			"accountId":   ctx.AccountID,
			"accountName": ctx.AccountName,
			"plan":        ctx.Plan,
		})
	}))

	// Logout is deliberately UNGUARDED.
	//
	// Requiring a live session to log out is a trap: once the session is revoked —
	// the normal case after a successful logout, and the case a client retrying a
	// flaky request hits — the endpoint answers 401 and the client cannot confirm
	// the state it is already in. The service verifies the token itself and treats
	// an unknown, expired, or already-revoked session as success, because the
	// caller's goal (this session is over) is satisfied either way.
	//
	// This reveals nothing: the token is the caller's own credential, and the
	// response is identical whether or not it was ever valid.
	router.Handle(http.MethodPost, "/auth/logout", func(ctx *httpapi.Context) error {
		if err := deps.Auth.Logout(ctx.Request.Context(), httpapi.BearerToken(ctx.Request)); err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"ok": true})
	})
}

// nowUTC renders the current time in the shape the sync protocol uses.
func nowUTC() string {
	return time.Now().UTC().Truncate(time.Microsecond).Format("2006-01-02T15:04:05.000000Z")
}

// registerEntitlementRoutes exposes what an account has paid for.
//
// Readable by any signed-in member: every device needs to know whether the account is
// licensed in order to decide what it may do, and hiding it from staff would mean only the
// owner's device behaved correctly.
func registerEntitlementRoutes(router *httpapi.Router, deps Deps, resolver httpapi.TokenResolver) {
	router.Handle(http.MethodGet, "/account/entitlements", httpapi.RequireAuth(resolver, func(ctx *httpapi.Context) error {
		view, err := deps.Domain.EntitlementView(ctx.Request.Context(), ctx.AccountID)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, view)
	}))
}

// registerPolicyRoutes exposes the account's booking window.
//
// Reading it is available to any signed-in member, because the client needs it to render
// the date picker correctly. Changing it is owner-only: the window governs what every
// member of the account may book, so it is an account-level decision rather than a
// personal preference.
func registerPolicyRoutes(router *httpapi.Router, deps Deps, resolver httpapi.TokenResolver) {
	router.Handle(http.MethodGet, "/account/booking-policy", httpapi.RequireAuth(resolver, func(ctx *httpapi.Context) error {
		view, err := deps.Domain.BookingPolicy(ctx.Request.Context(), ctx.AccountID)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, view)
	}))

	router.Handle(http.MethodPatch, "/account/booking-policy",
		httpapi.RequireAuth(resolver, httpapi.RequireRole("owner")(func(ctx *httpapi.Context) error {
			var update domainservice.BookingPolicyUpdate
			if err := ctx.DecodeJSON(&update); err != nil {
				return err
			}
			view, err := deps.Domain.SetBookingPolicy(ctx.Request.Context(), ctx.AccountID, update)
			if err != nil {
				return err
			}
			return httpapi.WriteJSONStatus(ctx, http.StatusOK, view)
		})))
}

// registerAccountRoutes exposes the account's plan and consumption, which the desktop
// sidebar renders and the upgrade prompt depends on.
func registerAccountRoutes(router *httpapi.Router, deps Deps, resolver httpapi.TokenResolver) {
	router.Handle(http.MethodGet, "/account/plan", httpapi.RequireAuth(resolver, func(ctx *httpapi.Context) error {
		view, err := deps.Domain.AccountPlan(ctx.Request.Context(), ctx.AccountID)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, view)
	}))
}

// publicUser renders a store row for a response.
//
// It is a function rather than a JSON tag on the store type so that adding a column
// later — an internal flag, a hash — cannot silently start appearing in API
// responses. The mapping is explicit and reviewed once, at the boundary where an
// internal representation becomes a public one.
func publicUser(user *store.User) auth.UserView {
	if user == nil {
		return auth.UserView{}
	}
	return auth.UserView{
		ID:    user.ID,
		Email: user.Email,
		Name:  user.Name,
		Role:  string(user.Role),
	}
}
