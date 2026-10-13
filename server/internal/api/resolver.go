package api

import (
	"context"

	"github.com/inajaf/dombook/server/internal/auth"
	"github.com/inajaf/dombook/server/internal/httpapi"
)

// identityResolver adapts the auth service to the transport's TokenResolver.
//
// The adapter exists so that dependency points one way: httpapi declares what it
// needs and never imports the service layer, while api — which already knows both —
// does the translation. Without it, httpapi would have to import auth and the two
// packages would form a cycle as soon as auth needed a transport type.
type identityResolver struct {
	auth *auth.Service
}

// ResolveToken validates an access token and returns the caller's identity.
//
// The service's error is returned untouched: it is already an *ApiError with the
// right status and a message intended for the client, and re-wrapping it here would
// only risk turning a 401 into a 500.
func (r identityResolver) ResolveToken(ctx context.Context, token string) (*httpapi.Identity, error) {
	current, err := r.auth.Current(ctx, token)
	if err != nil {
		return nil, err
	}
	return &httpapi.Identity{
		UserID:      current.User.ID,
		AccountID:   current.AccountID,
		AccountName: current.AccountName,
		Plan:        current.Plan,
		Role:        current.User.Role,
		Email:       current.User.Email,
		Name:        current.User.Name,
		SessionID:   current.SessionID,
	}, nil
}
