// Package admin exposes the platform-operator surface: installation health, the account
// list, and the queue of offline-booking conflicts that need a human decision.
//
// It is authenticated by a static bearer key, completely separately from customer auth.
// An operator is not a tenant, so the endpoints deliberately bypass the tenant model —
// which is why they are the only place that reads across accounts, and why they live in
// their own package rather than being sprinkled through the customer router.
package admin

import (
	"context"
	"errors"
	"net/http"

	"github.com/inajaf/dombook/server/internal/crypto"
	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// Store is the persistence the admin surface needs. Every method on it runs as the
// BYPASSRLS role, so nothing here is reachable from a customer request path.
type Store interface {
	Overview(ctx context.Context) (*store.PlatformOverview, error)
	ListAccounts(ctx context.Context, limit int) ([]store.AccountSummary, error)
	GetAccountSummary(ctx context.Context, accountID string) (*store.AccountSummary, error)
	AdminSetAccountPlan(ctx context.Context, accountID string, plan store.AccountPlan) (*store.AccountSummary, error)
	CountAccountsByPlan(ctx context.Context) (map[string]int, error)
	ListConflicts(ctx context.Context, limit int) ([]store.AdminConflict, error)
	ResolveConflict(ctx context.Context, reservationID, resolution, actor string) error
}

// Deps is what the admin routes need.
type Deps struct {
	Store Store
	// APIKey is the shared operator secret. It is compared in constant time.
	APIKey string
}

// Server builds the admin router.
func Server(deps Deps) http.Handler {
	router := httpapi.NewRouter()
	guard := requireKey(deps.APIKey)

	router.Handle(http.MethodGet, "/admin/health", guard(func(ctx *httpapi.Context) error {
		// Unauthenticated liveness lives at /health; this one is guarded and additionally
		// proves the database is reachable from the admin role, which is a different
		// connection than the customer path uses and can fail independently.
		overview, err := deps.Store.Overview(ctx.Request.Context())
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{
			"ok":       true,
			"accounts": overview.Accounts,
		})
	}))

	router.Handle(http.MethodGet, "/admin/overview", guard(func(ctx *httpapi.Context) error {
		overview, err := deps.Store.Overview(ctx.Request.Context())
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, overview)
	}))

	router.Handle(http.MethodGet, "/admin/accounts", guard(func(ctx *httpapi.Context) error {
		accounts, err := deps.Store.ListAccounts(ctx.Request.Context(), queryLimit(ctx, 200))
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"accounts": accounts})
	}))

	router.Handle(http.MethodGet, "/admin/accounts/{id}", guard(func(ctx *httpapi.Context) error {
		summary, err := deps.Store.GetAccountSummary(ctx.Request.Context(), ctx.PathParam("id"))
		if err != nil {
			return translate(err)
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, summary)
	}))

	router.Handle(http.MethodGet, "/admin/plans", guard(func(ctx *httpapi.Context) error {
		counts, err := deps.Store.CountAccountsByPlan(ctx.Request.Context())
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{
			"plans": planCatalog(counts),
		})
	}))

	router.Handle(http.MethodPatch, "/admin/accounts/{id}/plan", guard(func(ctx *httpapi.Context) error {
		var input struct {
			Plan string `json:"plan"`
		}
		if err := ctx.DecodeJSON(&input); err != nil {
			return err
		}
		plan := store.AccountPlan(input.Plan)
		if !plan.Known() {
			return httpapi.BadRequest("validation_error", "Некорректный тариф плана",
				map[string]any{"field": "plan"})
		}
		summary, err := deps.Store.AdminSetAccountPlan(ctx.Request.Context(), ctx.PathParam("id"), plan)
		if err != nil {
			return translate(err)
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, summary)
	}))

	// The conflict queue. An offline push that collides with an existing stay is stored
	// with a status of `conflict` rather than rejected, so a guest's booking never
	// silently disappears — but someone has to decide what happens to it, and this is
	// where that happens.
	router.Handle(http.MethodGet, "/admin/conflicts", guard(func(ctx *httpapi.Context) error {
		conflicts, err := deps.Store.ListConflicts(ctx.Request.Context(), queryLimit(ctx, 100))
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"conflicts": conflicts})
	}))

	router.Handle(http.MethodPost, "/admin/conflicts/{id}/resolve", guard(func(ctx *httpapi.Context) error {
		var input struct {
			Resolution string `json:"resolution"`
		}
		if err := ctx.DecodeJSON(&input); err != nil {
			return err
		}
		if input.Resolution == "" {
			return httpapi.BadRequest("validation_error", "Укажите решение по конфликту",
				map[string]any{"field": "resolution"})
		}
		if err := deps.Store.ResolveConflict(ctx.Request.Context(),
			ctx.PathParam("id"), input.Resolution, "admin"); err != nil {
			return translate(err)
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"ok": true})
	}))

	return router
}

// requireKey guards every admin route with the shared operator key.
//
// The comparison is constant-time, because a byte-by-byte one would let an attacker
// recover the key character by character from response timing — and this key grants
// access to every tenant's data at once.
func requireKey(apiKey string) func(httpapi.Handler) httpapi.Handler {
	return func(next httpapi.Handler) httpapi.Handler {
		return func(ctx *httpapi.Context) error {
			token := httpapi.BearerToken(ctx.Request)
			// An unconfigured key refuses everything. Failing open here would expose the
			// whole platform to anyone who noticed the endpoint exists.
			if apiKey == "" || token == "" {
				return httpapi.Unauthorized("Требуется admin-ключ")
			}
			if !crypto.ConstantTimeEqual(token, apiKey) {
				return httpapi.Unauthorized("Неверный admin-ключ")
			}
			return next(ctx)
		}
	}
}

// queryLimit reads a bounded page size from the query string.
func queryLimit(ctx *httpapi.Context, fallback int) int {
	raw := ctx.Query("limit")
	if raw == "" {
		return fallback
	}
	value := 0
	for _, r := range raw {
		if r < '0' || r > '9' {
			return fallback
		}
		value = value*10 + int(r-'0')
		if value > 500 {
			return 500
		}
	}
	if value <= 0 {
		return fallback
	}
	return value
}

// planCatalog describes the available plans and how many accounts use each.
func planCatalog(counts map[string]int) []store.PlanCatalogEntry {
	// One unit on the free plan: the cap is per bookable unit, not per guest house, so a
	// free account with a single resort full of cottages is not unlimited.
	maxUnits := func(plan store.AccountPlan) string {
		if plan == store.PlanFree {
			return "1"
		}
		return "unlimited"
	}

	catalog := []store.PlanCatalogEntry{
		{
			ID: "free", Name: "Бесплатный",
			Description:  "1 объект размещения, локальные данные, ручные бэкапы",
			MaxUnits:     maxUnits(store.PlanFree),
			AccountCount: counts["free"],
		},
		{
			ID: "pro", Name: "Pro",
			Description:  "Промежуточный тариф: без лимитов, цена не определена",
			MaxUnits:     maxUnits(store.PlanPro),
			AccountCount: counts["pro"],
		},
		{
			ID: "business", Name: "Business",
			Description:  "Без лимитов: объекты и синхронизация",
			MaxUnits:     maxUnits(store.PlanBusiness),
			AccountCount: counts["business"],
		},
	}
	return catalog
}

// translate maps a store error to the wire error, keeping internal details out of the
// response. It mirrors the customer path's mapping for the cases the admin surface can
// actually produce.
func translate(err error) error {
	if err == nil {
		return nil
	}
	var apiErr *httpapi.ApiError
	if ok := asAPIError(err, &apiErr); ok {
		return apiErr
	}
	if isNotFound(err) {
		// The account id is the operator's own input here, so naming what was missing is
		// helpful rather than an enumeration risk: the caller already has full access.
		return httpapi.NotFound("account_not_found", "Учётная запись не найдена")
	}
	return err
}

// asAPIError and isNotFound use errors.As/is so a wrapped error is still recognized.
// Re-implementing the unwrap walk by hand would break on errors.Join, which the auth
// layer already uses.
func asAPIError(err error, target **httpapi.ApiError) bool {
	return errors.As(err, target)
}

func isNotFound(err error) bool {
	return errors.Is(err, store.ErrNotFound)
}
