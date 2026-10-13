package api

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/inajaf/dombook/server/internal/crypto"
	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// Team invitation routes.
//
// The store layer already implemented invitations (creation, lookup, acceptance, revocation);
// only the HTTP surface was missing. That gap mattered for the cutover: the legacy backend
// exposed these routes, so removing it would have silently taken away the ability to add a
// colleague to an account — a feature the product description lists, not a nicety.
//
// The contract matches the legacy routes so an existing client keeps working:
//
//	GET  /auth/invites            → { invites: [...] }
//	POST /auth/invites            → 201 { invite, inviteToken }
//	POST /auth/invites/{id}/revoke → { ok, invite }
//
// The token is returned exactly once, in the creation response, because only its hash is
// stored. That is what makes an invite safe to keep in the database: a leaked row cannot be
// turned back into a working link.

// inviteLifetime is how long an invitation stays usable.
//
// Thirty days is long enough for a colleague to get round to it and short enough that a link
// forgotten in an inbox stops working.
const inviteLifetime = 30 * 24 * time.Hour

// emailPattern is deliberately permissive.
//
// A stricter pattern rejects addresses that are valid and unusual (long TLDs, plus
// addressing), and the invitation email is the real verification: if the address is wrong,
// nobody accepts it. This only catches obvious typos.
var emailPattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

type inviteView struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	Status    string `json:"status"`
	ExpiresAt string `json:"expiresAt"`
	CreatedAt string `json:"createdAt"`
}

func toInviteView(invite store.Invite) inviteView {
	return inviteView{
		ID:        invite.ID,
		Email:     invite.Email,
		Role:      string(invite.Role),
		Status:    invite.Status,
		ExpiresAt: invite.ExpiresAt.UTC().Format(time.RFC3339),
		CreatedAt: invite.CreatedAt.UTC().Format(time.RFC3339),
	}
}

// registerInviteRoutes mounts the invitation endpoints.
//
// Owner and admin only. Inviting someone grants access to the account's data, so it is an
// administrative act rather than something every member may do.
func registerInviteRoutes(router *httpapi.Router, deps Deps, resolver httpapi.TokenResolver) {
	managers := httpapi.RequireRole("owner", "admin")

	router.Handle(http.MethodGet, "/auth/invites",
		httpapi.RequireAuth(resolver, managers(func(ctx *httpapi.Context) error {
			invites, err := deps.Store.ListInvites(ctx.Request.Context(), ctx.AccountID)
			if err != nil {
				return err
			}
			views := make([]inviteView, 0, len(invites))
			for _, invite := range invites {
				views = append(views, toInviteView(invite))
			}
			return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"invites": views})
		})))

	router.Handle(http.MethodPost, "/auth/invites",
		httpapi.RequireAuth(resolver, managers(func(ctx *httpapi.Context) error {
			var body struct {
				Email string `json:"email"`
				Role  string `json:"role"`
			}
			if err := ctx.DecodeJSON(&body); err != nil {
				return err
			}

			email := strings.ToLower(strings.TrimSpace(body.Email))
			if !emailPattern.MatchString(email) {
				return httpapi.BadRequest("validation_error", "Некорректный email", nil)
			}

			// Anything other than an explicit "admin" is staff. Defaulting the other way
			// would mean a typo in the request hands out administrative rights.
			role := store.RoleStaff
			if body.Role == "admin" {
				role = store.RoleAdmin
			}

			// A second invitation to the same address would leave two live links, and
			// revoking one would not close the other.
			existing, err := deps.Store.FindPendingInvite(ctx.Request.Context(), ctx.AccountID, email)
			if err != nil {
				return err
			}
			if existing != nil {
				return httpapi.BadRequest("invite_exists", "Приглашение для этого email уже отправлено", nil)
			}

			token, err := crypto.RandomToken(32)
			if err != nil {
				return err
			}
			inviteID, err := store.NewID()
			if err != nil {
				return err
			}

			invite, err := deps.Store.CreateInvite(ctx.Request.Context(), inviteID, ctx.AccountID,
				email, role, crypto.SHA256Hex(token), ctx.UserID, time.Now().Add(inviteLifetime))
			if err != nil {
				return err
			}

			// The plaintext token is returned once and never stored. Only its hash is kept,
			// so a leaked database row cannot be turned back into a working invitation.
			return httpapi.WriteJSONStatus(ctx, http.StatusCreated, map[string]any{
				"invite":      toInviteView(*invite),
				"inviteToken": token,
			})
		})))

	router.Handle(http.MethodPost, "/auth/invites/{id}/revoke",
		httpapi.RequireAuth(resolver, managers(func(ctx *httpapi.Context) error {
			inviteID := ctx.PathParam("id")
			if inviteID == "" {
				return httpapi.BadRequest("validation_error", "Не указан идентификатор приглашения", nil)
			}

			// The revoke is scoped by tenant inside the store, so an owner of one account
			// cannot revoke another account's invitation by guessing an id.
			if err := deps.Store.RevokeInvite(ctx.Request.Context(), ctx.AccountID, inviteID); err != nil {
				if errors.Is(err, store.ErrNotFound) {
					return httpapi.NotFound("invite_not_found", "Приглашение не найдено")
				}
				return err
			}

			invites, err := deps.Store.ListInvites(ctx.Request.Context(), ctx.AccountID)
			if err != nil {
				return err
			}
			for _, invite := range invites {
				if invite.ID == inviteID {
					return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{
						"ok": true, "invite": toInviteView(invite),
					})
				}
			}
			// Revoked invites are not part of the pending list, so reaching here means the
			// revocation worked and there is simply nothing left to describe.
			return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"ok": true})
		})))
}
