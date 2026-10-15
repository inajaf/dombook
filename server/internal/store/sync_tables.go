package store

import (
	"fmt"
	"strings"
)

// This file defines the sync row vocabulary: which tables replicate, which columns of
// each are client-writable, and how an incoming row is cleaned before it is written.
//
// The column lists are an allowlist, not a denylist. A denylist would mean a column added
// by a future migration is silently client-writable, so any new column would need
// remembering in two places; an allowlist makes the omission fail on the safe side — the
// column is simply not synced until someone decides it should be.

// SyncTable names a replicated table.
type SyncTable string

const (
	TablePlaces              SyncTable = "places"
	TableUnits               SyncTable = "units"
	TableReservations        SyncTable = "reservations"
	TableReservationNights   SyncTable = "reservation_nights"
	TableReservationServices SyncTable = "reservation_services"
	TableReservationMeals    SyncTable = "reservation_meals"
	TableAppSettings         SyncTable = "app_settings"
)

// SyncTables is the canonical, ordered list of replicated tables.
var SyncTables = []SyncTable{
	TablePlaces, TableUnits, TableReservations,
	TableReservationNights, TableReservationServices, TableReservationMeals,
	TableAppSettings,
}

// IsSyncTable reports whether a name is a replicated table.
func IsSyncTable(name string) bool {
	for _, table := range SyncTables {
		if string(table) == name {
			return true
		}
	}
	return false
}

// syncColumns lists the client-writable columns of each table, excluding:
//
//   - tenant_id: taken from the authenticated session, never from the payload. A client
//     that could set it could write into another tenant.
//   - version: assigned by the server so it is monotonic and cannot be spoofed.
//   - updated_at on write: stamped with server time to defeat device clock skew.
//   - last_writer: taken from the authenticated device, not the payload, so a client
//     cannot attribute its changes to another device.
//   - conflict_code, conflict_details, resolved_at: assigned by the sync engine, so a
//     client cannot mark its own booking conflicted and hide it from the operator queue.
var syncColumns = map[SyncTable][]string{
	TablePlaces: {
		"id", "name", "address", "has_food_service",
		"breakfast_price_minor", "lunch_price_minor", "dinner_price_minor",
		"status", "notes", "created_at", "deleted_at",
	},
	TableUnits: {
		"id", "place_id", "kind", "name", "location", "capacity",
		"base_price_minor", "deposit_minor", "monthly_rate_minor", "currency", "rate_rules",
		"check_in_time", "check_out_time", "status", "notes", "created_at", "deleted_at",
	},
	TableReservations: {
		"id", "unit_id", "guest_name", "guest_phone", "guest_email",
		"check_in_date", "check_out_date", "adults", "children", "status",
		"nightly_rate_minor", "accommodation_minor", "services_minor", "total_minor",
		"prepaid_minor", "deposit_minor", "deposit_status", "actual_check_out_date",
		"booking_kind", "monthly_rate_minor", "meter_readings", "rate_breakdown",
		"notes", "created_at", "deleted_at",
	},
	TableReservationNights: {
		"id", "reservation_id", "unit_id", "night_date",
		"created_at", "deleted_at",
	},
	TableReservationServices: {
		"id", "reservation_id", "service_type", "service_name", "unit_price_minor", "quantity",
		"created_at", "deleted_at",
	},
	TableReservationMeals: {
		"id", "reservation_id", "meal_date", "meal_type", "amount_minor",
		"created_at", "deleted_at",
	},
	TableAppSettings: {
		"id", "setting_key", "setting_value", "created_at", "deleted_at",
	},
}

// SyncColumns returns the client-writable columns of a table.
func SyncColumns(table SyncTable) []string {
	columns := syncColumns[table]
	// A copy, so a caller cannot mutate the shared list by appending to it.
	out := make([]string, len(columns))
	copy(out, columns)
	return out
}

// requiredSyncColumns must be present on an insert. A row missing one cannot be stored,
// and failing with a clear message beats a NOT NULL violation surfacing through the driver.
var requiredSyncColumns = map[SyncTable][]string{
	TablePlaces:              {"id", "name"},
	TableUnits:               {"id", "name"},
	TableReservations:        {"id", "unit_id", "check_in_date", "check_out_date"},
	TableReservationNights:   {"id", "reservation_id", "unit_id", "night_date"},
	TableReservationServices: {"id", "reservation_id", "service_type"},
	TableReservationMeals:    {"id", "reservation_id", "meal_date", "meal_type"},
	TableAppSettings:         {"id", "setting_key"},
}

// SyncRow is one replicated row as it travels on the wire.
type SyncRow map[string]any

// idOf returns the row's id as a string, or "" when absent.
func (r SyncRow) idOf() string {
	if value, ok := r["id"]; ok && value != nil {
		return strings.TrimSpace(fmt.Sprint(value))
	}
	return ""
}

// cleanSyncRow filters an incoming row down to the writable columns.
//
// Anything outside the allowlist is dropped rather than rejected. That tolerance is
// deliberate: a newer client sends columns this server does not know yet, and failing the
// whole push over an unrecognized field would make every forward-compatible client
// change a breaking one.
func cleanSyncRow(table SyncTable, tenantID string, row SyncRow) SyncRow {
	clean := make(SyncRow, len(syncColumns[table])+1)
	for _, column := range syncColumns[table] {
		value, present := row[column]
		if !present {
			continue
		}
		if value == nil {
			// An explicit null is meaningful for the nullable columns (deleted_at,
			// place_id), and cleared rather than dropped. NOT NULL columns rely on their
			// schema default instead, which is why nil is not written for them.
			if nullableSyncColumn(table, column) {
				clean[column] = nil
			}
			continue
		}
		clean[column] = value
	}
	// The tenant always comes from the authenticated session. Trusting the payload here
	// would let a client write into another account.
	clean["tenant_id"] = tenantID
	return clean
}

// nullableSyncColumn reports whether a column may hold NULL.
func nullableSyncColumn(_ SyncTable, column string) bool {
	switch column {
	case "deleted_at", "place_id", "actual_check_out_date", "location":
		return true
	}
	return false
}

// missingRequiredColumns reports which columns an insert cannot proceed without.
func missingRequiredColumns(table SyncTable, row SyncRow) []string {
	var missing []string
	for _, column := range requiredSyncColumns[table] {
		value, present := row[column]
		if !present || value == nil || strings.TrimSpace(fmt.Sprint(value)) == "" {
			missing = append(missing, column)
		}
	}
	return missing
}

// syncColumnTypes maps each writable column to its PostgreSQL type, used to cast bound
// parameters.
//
// The cast is required, not cosmetic: a parameter that appears only as `column = $n` in an
// UPDATE has no inferable type, and PostgreSQL rejects the statement with "could not
// determine data type of parameter". Casting explicitly also means a client sending a
// JSON number where a date is expected fails at the cast with a clear message rather than
// being coerced silently.
//
// This table must stay in step with syncColumns. A column missing here is a build-time
// omission the sync tests catch, because the update path would fail outright.
var syncColumnTypes = map[SyncTable]map[string]string{
	TablePlaces: {
		"name": "citext", "address": "text", "has_food_service": "boolean",
		"breakfast_price_minor": "bigint", "lunch_price_minor": "bigint",
		"dinner_price_minor": "bigint", "status": "text", "notes": "text",
		"created_at": "timestamptz", "deleted_at": "timestamptz",
	},
	TableUnits: {
		"place_id": "uuid", "kind": "text", "name": "citext", "location": "text",
		"capacity": "integer", "base_price_minor": "bigint", "deposit_minor": "bigint",
		"monthly_rate_minor": "bigint", "rate_rules": "text",
		"currency": "text", "check_in_time": "text", "check_out_time": "text",
		"status": "text", "notes": "text", "created_at": "timestamptz", "deleted_at": "timestamptz",
	},
	TableReservations: {
		"unit_id": "uuid", "guest_name": "text", "guest_phone": "text", "guest_email": "text",
		"check_in_date": "date", "check_out_date": "date", "adults": "integer", "children": "integer",
		"status": "text", "nightly_rate_minor": "bigint", "accommodation_minor": "bigint",
		"services_minor": "bigint", "total_minor": "bigint", "prepaid_minor": "bigint",
		"deposit_minor": "bigint", "deposit_status": "text", "actual_check_out_date": "date",
		"booking_kind": "text", "monthly_rate_minor": "bigint", "meter_readings": "jsonb",
		"rate_breakdown": "text",
		"notes":          "text", "created_at": "timestamptz", "deleted_at": "timestamptz",
	},
	TableReservationNights: {
		"reservation_id": "uuid", "unit_id": "uuid", "night_date": "date",
		"created_at": "timestamptz", "deleted_at": "timestamptz",
	},
	TableReservationServices: {
		"reservation_id": "uuid", "service_type": "text", "unit_price_minor": "bigint",
		"quantity": "integer", "created_at": "timestamptz", "deleted_at": "timestamptz",
	},
	TableReservationMeals: {
		"reservation_id": "uuid", "meal_date": "date", "meal_type": "text",
		"amount_minor": "bigint", "created_at": "timestamptz", "deleted_at": "timestamptz",
	},
	TableAppSettings: {
		"setting_key": "text", "setting_value": "text",
		"created_at": "timestamptz", "deleted_at": "timestamptz",
	},
}

// columnType returns the PostgreSQL type for a writable column, or "" when unknown.
func columnType(table SyncTable, column string) string {
	if types, ok := syncColumnTypes[table]; ok {
		return types[column]
	}
	return ""
}
