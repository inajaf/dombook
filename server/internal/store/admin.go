package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Admin queries span tenants, which the RLS policies deliberately forbid. They run on a
// connection authenticated as dombook_admin, whose BYPASSRLS privilege is the sanctioned
// exception. Keeping them in this file means every cross-tenant read is visible in one
// place rather than scattered through the codebase behind a session flag.
//
// These are read-mostly and power the platform operator's view: is the service healthy,
// which accounts exist, what are they using, and which offline bookings collided.

// PlatformOverview is the aggregate health picture.
type PlatformOverview struct {
	Accounts                int            `json:"accounts"`
	Users                   int            `json:"users"`
	Invites                 int            `json:"invites"`
	Places                  int            `json:"places"`
	Units                   int            `json:"units"`
	Reservations            int            `json:"reservations"`
	Conflicts               int            `json:"conflicts"`
	UnresolvedConflictCount int            `json:"unresolvedConflicts"`
	PlansBreakdown          map[string]int `json:"plansBreakdown"`
}

// Overview counts rows across the whole installation.
func (s *Store) Overview(ctx context.Context) (*PlatformOverview, error) {
	overview := &PlatformOverview{PlansBreakdown: map[string]int{}}
	err := s.WithAdmin(ctx, func(tx pgx.Tx) error {
		// One round trip rather than seven: each count is independent and the operator
		// view is not latency-critical, but a single query is simpler to reason about and
		// keeps the numbers consistent with each other.
		err := tx.QueryRow(ctx, `
			SELECT
				(SELECT count(*) FROM accounts),
				(SELECT count(*) FROM users),
				(SELECT count(*) FROM invites WHERE status = 'pending' AND deleted_at IS NULL),
				(SELECT count(*) FROM places WHERE deleted_at IS NULL),
				(SELECT count(*) FROM units WHERE deleted_at IS NULL),
				(SELECT count(*) FROM reservations WHERE deleted_at IS NULL),
				(SELECT count(*) FROM reservations WHERE deleted_at IS NULL AND conflict_code IS NOT NULL),
				(SELECT count(*) FROM reservations WHERE deleted_at IS NULL AND conflict_code IS NOT NULL AND resolved_at IS NULL)`,
		).Scan(
			&overview.Accounts, &overview.Users, &overview.Invites,
			&overview.Places, &overview.Units, &overview.Reservations,
			&overview.Conflicts, &overview.UnresolvedConflictCount,
		)
		if err != nil {
			return err
		}

		rows, err := tx.Query(ctx, `SELECT plan, count(*) FROM accounts GROUP BY plan ORDER BY plan`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var plan string
			var count int
			if err := rows.Scan(&plan, &count); err != nil {
				return err
			}
			overview.PlansBreakdown[plan] = count
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return overview, nil
}

// AccountSummary is one account with its usage counts.
type AccountSummary struct {
	ID               string    `json:"id"`
	Name             string    `json:"name"`
	Plan             string    `json:"plan"`
	CreatedAt        time.Time `json:"createdAt"`
	UserCount        int       `json:"userCount"`
	InviteCount      int       `json:"inviteCount"`
	PlaceCount       int       `json:"placeCount"`
	UnitCount        int       `json:"unitCount"`
	ReservationCount int       `json:"reservationCount"`
	ConflictCount    int       `json:"conflictCount"`
	SyncVersion      int64     `json:"syncVersion"`
}

// accountSummaryColumns is shared by the list and single-account queries so the scan
// order cannot drift from the select list.
const accountSummaryColumns = `
	a.id, a.name, a.plan, a.created_at,
	(SELECT count(*) FROM users u WHERE u.account_id = a.id),
	(SELECT count(*) FROM invites i WHERE i.account_id = a.id AND i.status = 'pending' AND i.deleted_at IS NULL),
	(SELECT count(*) FROM places p WHERE p.tenant_id = a.id AND p.deleted_at IS NULL),
	(SELECT count(*) FROM units n WHERE n.tenant_id = a.id AND n.deleted_at IS NULL),
	(SELECT count(*) FROM reservations r WHERE r.tenant_id = a.id AND r.deleted_at IS NULL),
	(SELECT count(*) FROM reservations r WHERE r.tenant_id = a.id AND r.deleted_at IS NULL AND r.conflict_code IS NOT NULL),
	COALESCE((SELECT ts.version FROM tenant_state ts WHERE ts.tenant_id = a.id), 0)`

func scanAccountSummary(row rowScanner) (*AccountSummary, error) {
	var summary AccountSummary
	err := row.Scan(&summary.ID, &summary.Name, &summary.Plan, &summary.CreatedAt,
		&summary.UserCount, &summary.InviteCount, &summary.PlaceCount, &summary.UnitCount,
		&summary.ReservationCount, &summary.ConflictCount, &summary.SyncVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &summary, nil
}

// ListAccounts returns every account with its usage.
func (s *Store) ListAccounts(ctx context.Context, limit int) ([]AccountSummary, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	var accounts []AccountSummary
	err := s.WithAdmin(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT `+accountSummaryColumns+`
			FROM accounts a ORDER BY a.created_at DESC LIMIT $1`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			summary, err := scanAccountSummary(rows)
			if err != nil {
				return err
			}
			accounts = append(accounts, *summary)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return accounts, nil
}

// GetAccountSummary loads one account with its usage.
func (s *Store) GetAccountSummary(ctx context.Context, accountID string) (*AccountSummary, error) {
	var summary *AccountSummary
	err := s.WithAdmin(ctx, func(tx pgx.Tx) error {
		var err error
		summary, err = scanAccountSummary(tx.QueryRow(ctx, `
			SELECT `+accountSummaryColumns+` FROM accounts a WHERE a.id = $1`, accountID))
		return err
	})
	if err != nil {
		return nil, err
	}
	return summary, nil
}

// AdminSetAccountPlan changes an account's plan as a platform operator.
//
// It runs as the admin role rather than through WithTenant because the operator is not
// the account's tenant. The plan value is validated by the caller before reaching here.
func (s *Store) AdminSetAccountPlan(ctx context.Context, accountID string, plan AccountPlan) (*AccountSummary, error) {
	if !plan.Known() {
		return nil, fmt.Errorf("admin set plan: unknown plan %q", plan)
	}
	var summary *AccountSummary
	err := s.WithAdmin(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			"UPDATE accounts SET plan = $2, updated_at = now() WHERE id = $1", accountID, string(plan))
		if err != nil {
			return TranslateError(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		var scanErr error
		summary, scanErr = scanAccountSummary(tx.QueryRow(ctx, `
			SELECT `+accountSummaryColumns+` FROM accounts a WHERE a.id = $1`, accountID))
		return scanErr
	})
	if err != nil {
		return nil, err
	}
	return summary, nil
}

// PlanCatalogEntry is one plan with the number of accounts on it.
type PlanCatalogEntry struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	MaxUnits     string `json:"maxUnits"`
	AccountCount int    `json:"accountCount"`
}

// AdminConflict is an unresolved offline-booking collision.
//
// A conflict is stored rather than rejected: an offline client's booking is preserved
// with a status of `conflict` so a guest's reservation cannot silently vanish. Someone
// has to look at it, which is what this queue is for.
type AdminConflict struct {
	ReservationID   string     `json:"reservationId"`
	AccountID       string     `json:"accountId"`
	AccountName     string     `json:"accountName"`
	UnitID          string     `json:"unitId"`
	GuestName       string     `json:"guestName"`
	CheckInDate     Date       `json:"checkInDate"`
	CheckOutDate    Date       `json:"checkOutDate"`
	ConflictCode    string     `json:"conflictCode"`
	ConflictDetails []byte     `json:"conflictDetails"`
	CreatedAt       time.Time  `json:"createdAt"`
	ResolvedAt      *time.Time `json:"resolvedAt"`
}

// ListConflicts returns unresolved conflicts across every tenant, newest first.
func (s *Store) ListConflicts(ctx context.Context, limit int) ([]AdminConflict, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var conflicts []AdminConflict
	err := s.WithAdmin(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT r.id, r.tenant_id, a.name, r.unit_id, r.guest_name,
			       r.check_in_date, r.check_out_date,
			       COALESCE(r.conflict_code, ''), r.conflict_details, r.created_at, r.resolved_at
			FROM reservations r
			JOIN accounts a ON a.id = r.tenant_id
			WHERE r.deleted_at IS NULL
			  AND r.conflict_code IS NOT NULL
			  AND r.resolved_at IS NULL
			ORDER BY r.created_at DESC
			LIMIT $1`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var conflict AdminConflict
			if err := rows.Scan(&conflict.ReservationID, &conflict.AccountID, &conflict.AccountName,
				&conflict.UnitID, &conflict.GuestName, &conflict.CheckInDate, &conflict.CheckOutDate,
				&conflict.ConflictCode, &conflict.ConflictDetails, &conflict.CreatedAt,
				&conflict.ResolvedAt); err != nil {
				return err
			}
			conflicts = append(conflicts, conflict)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return conflicts, nil
}

// ResolveConflict marks a conflict as reviewed.
func (s *Store) ResolveConflict(ctx context.Context, reservationID, resolution, actor string) error {
	return s.WithAdmin(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE reservations
			SET resolved_at = now(),
			    conflict_details = COALESCE(conflict_details, '{}'::jsonb) ||
			        jsonb_build_object('resolution', $2::text, 'resolvedBy', $3::text),
			    updated_at = now()
			WHERE id = $1 AND deleted_at IS NULL`, reservationID, resolution, actor)
		if err != nil {
			return TranslateError(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// CountAccountsByPlan backs the admin plan catalog.
func (s *Store) CountAccountsByPlan(ctx context.Context) (map[string]int, error) {
	counts := map[string]int{}
	err := s.WithAdmin(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT plan, count(*) FROM accounts GROUP BY plan`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var plan string
			var count int
			if err := rows.Scan(&plan, &count); err != nil {
				return err
			}
			counts[plan] = count
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return counts, nil
}
