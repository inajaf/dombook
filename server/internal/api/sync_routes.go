package api

import (
	"net/http"
	"strings"

	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// Sync endpoints.
//
// The protocol is a watermark plus a batch of rows: the client stores the `state.version`
// it last saw and sends it as `since`, and pushes rows it changed offline. Everything a
// device needs to converge is in these two calls.
//
// Two properties are load-bearing and easy to break:
//
//   - The watermark is SERVER-monotonic. A client never supplies it, and it is not a
//     timestamp, so a device with a wrong clock cannot skip another device's changes.
//   - The push response reports per-ROW outcomes. "Applied" and "your change lost" are
//     different events with different client handling, and a bare count cannot express
//     which is which.

func registerSyncRoutes(router *httpapi.Router, deps Deps, resolver httpapi.TokenResolver) {
	guard := func(next httpapi.Handler) httpapi.Handler {
		return httpapi.RequireAuth(resolver, next)
	}

	router.Handle(http.MethodGet, "/sync/pull", guard(func(ctx *httpapi.Context) error {
		since := parseSince(ctx)
		changes, version, err := deps.Domain.Pull(ctx.Request.Context(), ctx.AccountID, since)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{
			"state": map[string]any{
				"version": version,
				// The client stores this only for display; ordering is the version, never
				// this timestamp.
				"updatedAt": nowUTC(),
			},
			"changes": changes,
		})
	}))

	router.Handle(http.MethodPost, "/sync/push", guard(func(ctx *httpapi.Context) error {
		var body struct {
			ClientID string                     `json:"clientId"`
			Changes  map[string][]store.SyncRow `json:"changes"`
		}
		// Loose decoding: a newer client may send columns this server does not know yet,
		// and rejecting the whole push over an unrecognized field would make every
		// forward-compatible client change a breaking one.
		if err := ctx.DecodeJSONLoose(&body); err != nil {
			return err
		}

		clientID := strings.TrimSpace(body.ClientID)
		if clientID == "" {
			clientID = "unknown"
		}
		// Bounded so a malformed payload cannot store an unbounded writer string, which
		// would then be echoed back in every conflict report.
		if len(clientID) > 64 {
			clientID = clientID[:64]
		}

		changes := map[store.SyncTable][]store.SyncRow{}
		for name, rows := range body.Changes {
			if !store.IsSyncTable(name) {
				// An unknown table is a client error worth reporting: silently ignoring it
				// would make a client believe it had synced data the server never stored.
				return httpapi.BadRequest("unknown_table",
					"Неизвестная таблица: "+name, map[string]any{"table": name})
			}
			changes[store.SyncTable(name)] = rows
		}

		result, err := deps.Domain.Push(ctx.Request.Context(), ctx.AccountID, clientID, changes)
		if err != nil {
			return err
		}

		// The version is returned so the client can advance its cursor without a
		// follow-up pull. It is read after the push committed, so it reflects every row
		// this batch stored.
		version, err := deps.Domain.CurrentVersion(ctx.Request.Context(), ctx.AccountID)
		if err != nil {
			return err
		}

		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{
			"state": map[string]any{
				"version":   version,
				"updatedAt": nowUTC(),
			},
			"applied":   result.Applied,
			"stale":     result.Stale,
			"conflicts": result.Conflict,
			"rejected":  result.Rejected,
			"results":   result.Results,
		})
	}))

	// A full snapshot of every row, used by the desktop backup and by a client that lost
	// its local database. It is a pull with no watermark, so it cannot drift from the
	// incremental path.
	router.Handle(http.MethodGet, "/backups/export", guard(func(ctx *httpapi.Context) error {
		changes, version, err := deps.Domain.Pull(ctx.Request.Context(), ctx.AccountID, -1)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{
			"exportedAt":    nowUTC(),
			"schemaVersion": "sync_v2",
			"accountId":     ctx.AccountID,
			"state":         map[string]any{"version": version},
			"data":          changes,
		})
	}))
}

// parseSince reads the pull watermark.
//
// A negative or unparseable value means "everything" rather than zero: zero would also
// return everything, but a client sending a negative cursor is asking for a full resync,
// and treating that as an error would leave it unable to recover.
func parseSince(ctx *httpapi.Context) int64 {
	raw := strings.TrimSpace(ctx.Query("since"))
	if raw == "" {
		return 0
	}
	negative := strings.HasPrefix(raw, "-")
	digits := strings.TrimPrefix(raw, "-")

	var value int64
	for _, r := range digits {
		if r < '0' || r > '9' {
			return -1
		}
		value = value*10 + int64(r-'0')
		// Guard against a cursor so large it would overflow; any value beyond the
		// watermark behaves identically anyway.
		if value > 1<<52 {
			return -1
		}
	}
	if negative {
		return -1
	}
	return value
}
