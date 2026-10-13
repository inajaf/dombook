package domain

import (
	"fmt"
	"strings"
)

// This file holds the entity-level validators: they turn a decoded request body into
// a typed input, rejecting anything the database invariants would not accept.
//
// The rules mirror the desktop client (src/database.cjs) exactly, because the two
// must agree: if the server were stricter, the client would offer actions that always
// fail; if it were looser, the client would show data the server considers invalid.

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

// PlaceInput is a validated guest house.
type PlaceInput struct {
	Name                string
	Address             string
	HasFoodService      bool
	BreakfastPriceMinor int64
	LunchPriceMinor     int64
	DinnerPriceMinor    int64
	Notes               string
	Status              string
}

// ValidatePlace normalizes a place payload.
//
// Meal prices are forced to zero when the place has no kitchen. Keeping a stale price
// on a place that cannot serve meals would let a later reservation compute a services
// total the place is not able to deliver.
func ValidatePlace(input map[string]any) (*PlaceInput, error) {
	name, err := RequiredText(input["name"], "name", "Название дома отдыха", MaxPlaceNameLength)
	if err != nil {
		return nil, err
	}
	address, err := OptionalText(input["address"], "address", "Адрес", MaxAddressLength)
	if err != nil {
		return nil, err
	}
	notes, err := OptionalText(input["notes"], "notes", "Заметки", MaxNotesLength)
	if err != nil {
		return nil, err
	}

	hasFoodService := isTruthy(input["hasFoodService"])

	place := &PlaceInput{
		Name:           name,
		Address:        address,
		HasFoodService: hasFoodService,
		Notes:          notes,
		Status:         parseStatus(input["status"]),
	}
	if !hasFoodService {
		return place, nil
	}

	// A place may have a kitchen before its prices are set, so omitted prices default
	// to zero rather than failing: an unconfigured price is a 0-cost meal, which the
	// owner will notice, instead of a place that cannot be saved at all.
	if place.BreakfastPriceMinor, err = Money(defaultIfNil(input["breakfastPriceMinor"], 0), "breakfastPriceMinor", "Цена завтрака"); err != nil {
		return nil, err
	}
	if place.LunchPriceMinor, err = Money(defaultIfNil(input["lunchPriceMinor"], 0), "lunchPriceMinor", "Цена обеда"); err != nil {
		return nil, err
	}
	if place.DinnerPriceMinor, err = Money(defaultIfNil(input["dinnerPriceMinor"], 0), "dinnerPriceMinor", "Цена ужина"); err != nil {
		return nil, err
	}
	return place, nil
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

// UnitInput is a validated bookable unit (cottage or standalone house).
type UnitInput struct {
	PlaceID        *string
	Kind           string
	Name           string
	Location       string
	Capacity       int
	BasePriceMinor int64
	DepositMinor   int64
	Currency       string
	CheckInTime    string
	CheckOutTime   string
	Notes          string
	Status         string
}

// UnitLookup resolves a place id so the validator can confirm it is active.
//
// The check is passed in rather than performed here because it needs the database;
// keeping it as a function keeps this file free of SQL and lets the rules be tested
// directly.
type UnitLookup func(placeID string) (exists bool, isActive bool)

// ValidateUnit normalizes a unit payload. lookup may be nil when the caller only needs
// field-level validation (for example when updating a unit without touching its place).
func ValidateUnit(input map[string]any, lookup UnitLookup) (*UnitInput, error) {
	name, err := RequiredText(input["name"], "name", "Наименование дома", MaxUnitNameLength)
	if err != nil {
		return nil, err
	}
	location, err := OptionalText(input["location"], "location", "Расположение", MaxLocationLength)
	if err != nil {
		return nil, err
	}
	notes, err := OptionalText(input["notes"], "notes", "Заметки", MaxNotesLength)
	if err != nil {
		return nil, err
	}
	capacity, err := Integer(input["capacity"], "capacity", "Вместимость", 1, MaxCapacity)
	if err != nil {
		return nil, err
	}
	basePrice, err := Money(input["basePriceMinor"], "basePriceMinor", "Базовая цена")
	if err != nil {
		return nil, err
	}
	deposit, err := Money(input["depositMinor"], "depositMinor", "Депозит")
	if err != nil {
		return nil, err
	}

	currency := strings.ToUpper(strings.TrimSpace(toString(input["currency"])))
	if currency == "" {
		currency = "AZN"
	}
	if len([]rune(currency)) > MaxCurrencyLength {
		return nil, &FieldError{
			Code:    CodeTooLong,
			Field:   "currency",
			Message: fmt.Sprintf("Валюта: максимум %d символов", MaxCurrencyLength),
		}
	}

	checkInTime, err := timeOfDay(input["checkInTime"], "checkInTime", "Время заезда", "15:00")
	if err != nil {
		return nil, err
	}
	checkOutTime, err := timeOfDay(input["checkOutTime"], "checkOutTime", "Время выезда", "11:00")
	if err != nil {
		return nil, err
	}

	var placeID *string
	if raw := strings.TrimSpace(toString(input["placeId"])); raw != "" {
		if lookup != nil {
			exists, isActive := lookup(raw)
			// A missing place and an archived one produce the same message on purpose:
			// distinguishing them would let a caller probe for another tenant's ids.
			if !exists || !isActive {
				return nil, &FieldError{
					Code:    CodeValidation,
					Field:   "placeId",
					Message: "Выберите активный дом отдыха",
				}
			}
		}
		placeID = &raw
	}

	kind := "house"
	if strings.TrimSpace(toString(input["kind"])) == "cottage" {
		kind = "cottage"
	}

	return &UnitInput{
		PlaceID:        placeID,
		Kind:           kind,
		Name:           name,
		Location:       location,
		Capacity:       capacity,
		BasePriceMinor: basePrice,
		DepositMinor:   deposit,
		Currency:       currency,
		CheckInTime:    checkInTime,
		CheckOutTime:   checkOutTime,
		Notes:          notes,
		Status:         parseStatus(input["status"]),
	}, nil
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

// MealInput is one priced meal on one night.
type MealInput struct {
	Date        Date
	Type        MealType
	AmountMinor int64
}

// ReservationInput is a validated booking, with every derived amount computed.
type ReservationInput struct {
	UnitID             string
	UnitCapacity       int
	GuestName          string
	GuestPhone         string
	GuestEmail         string
	CheckIn            Date
	CheckOut           Date
	Nights             []Date
	Adults             int
	Children           int
	Status             ReservationStatus
	NightlyRateMinor   int64
	AccommodationMinor int64
	Meals              []MealInput
	ServicesMinor      int64
	TotalMinor         int64
	PrepaidMinor       int64
	DepositMinor       int64
	DepositStatus      DepositStatus
	// ActualCheckOut is set after an early departure; it truncates meal eligibility
	// while the accommodation total stays as charged.
	ActualCheckOut *Date
	Notes          string
}

// ReservationDeps is what the reservation validator needs from storage.
type ReservationDeps struct {
	// Unit resolves the booked unit. ok is false when it does not exist or is not
	// visible to the caller's tenant.
	Unit func(unitID string) (unit *ValidatedUnit, ok bool)
	// PlaceHasFoodService reports whether meals may be sold for the unit's place.
	PlaceHasFoodService func(placeID string) bool
	// Existing is the stored reservation when this is an update, which is what makes
	// re-validation skip unchanged dates.
	Existing *ExistingReservation
	// Policy is the account's booking policy.
	Policy Policy
	// Today is the current date in the policy timezone.
	Today Date
}

// ValidatedUnit is the subset of a unit the reservation validator needs.
type ValidatedUnit struct {
	ID             string
	PlaceID        *string
	Capacity       int
	BasePriceMinor int64
	Status         string
}

// ExistingReservation carries the stored values of the booking being updated.
type ExistingReservation struct {
	ID                 string
	UnitID             string
	CheckIn            Date
	CheckOut           Date
	NightlyRateMinor   int64
	AccommodationMinor int64
	ActualCheckOut     *Date
}

// ValidateReservation normalizes a booking payload and computes its money fields.
//
// The server owns the totals. A client may not send its own: the desktop computes the
// same numbers, but accepting a client total would let a malformed or hostile payload
// store an amount that disagrees with the nights and meals it claims to describe.
func ValidateReservation(input map[string]any, deps ReservationDeps) (*ReservationInput, error) {
	unitID := strings.TrimSpace(toString(input["unitId"]))
	if unitID == "" {
		return nil, &FieldError{
			Code:    CodeRequired,
			Field:   "unitId",
			Message: "Выберите дом: обязательное поле",
		}
	}
	if deps.Unit == nil {
		return nil, fmt.Errorf("validate reservation: no unit resolver supplied")
	}
	unit, ok := deps.Unit(unitID)
	if !ok || unit == nil || unit.Status != "active" {
		return nil, &FieldError{
			Code:    CodeValidation,
			Field:   "unitId",
			Message: "Выберите активный дом",
		}
	}

	checkIn, err := ValidDate(input["checkInDate"], "checkInDate", "Дата заезда")
	if err != nil {
		return nil, err
	}
	checkOut, err := ValidDate(input["checkOutDate"], "checkOutDate", "Дата выезда")
	if err != nil {
		return nil, err
	}
	nights, err := Nights(checkIn, checkOut)
	if err != nil {
		return nil, err
	}

	guestName, err := RequiredText(input["guestName"], "guestName", "Имя гостя", MaxGuestNameLength)
	if err != nil {
		return nil, err
	}
	guestEmail, err := OptionalText(input["guestEmail"], "guestEmail", "Email гостя", MaxEmailLength)
	if err != nil {
		return nil, err
	}
	notes, err := OptionalText(input["notes"], "notes", "Заметки", MaxNotesLength)
	if err != nil {
		return nil, err
	}

	adults, err := Integer(defaultIfNil(input["adults"], 1), "adults", "Взрослые", 1, MaxCapacity)
	if err != nil {
		return nil, err
	}
	children, err := Integer(defaultIfNil(input["children"], 0), "children", "Дети", 0, MaxCapacity)
	if err != nil {
		return nil, err
	}
	if adults+children > unit.Capacity {
		return nil, &FieldError{
			Code:  CodeCapacityExceeded,
			Field: "adults",
			Message: fmt.Sprintf(
				"Вместимость дома — %d. Уменьшите число гостей или выберите другой дом", unit.Capacity),
		}
	}

	prepaidMinor, err := Money(defaultIfNil(input["prepaidMinor"], 0), "prepaidMinor", "Предоплата")
	if err != nil {
		return nil, err
	}
	depositMinor, err := Money(defaultIfNil(input["depositMinor"], 0), "depositMinor", "Депозит")
	if err != nil {
		return nil, err
	}

	// Booking window. A policy violation carries a stable code of its own so the
	// client can explain which limit was hit.
	existing := deps.Existing
	var existingBooking *ExistingBooking
	if existing != nil {
		existingBooking = &ExistingBooking{CheckIn: existing.CheckIn, CheckOut: existing.CheckOut}
	}
	if err := deps.Policy.AssertBookingDates(checkIn, checkOut, deps.Today, existingBooking); err != nil {
		return nil, err
	}

	// An early departure freezes the stay: the accommodation total was settled when the
	// guest left, and the booked range must not grow afterwards.
	//
	// Note the booked check-out legitimately stays LATER than the departure date — that
	// is what "left early" means, and it is why the row keeps both dates. The invariant
	// is therefore against the stored check-out, not against the departure: extending
	// the stay past what was booked is the edit to refuse.
	//
	// The previous form compared the departure against the requested dates, which
	// described the stored row instead of validating the request and let a caller
	// extend check-out freely.
	var actualCheckOut *Date
	if existing != nil && existing.ActualCheckOut != nil {
		actualCheckOut = existing.ActualCheckOut
		if checkOut.After(existing.CheckOut) {
			return nil, &FieldError{
				Code:    CodeValidation,
				Field:   "checkOutDate",
				Message: "После досрочного выезда даты проживания нельзя сдвинуть за фактическую дату выезда",
			}
		}
	}

	// The rate is captured when the booking is created and preserved on edit unless
	// the unit changes, so a later price rise does not silently reprice old stays.
	nightlyRate := unit.BasePriceMinor
	if existing != nil && existing.UnitID == unitID && existing.NightlyRateMinor > 0 {
		nightlyRate = existing.NightlyRateMinor
	}

	accommodationMinor := int64(len(nights)) * nightlyRate
	if actualCheckOut != nil && existing != nil {
		// Already-charged amount: the guest was billed for the original stay.
		accommodationMinor = existing.AccommodationMinor
	}

	// Meals are only priced up to the departure date.
	//
	// The two cases use different bounds on purpose. A normal stay's nights are
	// half-open, so the last eligible meal date is the night before check-out. After an
	// early departure the guest is present on the departure DATE and eats breakfast
	// that morning, so that date must be eligible — using the night-before bound would
	// silently drop the final breakfast from the bill.
	lastMealDate := checkOut.AddDays(-1)
	if actualCheckOut != nil {
		lastMealDate = *actualCheckOut
	}
	eligible := make([]Date, 0, len(nights))
	for _, night := range nights {
		if !night.After(lastMealDate) {
			eligible = append(eligible, night)
		}
	}
	meals, servicesMinor, err := validateMeals(input["mealItems"], eligible)
	if err != nil {
		return nil, err
	}

	// Selling meals for a place without a kitchen would create a charge nobody can
	// deliver.
	if servicesMinor > 0 && unit.PlaceID != nil && deps.PlaceHasFoodService != nil {
		if !deps.PlaceHasFoodService(*unit.PlaceID) {
			return nil, &FieldError{
				Code:    CodeFoodServiceOff,
				Field:   "mealItems",
				Message: "Для выбранного дома питание недоступно: включите кухню или ресторан в доме отдыха",
			}
		}
	}

	totalMinor := accommodationMinor + servicesMinor
	if prepaidMinor > totalMinor {
		return nil, &FieldError{
			Code:    CodePrepaidTooLarge,
			Field:   "prepaidMinor",
			Message: "Предоплата не может быть больше общей стоимости брони",
		}
	}

	depositStatus := ParseDepositStatus(input["depositStatus"])
	if depositMinor == 0 && depositStatus != DepositNone {
		return nil, &FieldError{
			Code:    CodeDepositMissing,
			Field:   "depositMinor",
			Message: "Для статуса депозита укажите сумму или выберите «Не требуется»",
		}
	}

	return &ReservationInput{
		UnitID:             unit.ID,
		UnitCapacity:       unit.Capacity,
		GuestName:          guestName,
		GuestPhone:         NormalizePhone(input["guestPhone"]),
		GuestEmail:         guestEmail,
		CheckIn:            checkIn,
		CheckOut:           checkOut,
		Nights:             nights,
		Adults:             adults,
		Children:           children,
		Status:             ParseReservationStatus(input["status"]),
		NightlyRateMinor:   nightlyRate,
		AccommodationMinor: accommodationMinor,
		Meals:              meals,
		ServicesMinor:      servicesMinor,
		TotalMinor:         totalMinor,
		PrepaidMinor:       prepaidMinor,
		DepositMinor:       depositMinor,
		DepositStatus:      depositStatus,
		ActualCheckOut:     actualCheckOut,
		Notes:              notes,
	}, nil
}

// validateMeals parses the meal list and totals it.
//
// Zero-amount entries are dropped rather than rejected: the desktop sends a row per
// meal per night including the ones the guest declined, and treating those as an error
// would make every ordinary booking fail.
func validateMeals(raw any, eligible []Date) ([]MealInput, int64, error) {
	items, _ := raw.([]any)
	if len(items) == 0 {
		return nil, 0, nil
	}
	if len(items) > MaxMealItems {
		return nil, 0, &FieldError{
			Code:    CodeOutOfRange,
			Field:   "mealItems",
			Message: "Питание: слишком много записей",
		}
	}

	allowed := make(map[string]struct{}, len(eligible))
	for _, night := range eligible {
		allowed[night.String()] = struct{}{}
	}

	meals := make([]MealInput, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	var total int64

	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			return nil, 0, &FieldError{
				Code:    CodeValidation,
				Field:   "mealItems",
				Message: "Питание: неверный формат записи",
			}
		}
		date, err := ValidDate(item["date"], "mealItems", "Дата питания")
		if err != nil {
			return nil, 0, err
		}
		mealType, err := ParseMealType(item["type"])
		if err != nil {
			return nil, 0, err
		}
		amount, err := Money(defaultIfNil(item["amountMinor"], 0), "mealItems", "Сумма питания")
		if err != nil {
			return nil, 0, err
		}
		if amount <= 0 {
			continue
		}
		if _, ok := allowed[date.String()]; !ok {
			return nil, 0, &FieldError{
				Code:    CodeMealOutsideStay,
				Field:   "mealItems",
				Message: fmt.Sprintf("Питание за %s находится вне фактических дат проживания", date),
			}
		}
		key := date.String() + ":" + string(mealType)
		if _, duplicate := seen[key]; duplicate {
			return nil, 0, &FieldError{
				Code:    CodeMealDuplicate,
				Field:   "mealItems",
				Message: fmt.Sprintf("Питание за %s указано повторно", date),
			}
		}
		seen[key] = struct{}{}
		meals = append(meals, MealInput{Date: date, Type: mealType, AmountMinor: amount})
		total += amount
	}
	return meals, total, nil
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// parseStatus maps an unknown place/unit status to active.
//
// Defaulting to active rather than archived is deliberate: a typo in a status field
// should not silently hide a unit from the calendar, where the owner would not think
// to look for it.
func parseStatus(value any) string {
	if strings.TrimSpace(toString(value)) == "archived" {
		return "archived"
	}
	return "active"
}

func isTruthy(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		trimmed := strings.TrimSpace(typed)
		return trimmed == "1" || strings.EqualFold(trimmed, "true")
	default:
		number, ok := toInt(value)
		return ok && number == 1
	}
}

// defaultIfNil substitutes a fallback for a missing key, so an omitted optional field
// is distinguishable from an explicit null.
func defaultIfNil(value any, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}

// timeOfDay validates an HH:MM string, applying a default when empty.
func timeOfDay(value any, field, label, fallback string) (string, error) {
	raw := strings.TrimSpace(toString(value))
	if raw == "" {
		return fallback, nil
	}
	parts := strings.Split(raw, ":")
	if len(parts) != 2 || len(parts[0]) > 2 || len(parts[1]) != 2 {
		return "", &FieldError{
			Code:    CodeValidation,
			Field:   field,
			Message: fmt.Sprintf("%s: укажите время в формате ЧЧ:ММ", label),
		}
	}
	hour, hourErr := toInt(parts[0])
	minute, minuteErr := toInt(parts[1])
	if !hourErr || !minuteErr || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return "", &FieldError{
			Code:    CodeValidation,
			Field:   field,
			Message: fmt.Sprintf("%s: укажите время в формате ЧЧ:ММ", label),
		}
	}
	// Re-rendered so "9:05" is stored as "09:05" and compares consistently.
	return fmt.Sprintf("%02d:%02d", hour, minute), nil
}
