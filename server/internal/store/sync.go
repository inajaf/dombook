package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Sync v2 push and pull.
//
// Three things changed from the first implementation, each fixing a way devices could
// diverge:
//
//  1. SERVER TIMESTAMPS. The conflict order used to be decided by the `updated_at` the
//     CLIENT supplied, which meant a device with a fast clock won every conflict
//     forever, and one with a slow clock lost every conflict forever. Rows are now
//     stamped with the server's clock on write, so ordering is decided by a single
//     authority and clock skew cannot influence it.
//
//  2. ATOMIC PUSH. The tenant watermark used to be bumped before the row was written, on
//     separate statements. A failure in between left the watermark advanced past a change
//     that never landed — invisible to every future pull. Each push now runs in one
//     transaction.
//
//  3. PER-ROW OUTCOMES. A push used to either apply a row or silently skip it. The
//     client could not tell "someone else's change won" from "your change was lost", and
//     a night collision surfaced as an unhandled constraint error. Every row now reports
//     applied / stale / conflict.

// PushOutcome is what happened to one pushed row.
type PushOutcome string

const (
	// OutcomeApplied: the server stored the row.
	OutcomeApplied PushOutcome = "applied"
	// OutcomeStale: the server already had a newer version, so the incoming row lost.
	// The client keeps the server's copy; nothing was lost.
	OutcomeStale PushOutcome = "stale"
	// OutcomeConflict: the row could not be applied because it collides with existing
	// data. It was still STORED, flagged, and queued for an operator, so the guest's
	// booking does not disappear.
	OutcomeConflict PushOutcome = "conflict"
	// OutcomeRejected: the row is unusable (missing required columns, unknown table).
	OutcomeRejected PushOutcome = "rejected"
)

// RowResult reports the fate of one pushed row.
type RowResult struct {
	Table   SyncTable   `json:"table"`
	ID      string      `json:"id"`
	Outcome PushOutcome `json:"outcome"`
	// Reason is a stable machine-readable code, not a localized sentence: the client
	// decides what to show, and sync runs unattended.
	Reason string `json:"reason,omitempty"`
	// ConflictDates names the nights that collided, when the outcome is a conflict.
	ConflictDates []string `json:"conflictDates,omitempty"`
	// Version is the server-assigned version when the row was applied.
	Version int64 `json:"version,omitempty"`
	// Retryable marks a rejected row that may succeed later — its parent has not been pushed
	// yet, for instance. A row that is NOT retryable will never be accepted (it exceeds the
	// account's allowance, or the schema refuses it), and the client must not let it block the
	// rest of the queue: one over-allowance unit would otherwise stop the account syncing
	// anything, forever.
	Retryable bool `json:"retryable,omitempty"`
}

// PushResult is the outcome of a whole push.
type PushResult struct {
	Applied  int         `json:"applied"`
	Stale    int         `json:"stale"`
	Conflict int         `json:"conflicts"`
	Rejected int         `json:"rejected"`
	Results  []RowResult `json:"results"`
}

// PullChanges is every replicated row changed after the given watermark.
type PullChanges struct {
	Places              []SyncRow `json:"places"`
	Units               []SyncRow `json:"units"`
	Reservations        []SyncRow `json:"reservations"`
	ReservationNights   []SyncRow `json:"reservation_nights"`
	ReservationServices []SyncRow `json:"reservation_services"`
	ReservationMeals    []SyncRow `json:"reservation_meals"`
	AppSettings         []SyncRow `json:"app_settings"`
}

// Push applies a batch of client changes.
//
// The whole batch runs in ONE transaction. That is what makes the watermark honest: a
// pull after a failed push sees either all of the batch or none of it, never a version
// that advanced past rows which were not stored.
func (s *Store) Push(ctx context.Context, tenantID, clientID string, changes map[SyncTable][]SyncRow) (*PushResult, error) {
	result := &PushResult{Results: make([]RowResult, 0, 16)}

	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		// Reservations whose nights are already taken are identified BEFORE anything is
		// written.
		//
		// This has to happen as a batch, not row by row. A client sends a booking and its
		// nights as separate rows, and the nights carry a unique index; inserting them
		// after the booking was stored as a conflict aborts the whole transaction on that
		// index, taking every other row in the batch with it. Planning the batch first is
		// what lets the booking be preserved while its nights are skipped.
		conflicted, conflictDates, err := s.planConflicts(ctx, tx, tenantID, changes)
		if err != nil {
			return err
		}

		// Rows the server refused. A child whose parent was refused cannot be written — the
		// foreign key would abort the transaction — so the child is refused as well, with a
		// reason that names the real cause instead of a constraint name nobody can act on.
		rejected := map[SyncTable]map[string]bool{}

		// Deterministic ordering keeps the reported results reproducible for a given
		// payload, which matters when an operator is comparing two client logs.
		for _, table := range SyncTables {
			rows, present := changes[table]
			if !present {
				continue
			}
			for rowIndex, row := range rows {
				// A row whose chain of ancestors was refused is refused too, checked before
				// anything is written so the foreign key never fires.
				//
				// The walk is transitive on purpose: a unit is refused because its place was
				// refused, and the unit's bookings must be refused as well. Checking only the
				// immediate parent let a reservation through after its unit was skipped, and
				// the foreign key then aborted the entire batch — the same failure this is
				// meant to prevent, one level down.
				if ancestor := refusedAncestor(table, row, rejected); ancestor != "" {
					if rejected[table] == nil {
						rejected[table] = map[string]bool{}
					}
					rejected[table][row.idOf()] = true
					result.Results = append(result.Results, RowResult{
						Table: table, ID: row.idOf(), Outcome: OutcomeRejected,
						Reason: "parent_rejected:" + ancestor,
					})
					result.Rejected++
					continue
				}

				// Nights belonging to a conflicted booking are skipped, not written: they
				// are the rows that collided.
				if table == TableReservationNights {
					if reservationID := asString(row["reservation_id"]); conflicted[reservationID] {
						result.Results = append(result.Results, RowResult{
							Table: table, ID: row.idOf(), Outcome: OutcomeConflict,
							Reason: "night_conflict", ConflictDates: conflictDates[reservationID],
						})
						result.Conflict++
						continue
					}
				}

				// Each row runs inside its own savepoint.
				//
				// A refused INSERT aborts the whole PostgreSQL transaction — every later
				// statement fails with "current transaction is aborted" — so without a
				// savepoint one bad row takes the entire push with it. That is exactly what
				// happened when a free account exceeded its place allowance by one: the
				// trigger refused the second place and the account could not sync ANYTHING,
				// including bookings for the unit it was entitled to.
				savepoint := fmt.Sprintf("sync_row_%s_%d", table, rowIndex)
				if _, err := tx.Exec(ctx, "SAVEPOINT "+savepoint); err != nil {
					return err
				}

				outcome, err := s.pushRow(ctx, tx, tenantID, clientID, table, row, conflicted, conflictDates)
				if err != nil {
					if _, rollbackErr := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+savepoint); rollbackErr != nil {
						return rollbackErr
					}
					// Left in deliberately: a refused row is the single most useful line for
					// diagnosing a client's failed sync, and it names the row so an operator
					// can find it.
					slog.Warn("sync row refused", "table", table, "id", row.idOf(),
						"reason", err.Error())
					// A row refused by POLICY is that row's problem, not the batch's. It is
					// reported as rejected and the rest are applied, which is the per-row
					// contract the client already expects.
					switch {
					case isPermanentRejection(err):
						if rejected[table] == nil {
							rejected[table] = map[string]bool{}
						}
						rejected[table][row.idOf()] = true
						result.Results = append(result.Results, RowResult{
							Table: table, ID: row.idOf(), Outcome: OutcomeRejected,
							Reason: planLimitReason(err),
						})
						result.Rejected++
						continue
					case isForeignKeyViolation(err):
						// A dependency this batch did not carry at all: the parent lives on
						// another device or has not been pushed yet. The row stays queued on
						// the client and is retried once the parent arrives, which is far
						// better than refusing the whole push.
						if rejected[table] == nil {
							rejected[table] = map[string]bool{}
						}
						rejected[table][row.idOf()] = true
						result.Results = append(result.Results, RowResult{
							Table: table, ID: row.idOf(), Outcome: OutcomeRejected,
							Reason: "missing_parent", Retryable: true,
						})
						result.Rejected++
						continue
					}
					return err
				}
				if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT "+savepoint); err != nil {
					return err
				}
				switch outcome.Outcome {
				case OutcomeApplied:
					result.Applied++
				case OutcomeStale:
					result.Stale++
				case OutcomeConflict:
					result.Conflict++
				case OutcomeRejected:
					result.Rejected++
				}
				result.Results = append(result.Results, outcome)
			}
		}
		return nil
	})
	if err != nil {
		return nil, TranslateError(err)
	}
	return result, nil
}

// pushRow applies one row and reports what happened to it.
func (s *Store) pushRow(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, clientID string,
	table SyncTable,
	row SyncRow,
	conflicted map[string]bool,
	conflictDates map[string][]string,
) (RowResult, error) {
	result := RowResult{Table: table, ID: row.idOf()}

	if result.ID == "" {
		result.Outcome = OutcomeRejected
		result.Reason = "missing_id"
		return result, nil
	}

	clean := cleanSyncRow(table, tenantID, row)
	// The writer identity is the authenticated device, not the payload: last_writer is
	// used for conflict attribution, so a client must not be able to claim to be another
	// device.
	clean["last_writer"] = clientID

	existing, err := s.currentSyncRow(ctx, tx, table, tenantID, result.ID)
	if err != nil {
		return result, err
	}

	// The server's clock decides ordering. A row that arrives with an older server
	// timestamp than the stored one loses; the client learns that from OutcomeStale and
	// adopts the server's copy on its next pull.
	//
	// Truncated to microseconds before any comparison, because that is the precision
	// PostgreSQL timestamptz stores. Comparing a nanosecond-precision clock against a
	// microsecond-truncated stored value makes an idempotent re-push look newer than the
	// row it duplicates, so a retrying client would re-apply its change forever.
	serverNow := time.Now().UTC().Truncate(time.Microsecond)
	if existing != nil && !serverNow.After(asTime(existing["updated_at"])) {
		// Same instant: fall back to the writer id, which is deterministic across
		// replicas. Without a tie-break, two rows written in the same microsecond would
		// resolve differently on different servers.
		if asString(existing["last_writer"]) >= clientID {
			result.Outcome = OutcomeStale
			if version, ok := asInt64(existing["version"]); ok {
				result.Version = version
			}
			return result, nil
		}
	}

	// Identical content is a no-op.
	//
	// This is the idempotency check, and it is separate from the timestamp comparison for
	// a reason: a client that retries a push after a dropped response sends the same stale
	// row again, and comparing timestamps would apply it every time — the server's clock
	// has moved on, so the retry always looks newer. Comparing content instead makes a
	// retry genuinely free, without advancing the watermark or rewriting the row.
	if existing != nil && sameSyncContent(table, clean, existing) {
		result.Outcome = OutcomeStale
		result.Reason = "identical"
		if version, ok := asInt64(existing["version"]); ok {
			result.Version = version
		}
		return result, nil
	}

	// A reservation whose nights are already taken is the one conflict worth detecting
	// before the write: the row is stored anyway, flagged, and queued for an operator, so
	// an offline booking is never silently dropped.
	if table == TableReservations && existing == nil {
		if dates := conflictDates[result.ID]; len(dates) > 0 {
			return s.storeConflictedReservation(ctx, tx, tenantID, clientID, clean, dates, serverNow)
		}
	}

	version, err := s.bumpTenantVersionTx(ctx, tx, tenantID)
	if err != nil {
		return result, err
	}
	result.Version = version

	if existing == nil {
		if missing := missingRequiredColumns(table, clean); len(missing) > 0 {
			result.Outcome = OutcomeRejected
			result.Reason = "missing_required_columns:" + joinColumns(missing)
			return result, nil
		}
		if err := s.insertSyncRow(ctx, tx, table, clean, version, serverNow); err != nil {
			return result, err
		}
	} else {
		if err := s.updateSyncRow(ctx, tx, table, tenantID, result.ID, clean, version, serverNow); err != nil {
			return result, err
		}
	}

	result.Outcome = OutcomeApplied
	return result, nil
}

// storeConflictedReservation stores a booking whose nights are taken, flagged for review.
//
// The row is written rather than rejected because the alternative is losing a guest's
// booking: the device that created it was offline and has no way to know the dates were
// already sold. An operator resolves it, and the conflict queue is where they see it.
//
// The nights are deliberately NOT inserted. They are the thing that collided, and writing
// them would either violate the exclusion constraint or, worse, succeed and let two
// bookings occupy the same dates.
func (s *Store) storeConflictedReservation(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, clientID string,
	clean SyncRow,
	conflictDates []string,
	serverNow time.Time,
) (RowResult, error) {
	result := RowResult{Table: TableReservations, ID: clean.idOf(), Outcome: OutcomeConflict,
		Reason: "night_conflict", ConflictDates: conflictDates}

	// A conflicted booking must not occupy dates, or it would block the booking it
	// collides with. The status is forced to `conflict`, which the exclusion constraint
	// excludes from its WHERE clause.
	clean["status"] = "conflict"
	clean["conflict_code"] = "night_conflict"
	details, err := json.Marshal(map[string]any{"dates": conflictDates, "reportedBy": clientID})
	if err != nil {
		return result, err
	}
	clean["conflict_details"] = string(details)

	version, err := s.bumpTenantVersionTx(ctx, tx, tenantID)
	if err != nil {
		return result, err
	}
	result.Version = version

	if missing := missingRequiredColumns(TableReservations, clean); len(missing) > 0 {
		result.Outcome = OutcomeRejected
		result.Reason = "missing_required_columns:" + joinColumns(missing)
		return result, nil
	}
	// Inserted with an explicit column list rather than through insertSyncRow: the
	// conflict columns are deliberately NOT in the client-writable allowlist, since a
	// client must not be able to flag its own booking and hide it from the operator queue.
	// The generic insert iterates only that allowlist, so it would silently drop exactly
	// the fields that make this row a conflict — storing the booking unflagged, which is
	// the one outcome this path exists to avoid.
	if err := s.insertConflictedReservation(ctx, tx, clean, version, serverNow); err != nil {
		return result, err
	}
	return result, nil
}

// insertConflictedReservation writes the booking plus its conflict markers.
func (s *Store) insertConflictedReservation(ctx context.Context, tx pgx.Tx, clean SyncRow, version int64, serverNow time.Time) error {
	columns := make([]string, 0, len(syncColumns[TableReservations])+6)
	values := make([]any, 0, len(syncColumns[TableReservations])+6)

	for _, column := range syncColumns[TableReservations] {
		value, present := clean[column]
		if !present {
			continue
		}
		columns = append(columns, column)
		values = append(values, value)
	}
	if !contains(columns, "created_at") {
		columns = append(columns, "created_at")
		values = append(values, serverNow)
	}

	columns = append(columns, "tenant_id", "version", "updated_at", "last_writer",
		"conflict_code", "conflict_details")
	values = append(values, clean["tenant_id"], version, serverNow, clean["last_writer"],
		clean["conflict_code"], clean["conflict_details"])

	placeholders := make([]string, len(columns))
	for i, column := range columns {
		switch column {
		case "tenant_id":
			placeholders[i] = fmt.Sprintf("$%d::uuid", i+1)
		case "conflict_details":
			placeholders[i] = fmt.Sprintf("$%d::jsonb", i+1)
		default:
			if pgType := columnType(TableReservations, column); pgType != "" {
				placeholders[i] = fmt.Sprintf("$%d::%s", i+1, pgType)
			} else {
				placeholders[i] = fmt.Sprintf("$%d", i+1)
			}
		}
	}

	_, err := tx.Exec(ctx,
		fmt.Sprintf("INSERT INTO reservations(%s) VALUES (%s)",
			joinColumns(columns), joinColumns(placeholders)),
		values...)
	return err
}

// planConflicts identifies which incoming bookings collide with occupied nights, either
// against stored stays or against an earlier booking in the same batch.
//
// The in-batch case matters for a device that created two bookings offline on the same
// unit: neither collides with the server, but they collide with each other. The two must
// therefore be resolved in order — the first survives and claims its nights, the second
// collides with it. Treating every booking as colliding with its own batch-mates would
// discard both.
func (s *Store) planConflicts(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	changes map[SyncTable][]SyncRow,
) (map[string]bool, map[string][]string, error) {
	conflicted := map[string]bool{}
	dates := map[string][]string{}

	reservations := changes[TableReservations]
	if len(reservations) == 0 {
		return conflicted, dates, nil
	}

	// Nights each incoming booking intends to occupy, keyed by reservation.
	intended := map[string][]string{}
	for _, row := range changes[TableReservationNights] {
		reservationID := asString(row["reservation_id"])
		night := asString(row["night_date"])
		if reservationID == "" || night == "" {
			continue
		}
		intended[reservationID] = append(intended[reservationID], night)
	}

	// Nights claimed by an earlier booking in this batch, per unit.
	claimed := map[string]map[string]bool{}

	// Order is the client's order within the batch, which is the only ordering information
	// available and is stable for a given payload.
	//
	// Bookings that do not occupy dates are skipped: a cancelled or conflicted booking
	// holds nothing, so it can neither conflict nor be conflicted with. This mirrors
	// ReservationStatus.Occupies and the exclusion constraint's WHERE clause.
	for _, row := range reservations {
		id := row.idOf()
		if id == "" {
			continue
		}
		status := asString(row["status"])
		switch status {
		case "hold", "confirmed", "checked_in":
		default:
			continue
		}

		clean := cleanSyncRow(TableReservations, tenantID, row)
		stored, err := s.detectNightConflict(ctx, tx, tenantID, clean)
		if err != nil {
			return nil, nil, err
		}

		unitID := asString(row["unit_id"])
		var overlap []string
		for _, night := range intended[id] {
			if claimed[unitID][night] {
				overlap = append(overlap, night)
			}
		}

		// A stored collision and an in-batch collision are both conflicts; the stored one is
		// reported first because it is the one an operator must resolve.
		if len(stored) > 0 {
			conflicted[id] = true
			dates[id] = stored
			continue
		}
		if len(overlap) > 0 {
			conflicted[id] = true
			dates[id] = overlap
			continue
		}

		// This booking survives, so its nights are now claimed and a later booking in the
		// same batch can be detected against it.
		if claimed[unitID] == nil {
			claimed[unitID] = map[string]bool{}
		}
		for _, night := range intended[id] {
			claimed[unitID][night] = true
		}
	}
	return conflicted, dates, nil
}

// detectNightConflict reports which of a booking's nights are already occupied.
//
// This is a pre-check so the row can be STORED as a conflict instead of failing on the
// exclusion constraint. The constraint remains the authority: it is what makes the
// guarantee hold under concurrency, and a race that slips past this check aborts the
// transaction, which the caller reports as a conflict rather than an internal error.
func (s *Store) detectNightConflict(ctx context.Context, tx pgx.Tx, tenantID string, clean SyncRow) ([]string, error) {
	unitID := asString(clean["unit_id"])
	checkIn := asString(clean["check_in_date"])
	checkOut := asString(clean["check_out_date"])
	status := asString(clean["status"])
	if unitID == "" || checkIn == "" || checkOut == "" {
		return nil, nil
	}

	// A booking that does not occupy dates cannot conflict with anything. This mirrors
	// ReservationStatus.Occupies in the domain package and the exclusion constraint's
	// WHERE clause; all three must agree.
	switch status {
	case "hold", "confirmed", "checked_in":
	default:
		return nil, nil
	}

	rows, err := tx.Query(ctx, `
		SELECT n.night_date::text
		FROM reservation_nights n
		WHERE n.tenant_id = $1
		  AND n.unit_id = $2
		  AND n.deleted_at IS NULL
		  AND n.night_date >= $3::date
		  AND n.night_date < $4::date
		ORDER BY n.night_date`, tenantID, unitID, checkIn, checkOut)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var dates []string
	for rows.Next() {
		var date string
		if err := rows.Scan(&date); err != nil {
			return nil, err
		}
		dates = append(dates, date)
	}
	return dates, rows.Err()
}

// Pull returns every replicated row changed after the given watermark.
func (s *Store) Pull(ctx context.Context, tenantID string, since int64) (*PullChanges, int64, error) {
	changes := &PullChanges{}
	var version int64

	// Every field starts as an empty slice, never a nil one.
	//
	// A nil slice marshals to JSON null, and a client iterating `changes.units` would then
	// have to special-case null on every pull — including the common case where nothing
	// changed. The wire contract is "an array, possibly empty", so it is one here.
	changes = &PullChanges{
		Places:              []SyncRow{},
		Units:               []SyncRow{},
		Reservations:        []SyncRow{},
		ReservationNights:   []SyncRow{},
		ReservationServices: []SyncRow{},
		ReservationMeals:    []SyncRow{},
		AppSettings:         []SyncRow{},
	}

	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		state, err := s.tenantVersionTx(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		version = state

		// since = -1 means "everything", used by backup export and by a client that has
		// lost its local database. Rows are ordered by version so a client applying them
		// in sequence always ends up at the server's state.
		pullAll := since < 0
		load := func(table SyncTable, target *[]SyncRow) error {
			query := "SELECT * FROM " + string(table) + " WHERE tenant_id = $1"
			args := []any{tenantID}
			if !pullAll {
				query += " AND version > $2"
				args = append(args, since)
			}
			query += " ORDER BY version"

			rows, err := tx.Query(ctx, query, args...)
			if err != nil {
				return err
			}
			defer rows.Close()

			columns := rows.FieldDescriptions()
			for rows.Next() {
				values, err := rows.Values()
				if err != nil {
					return err
				}
				row := make(SyncRow, len(columns))
				for i, field := range columns {
					name := string(field.Name)
					row[name] = normalizeSyncValue(values[i], name)
				}
				*target = append(*target, row)
			}
			return rows.Err()
		}

		for _, entry := range []struct {
			table  SyncTable
			target *[]SyncRow
		}{
			{TablePlaces, &changes.Places},
			{TableUnits, &changes.Units},
			{TableReservations, &changes.Reservations},
			{TableReservationNights, &changes.ReservationNights},
			{TableReservationServices, &changes.ReservationServices},
			{TableReservationMeals, &changes.ReservationMeals},
			{TableAppSettings, &changes.AppSettings},
		} {
			if err := load(entry.table, entry.target); err != nil {
				return fmt.Errorf("pull %s: %w", entry.table, err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, 0, TranslateError(err)
	}
	return changes, version, nil
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

func (s *Store) currentSyncRow(ctx context.Context, tx pgx.Tx, table SyncTable, tenantID, id string) (SyncRow, error) {
	rows, err := tx.Query(ctx,
		"SELECT * FROM "+string(table)+" WHERE tenant_id = $1 AND id = $2", tenantID, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	if !rows.Next() {
		return nil, rows.Err()
	}
	columns := rows.FieldDescriptions()
	values, err := rows.Values()
	if err != nil {
		return nil, err
	}
	row := make(SyncRow, len(columns))
	for i, field := range columns {
		name := string(field.Name)
		row[name] = normalizeSyncValue(values[i], name)
	}
	return row, nil
}

// insertSyncRow writes a new row, omitting columns the client did not send so the schema
// default applies.
func (s *Store) insertSyncRow(ctx context.Context, tx pgx.Tx, table SyncTable, clean SyncRow, version int64, serverNow time.Time) error {
	columns := make([]string, 0, len(clean)+3)
	values := make([]any, 0, len(clean)+3)

	// Iterate the allowlist rather than the payload so the column order is stable and the
	// statement is not built from client-controlled keys.
	for _, column := range syncColumns[table] {
		value, present := clean[column]
		if !present {
			continue
		}
		columns = append(columns, column)
		values = append(values, value)
	}
	// A missing created_at is filled from the server clock rather than left NULL, which
	// matters for a row the client created while offline and never stamped.
	if !contains(columns, "created_at") {
		columns = append(columns, "created_at")
		values = append(values, serverNow)
	}

	columns = append(columns, "tenant_id", "version", "updated_at", "last_writer")
	values = append(values, clean["tenant_id"], version, serverNow, clean["last_writer"])

	placeholders := make([]string, len(columns))
	for i, column := range columns {
		// Casts on the insert path pin the parameter type the same way the update path
		// does, so a client sending "2" for an integer column is accepted while "abc" is
		// refused with a cast error rather than a confusing operator mismatch.
		if pgType := columnType(table, column); pgType != "" {
			placeholders[i] = fmt.Sprintf("$%d::%s", i+1, pgType)
		} else {
			placeholders[i] = fmt.Sprintf("$%d", i+1)
		}
	}
	statement := fmt.Sprintf("INSERT INTO %s(%s) VALUES (%s)",
		table, joinColumns(columns), joinColumns(placeholders))

	_, err := tx.Exec(ctx, statement, values...)
	return err
}

// updateSyncRow writes the columns the client sent, leaving the rest as stored.
//
// Partial updates are the tolerant shape: an older client that does not know a column
// sends nothing for it, and its absence must not clear the stored value.
func (s *Store) updateSyncRow(ctx context.Context, tx pgx.Tx, table SyncTable, tenantID, id string, clean SyncRow, version int64, serverNow time.Time) error {
	sets := make([]string, 0, len(clean)+3)
	values := make([]any, 0, len(clean)+3)

	// Each appended value gets its placeholder number recorded as it is added. Computing
	// the numbers afterwards from len(values) is what produced a duplicate $5 binding the
	// wrong column: the SET clause and the WHERE clause then referred to the same
	// parameter for two different values.
	for _, column := range syncColumns[table] {
		if column == "id" || column == "created_at" {
			// The id identifies the row and created_at records when it first appeared;
			// neither is rewritten by an update. Letting created_at through would allow a
			// client to backdate a row, which the audit trail forbids.
			continue
		}
		value, present := clean[column]
		if !present {
			continue
		}
		values = append(values, value)
		// The cast is required: a parameter appearing only as `column = $n` has no
		// inferable type, and PostgreSQL rejects the statement outright.
		placeholder := fmt.Sprintf("$%d", len(values))
		if pgType := columnType(table, column); pgType != "" {
			placeholder += "::" + pgType
		}
		sets = append(sets, column+" = "+placeholder)
	}

	values = append(values, version, serverNow, clean["last_writer"])
	versionParam := len(values) - 2
	updatedParam := len(values) - 1
	writerParam := len(values)
	sets = append(sets,
		fmt.Sprintf("version = $%d", versionParam),
		fmt.Sprintf("updated_at = $%d", updatedParam),
		fmt.Sprintf("last_writer = $%d", writerParam),
	)

	values = append(values, id, tenantID)
	idParam := len(values) - 1
	tenantParam := len(values)

	statement := fmt.Sprintf("UPDATE %s SET %s WHERE id = $%d::uuid AND tenant_id = $%d::uuid",
		table, joinStrings(sets, ", "), idParam, tenantParam)

	_, err := tx.Exec(ctx, statement, values...)
	return err
}

// bumpTenantVersionTx increments the tenant watermark inside the caller's transaction.
func (s *Store) bumpTenantVersionTx(ctx context.Context, tx pgx.Tx, tenantID string) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, `
		UPDATE tenant_state SET version = version + 1, updated_at = now()
		WHERE tenant_id = $1 RETURNING version`, tenantID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.QueryRow(ctx, `
			INSERT INTO tenant_state(tenant_id, version) VALUES ($1, 1)
			ON CONFLICT (tenant_id) DO UPDATE SET version = tenant_state.version + 1
			RETURNING version`, tenantID).Scan(&version); err != nil {
			return 0, fmt.Errorf("provision tenant state: %w", err)
		}
		return version, nil
	}
	if err != nil {
		return 0, fmt.Errorf("bump tenant version: %w", err)
	}
	return version, nil
}

// tenantVersionTx reads the current watermark inside the caller's transaction.
func (s *Store) tenantVersionTx(ctx context.Context, tx pgx.Tx, tenantID string) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx,
		"SELECT version FROM tenant_state WHERE tenant_id = $1", tenantID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read tenant version: %w", err)
	}
	return version, nil
}

// ---------------------------------------------------------------------------
// Wire value helpers
// ---------------------------------------------------------------------------

// normalizeSyncValue converts a database value into the JSON shape clients expect.
//
// Two details matter, and getting either wrong breaks round-tripping:
//
//   - A `date` column must render as a calendar date, not a timestamp. Both `date` and
//     `timestamptz` arrive as time.Time from pgx, so the column's declared type decides
//     the format. Rendering a date as "2026-09-01T00:00:00Z" means a client's retry of the
//     same row no longer matches what the server holds — the value it sends back is
//     "2026-09-01" — and the retry is applied as a fresh edit instead of being recognized
//     as a duplicate.
//
//   - A timestamp is normalized to RFC3339 at microsecond precision, which is what
//     PostgreSQL stores. Encoding/json would emit nanoseconds, so the stored value and the
//     wire value would disagree and an idempotent write would look like a change.
func normalizeSyncValue(value any, columnName string) any {
	switch typed := value.(type) {
	case time.Time:
		if isDateColumn(columnName) {
			return typed.Format("2006-01-02")
		}
		return typed.UTC().Truncate(time.Microsecond).Format("2006-01-02T15:04:05.000000Z")
	case [16]byte:
		// PostgreSQL uuid arrives as a byte array through pgx's generic scan.
		return formatUUID(typed)
	case []byte:
		return string(typed)
	default:
		return value
	}
}

// dateColumns names the calendar-date columns, whose values must never be rendered with a
// time component.
var dateColumns = map[string]bool{
	"check_in_date": true, "check_out_date": true, "actual_check_out_date": true,
	"night_date": true, "meal_date": true,
}

// isDateColumn reports whether a column is a calendar date rather than a timestamp.
func isDateColumn(column string) bool { return dateColumns[column] }

// formatUUID renders 16 bytes as the canonical 8-4-4-4-12 form.
func formatUUID(bytes [16]byte) string {
	const hex = "0123456789abcdef"
	out := make([]byte, 0, 36)
	for i, b := range bytes {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out = append(out, '-')
		}
		out = append(out, hex[b>>4], hex[b&0x0f])
	}
	return string(out)
}

func asString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}

func asInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case int64:
		return typed, true
	case int32:
		return int64(typed), true
	case int:
		return int64(typed), true
	default:
		return 0, false
	}
}

func asTime(value any) time.Time {
	switch typed := value.(type) {
	case time.Time:
		return typed
	case string:
		parsed, err := time.Parse(time.RFC3339Nano, typed)
		if err != nil {
			return time.Time{}
		}
		return parsed
	default:
		return time.Time{}
	}
}

// sameSyncContent reports whether an incoming row carries exactly what is already stored.
//
// Only the client-writable columns are compared: tenant_id, version, updated_at and
// last_writer are server-assigned, and treating a difference in them as a change would
// make every retry look like an edit.
func sameSyncContent(table SyncTable, clean SyncRow, existing SyncRow) bool {
	for _, column := range syncColumns[table] {
		incoming, present := clean[column]
		if !present {
			// The client omitted the column, so it is not asserting anything about it and
			// the stored value stands. Skipping is what makes partial rows idempotent.
			continue
		}
		if !valuesEqual(incoming, existing[column]) {
			return false
		}
	}
	return true
}

// valuesEqual compares a wire value against a stored database value.
//
// The comparison is textual, because the two sides come from different worlds: an incoming
// value is JSON (float64 for numbers, string for dates) while a stored value is whatever
// pgx returned (int64, time.Time, a domain.Date). Normalizing both to the same rendering is
// the only comparison that does not depend on those incidental types.
func valuesEqual(incoming, stored any) bool {
	if stored == nil {
		return incoming == nil
	}
	return normalizeComparable(incoming) == normalizeComparable(stored)
}

// normalizeComparable renders a value the same way on both sides of the comparison.
func normalizeComparable(value any) string {
	switch typed := value.(type) {
	case nil:
		return "<nil>"
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case time.Time:
		return typed.UTC().Truncate(time.Microsecond).Format("2006-01-02T15:04:05.000000Z")
	case float64:
		// JSON numbers arrive as float64. A whole number is rendered without a fractional
		// part so it matches the stored integer.
		if typed == float64(int64(typed)) {
			return fmt.Sprintf("%d", int64(typed))
		}
		return fmt.Sprintf("%g", typed)
	default:
		return fmt.Sprint(value)
	}
}

func contains(list []string, needle string) bool {
	for _, item := range list {
		if item == needle {
			return true
		}
	}
	return false
}

func joinColumns(columns []string) string { return joinStrings(columns, ", ") }

func joinStrings(values []string, separator string) string {
	if len(values) == 0 {
		return ""
	}
	out := values[0]
	for _, value := range values[1:] {
		out += separator + value
	}
	return out
}

// parentReference reports the table and column a row depends on.
func parentReference(table SyncTable) (SyncTable, string) {
	switch table {
	case TableUnits:
		return TablePlaces, "place_id"
	case TableReservations:
		return TableUnits, "unit_id"
	case TableReservationNights, TableReservationServices, TableReservationMeals:
		return TableReservations, "reservation_id"
	default:
		return "", ""
	}
}

// refusedAncestor walks the whole dependency chain and reports the first table that refused
// this row's ancestor, or "" when none did.
func refusedAncestor(table SyncTable, row SyncRow, rejected map[SyncTable]map[string]bool) string {
	seen := map[SyncTable]bool{}
	for current := table; ; {
		parent, column := parentReference(current)
		if parent == "" || seen[parent] {
			return ""
		}
		seen[parent] = true
		id := asString(row[column])
		if id == "" {
			return ""
		}
		if rejected[parent][id] {
			return string(parent)
		}
		// Walk on using the parent's id as the child id for the next level.
		current = parent
		row = SyncRow{"id": id}
	}
}

// isPermanentRejection reports a refusal that will never succeed on retry.
//
// The distinction matters to the client: a permanently refused row must not block the pull
// forever, or one over-allowance unit makes the account unable to sync ANYTHING for the rest
// of its life. Rows that fail on a missing parent stay retryable instead, because their parent
// may simply not have been pushed yet.
func isPermanentRejection(err error) bool {
	return isPlanLimitViolation(err) || isConstraintViolation(err)
}

// isConstraintViolation reports any other check_violation — a value the schema refuses.
func isConstraintViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23514"
	}
	return strings.Contains(err.Error(), "SQLSTATE 23514")
}

// isForeignKeyViolation reports a missing parent, as opposed to a malformed row.
func isForeignKeyViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23503"
	}
	return strings.Contains(err.Error(), "SQLSTATE 23503")
}

// planLimitCodes are the messages the entitlement triggers raise when a write would exceed
// the account's allowance. They are check_violation, the same SQLSTATE as an ordinary CHECK,
// so the message is what distinguishes them.
var planLimitCodes = []string{
	"dombook_plan_limit_units",
	"dombook_plan_limit_places",
}

// isPlanLimitViolation reports whether an error came from an entitlement trigger.
func isPlanLimitViolation(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	for _, code := range planLimitCodes {
		if strings.Contains(message, code) {
			return true
		}
	}
	return false
}

// planLimitReason turns a trigger message into something a person can act on.
func planLimitReason(err error) string {
	message := err.Error()
	switch {
	case strings.Contains(message, "dombook_plan_limit_units"):
		return "unit_limit"
	case strings.Contains(message, "dombook_plan_limit_places"):
		return "place_limit"
	default:
		return "plan_limit"
	}
}
