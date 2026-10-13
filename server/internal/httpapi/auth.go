package httpapi

import (
	"context"
	"net/http"
	"strings"
)

// Identity is the authenticated caller, as resolved from an access token.
//
// It is declared here rather than in the auth package so that this package does
// not depend on the service layer: the transport defines what it needs, and the
// service satisfies it. That keeps the import direction one-way and lets handlers
// be tested with a stub identity.
type Identity struct {
	UserID      string
	AccountID   string
	AccountName string
	Plan        string
	Role        string
	Email       string
	Name        string
	SessionID   string
}

// TokenResolver turns a bearer token into an identity.
//
// The interface is named for what it does with the token rather than for the type
// it returns, so an adapter type can also be called IdentityResolver without a
// collision, and so this package never needs to import the service layer.
type TokenResolver interface {
	// ResolveToken returns the identity for a token, or an error that is already
	// an *ApiError describing why it was refused. A nil identity with a nil error
	// is treated as unauthenticated.
	ResolveToken(ctx context.Context, token string) (*Identity, error)
}

// Context carries everything a handler needs: the request, its path parameters,
// and the authenticated identity when the route is guarded.
type Context struct {
	Request *http.Request
	Params  map[string]string
	Writer  http.ResponseWriter

	// Identity is zero-valued on unguarded routes.
	Identity

	// DeviceID is set when the request carries a registered device (X-Device-Id).
	DeviceID string
}

// RequireAuth wraps a handler so it only runs for an authenticated caller.
//
// Rejections return 401 with no detail about which check failed: a client should
// learn "authenticate", not whether the token was expired, revoked, or forged.
// That distinction is useful to an attacker and useless to a legitimate client,
// which must re-authenticate in every one of those cases.
func RequireAuth(resolver TokenResolver, next Handler) Handler {
	return func(ctx *Context) error {
		token := BearerToken(ctx.Request)
		if token == "" {
			return Unauthorized("Требуется авторизация")
		}

		identity, err := resolver.ResolveToken(ctx.Request.Context(), token)
		if err != nil {
			return err
		}
		if identity == nil {
			return Unauthorized("Требуется авторизация")
		}

		ctx.Identity = *identity
		ctx.DeviceID = strings.TrimSpace(ctx.Request.Header.Get("X-Device-Id"))
		return next(ctx)
	}
}

// RequireRole wraps a guarded handler so it additionally requires one of the given
// roles.
//
// This is defence in depth rather than the primary check: a handler that performs a
// role-sensitive action (changing the plan, inviting a user) should still be
// reachable only through this guard, and the query it runs is tenant-scoped
// regardless. The guard exists so that forgetting the check in a new handler fails
// closed instead of open.
func RequireRole(roles ...string) func(Handler) Handler {
	allowed := make(map[string]struct{}, len(roles))
	for _, role := range roles {
		allowed[role] = struct{}{}
	}

	return func(next Handler) Handler {
		return func(ctx *Context) error {
			if _, ok := allowed[ctx.Role]; !ok {
				return Forbidden("forbidden", "Недостаточно прав для этого действия")
			}
			return next(ctx)
		}
	}
}

// BearerToken extracts a bearer token from the Authorization header.
//
// The scheme comparison is case-insensitive because HTTP specifies it that way and
// clients vary; the token itself is returned untouched.
func BearerToken(request *http.Request) string {
	header := strings.TrimSpace(request.Header.Get("Authorization"))
	const prefix = "bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}
