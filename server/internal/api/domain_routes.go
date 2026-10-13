package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// These routes mirror the endpoint surface the desktop and web clients already call.
//
// The one rename is `properties` -> `units`: "property" was ambiguous with real estate,
// and the licensing model counts bookable units. The rename is confined to the wire
// path, so no client change is needed for the other resources.
//
// Every route here is guarded. The tenant comes from the authenticated session rather
// than from the URL, so a caller cannot address another account's data even by guessing
// an id — the RLS policies are scoped to the session's tenant, not the path.

// ownerWriter derives the last_writer value from the authenticated session.
//
// It is used for the audit trail and for sync conflict tie-breaking, so it must
// identify the actor rather than defaulting to a constant that would make every change
// look like it came from the same place.
func ownerWriter(ctx *httpapi.Context) string {
	if ctx.UserID != "" {
		return "user:" + ctx.UserID
	}
	return "api"
}

func registerPlaceRoutes(router *httpapi.Router, deps Deps, resolver httpapi.TokenResolver) {
	guard := func(next httpapi.Handler) httpapi.Handler {
		return httpapi.RequireAuth(resolver, next)
	}

	router.Handle(http.MethodGet, "/places", guard(func(ctx *httpapi.Context) error {
		places, err := deps.Domain.ListPlaces(ctx.Request.Context(), ctx.AccountID)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"places": toPlaceViews(places)})
	}))

	router.Handle(http.MethodPost, "/places", guard(func(ctx *httpapi.Context) error {
		payload, err := decodeObject(ctx)
		if err != nil {
			return err
		}
		place, err := deps.Domain.CreatePlace(ctx.Request.Context(), ctx.AccountID, ownerWriter(ctx), payload)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusCreated, map[string]any{"place": toPlaceView(place)})
	}))

	router.Handle(http.MethodGet, "/places/{id}", guard(func(ctx *httpapi.Context) error {
		place, err := deps.Domain.GetPlace(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"))
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"place": toPlaceView(place)})
	}))

	router.Handle(http.MethodPut, "/places/{id}", guard(func(ctx *httpapi.Context) error {
		payload, err := decodeObject(ctx)
		if err != nil {
			return err
		}
		place, err := deps.Domain.UpdatePlace(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"), ownerWriter(ctx), payload)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"place": toPlaceView(place)})
	}))

	// Archive and restore are separate endpoints rather than a status field on PUT,
	// because they are the actions an owner takes from the list view and they must not
	// silently change other fields the way a full update would.
	router.Handle(http.MethodPost, "/places/{id}/archive", guard(func(ctx *httpapi.Context) error {
		return setPlaceStatus(ctx, deps, "archived")
	}))
	router.Handle(http.MethodPost, "/places/{id}/restore", guard(func(ctx *httpapi.Context) error {
		return setPlaceStatus(ctx, deps, "active")
	}))

	router.Handle(http.MethodDelete, "/places/{id}", guard(func(ctx *httpapi.Context) error {
		if err := deps.Domain.DeletePlace(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"), ownerWriter(ctx)); err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"ok": true})
	}))
}

func setPlaceStatus(ctx *httpapi.Context, deps Deps, status string) error {
	place, err := deps.Domain.SetPlaceStatus(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"), status, ownerWriter(ctx))
	if err != nil {
		return err
	}
	return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"place": toPlaceView(place)})
}

func registerUnitRoutes(router *httpapi.Router, deps Deps, resolver httpapi.TokenResolver) {
	guard := func(next httpapi.Handler) httpapi.Handler {
		return httpapi.RequireAuth(resolver, next)
	}

	router.Handle(http.MethodGet, "/units", guard(func(ctx *httpapi.Context) error {
		var placeID *string
		if raw := strings.TrimSpace(ctx.Query("placeId")); raw != "" {
			placeID = &raw
		}
		units, err := deps.Domain.ListUnits(ctx.Request.Context(), ctx.AccountID, placeID)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"units": toUnitViews(units)})
	}))

	router.Handle(http.MethodPost, "/units", guard(func(ctx *httpapi.Context) error {
		payload, err := decodeObject(ctx)
		if err != nil {
			return err
		}
		unit, err := deps.Domain.CreateUnit(ctx.Request.Context(), ctx.AccountID, ownerWriter(ctx), payload)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusCreated, map[string]any{"unit": toUnitView(unit)})
	}))

	router.Handle(http.MethodGet, "/units/{id}", guard(func(ctx *httpapi.Context) error {
		unit, err := deps.Domain.GetUnit(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"))
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"unit": toUnitView(unit)})
	}))

	router.Handle(http.MethodPut, "/units/{id}", guard(func(ctx *httpapi.Context) error {
		payload, err := decodeObject(ctx)
		if err != nil {
			return err
		}
		unit, err := deps.Domain.UpdateUnit(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"), ownerWriter(ctx), payload)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"unit": toUnitView(unit)})
	}))

	router.Handle(http.MethodPost, "/units/{id}/archive", guard(func(ctx *httpapi.Context) error {
		return setUnitStatus(ctx, deps, "archived")
	}))
	router.Handle(http.MethodPost, "/units/{id}/restore", guard(func(ctx *httpapi.Context) error {
		return setUnitStatus(ctx, deps, "active")
	}))

	router.Handle(http.MethodDelete, "/units/{id}", guard(func(ctx *httpapi.Context) error {
		if err := deps.Domain.DeleteUnit(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"), ownerWriter(ctx)); err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"ok": true})
	}))
}

func setUnitStatus(ctx *httpapi.Context, deps Deps, status string) error {
	unit, err := deps.Domain.SetUnitStatus(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"), status, ownerWriter(ctx))
	if err != nil {
		return err
	}
	return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"unit": toUnitView(unit)})
}

func registerReservationRoutes(router *httpapi.Router, deps Deps, resolver httpapi.TokenResolver) {
	guard := func(next httpapi.Handler) httpapi.Handler {
		return httpapi.RequireAuth(resolver, next)
	}

	router.Handle(http.MethodGet, "/reservations", guard(func(ctx *httpapi.Context) error {
		reservations, err := deps.Domain.ListReservations(ctx.Request.Context(), ctx.AccountID)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK,
			map[string]any{"reservations": toReservationViews(reservations)})
	}))

	router.Handle(http.MethodPost, "/reservations", guard(func(ctx *httpapi.Context) error {
		payload, err := decodeObject(ctx)
		if err != nil {
			return err
		}
		reservation, err := deps.Domain.CreateReservation(ctx.Request.Context(), ctx.AccountID, ownerWriter(ctx), payload)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusCreated,
			map[string]any{"reservation": toReservationView(reservation)})
	}))

	router.Handle(http.MethodGet, "/reservations/{id}", guard(func(ctx *httpapi.Context) error {
		reservation, err := deps.Domain.GetReservation(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"))
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"reservation": toReservationView(reservation)})
	}))

	router.Handle(http.MethodPut, "/reservations/{id}", guard(func(ctx *httpapi.Context) error {
		payload, err := decodeObject(ctx)
		if err != nil {
			return err
		}
		reservation, err := deps.Domain.UpdateReservation(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"), ownerWriter(ctx), payload)
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"reservation": toReservationView(reservation)})
	}))

	router.Handle(http.MethodPost, "/reservations/{id}/cancel", guard(func(ctx *httpapi.Context) error {
		reservation, err := deps.Domain.CancelReservation(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"), ownerWriter(ctx))
		if err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"reservation": toReservationView(reservation)})
	}))

	router.Handle(http.MethodDelete, "/reservations/{id}", guard(func(ctx *httpapi.Context) error {
		if err := deps.Domain.DeleteReservation(ctx.Request.Context(), ctx.AccountID, ctx.PathParam("id"), ownerWriter(ctx)); err != nil {
			return err
		}
		return httpapi.WriteJSONStatus(ctx, http.StatusOK, map[string]any{"ok": true})
	}))
}

// decodeObject reads a request body as a generic object.
//
// Unknown fields are tolerated here because the validators pick the fields they know and
// ignore the rest; rejecting them would make the API brittle to a client sending an
// extra column from a newer release.
func decodeObject(ctx *httpapi.Context) (map[string]any, error) {
	var payload map[string]any
	if err := ctx.DecodeJSONLoose(&payload); err != nil {
		return nil, err
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

// ---------------------------------------------------------------------------
// Wire views
// ---------------------------------------------------------------------------
//
// The view types are explicit rather than JSON tags on the store rows: a column added
// later must not start appearing in responses by accident, and the wire format is a
// published contract that deserves a visible definition.

type placeView struct {
	ID                  string `json:"id"`
	Name                string `json:"name"`
	Address             string `json:"address"`
	HasFoodService      bool   `json:"hasFoodService"`
	BreakfastPriceMinor int64  `json:"breakfastPriceMinor"`
	LunchPriceMinor     int64  `json:"lunchPriceMinor"`
	DinnerPriceMinor    int64  `json:"dinnerPriceMinor"`
	Status              string `json:"status"`
	Notes               string `json:"notes"`
	Version             int64  `json:"version"`
	UpdatedAt           string `json:"updatedAt"`
}

func toPlaceView(place *store.Place) placeView {
	if place == nil {
		return placeView{}
	}
	return placeView{
		ID:                  place.ID,
		Name:                place.Name,
		Address:             place.Address,
		HasFoodService:      place.HasFoodService,
		BreakfastPriceMinor: place.BreakfastPriceMinor,
		LunchPriceMinor:     place.LunchPriceMinor,
		DinnerPriceMinor:    place.DinnerPriceMinor,
		Status:              place.Status,
		Notes:               place.Notes,
		Version:             place.Version,
		UpdatedAt:           place.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
}

func toPlaceViews(places []store.Place) []placeView {
	views := make([]placeView, 0, len(places))
	for i := range places {
		views = append(views, toPlaceView(&places[i]))
	}
	return views
}

type unitView struct {
	ID             string  `json:"id"`
	PlaceID        *string `json:"placeId"`
	Kind           string  `json:"kind"`
	Name           string  `json:"name"`
	Location       string  `json:"location"`
	Capacity       int     `json:"capacity"`
	BasePriceMinor int64   `json:"basePriceMinor"`
	DepositMinor   int64   `json:"depositMinor"`
	// MonthlyRateMinor is the rent for a long-term let; 0 means the unit is not offered
	// for rent, which is how the Rentals screen decides what to list.
	MonthlyRateMinor int64  `json:"monthlyRateMinor"`
	Currency         string `json:"currency"`
	CheckInTime      string `json:"checkInTime"`
	CheckOutTime     string `json:"checkOutTime"`
	Status           string `json:"status"`
	Notes            string `json:"notes"`
	Version          int64  `json:"version"`
	UpdatedAt        string `json:"updatedAt"`
}

func toUnitView(unit *store.Unit) unitView {
	if unit == nil {
		return unitView{}
	}
	return unitView{
		ID:               unit.ID,
		PlaceID:          unit.PlaceID,
		Kind:             unit.Kind,
		Name:             unit.Name,
		Location:         unit.Location,
		Capacity:         unit.Capacity,
		BasePriceMinor:   unit.BasePriceMinor,
		DepositMinor:     unit.DepositMinor,
		MonthlyRateMinor: unit.MonthlyRateMinor,
		Currency:         unit.Currency,
		CheckInTime:      unit.CheckInTime,
		CheckOutTime:     unit.CheckOutTime,
		Status:           unit.Status,
		Notes:            unit.Notes,
		Version:          unit.Version,
		UpdatedAt:        unit.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
}

func toUnitViews(units []store.Unit) []unitView {
	views := make([]unitView, 0, len(units))
	for i := range units {
		views = append(views, toUnitView(&units[i]))
	}
	return views
}

type nightView struct {
	Date string `json:"date"`
}

type mealView struct {
	Date        string `json:"date"`
	Type        string `json:"type"`
	AmountMinor int64  `json:"amountMinor"`
}

// serviceView is one chargeable extra on a booking.
//
// The name is included because it is what the guest sees on the invoice, and it is not
// derivable from the type: an account may call dinner "Ужин на террасе". Without it the
// client could show only the total and not what it was for.
type serviceView struct {
	Type           string `json:"type"`
	Name           string `json:"name"`
	UnitPriceMinor int64  `json:"unitPriceMinor"`
	Quantity       int    `json:"quantity"`
}

type reservationView struct {
	ID                 string  `json:"id"`
	UnitID             string  `json:"unitId"`
	GuestName          string  `json:"guestName"`
	GuestPhone         string  `json:"guestPhone"`
	GuestEmail         string  `json:"guestEmail"`
	CheckInDate        string  `json:"checkInDate"`
	CheckOutDate       string  `json:"checkOutDate"`
	ActualCheckOutDate *string `json:"actualCheckOutDate"`
	Adults             int     `json:"adults"`
	Children           int     `json:"children"`
	Status             string  `json:"status"`
	// BookingKind is "stay" or "rental". A tenancy is a reservation with a long range,
	// which is what lets one exclusion constraint cover both modes.
	BookingKind        string        `json:"bookingKind"`
	MonthlyRateMinor   int64         `json:"monthlyRateMinor"`
	MeterReadings      any           `json:"meterReadings"`
	NightlyRateMinor   int64         `json:"nightlyRateMinor"`
	AccommodationMinor int64         `json:"accommodationMinor"`
	ServicesMinor      int64         `json:"servicesMinor"`
	TotalMinor         int64         `json:"totalMinor"`
	PrepaidMinor       int64         `json:"prepaidMinor"`
	DepositMinor       int64         `json:"depositMinor"`
	DepositStatus      string        `json:"depositStatus"`
	Notes              string        `json:"notes"`
	Nights             []nightView   `json:"nights"`
	Meals              []mealView    `json:"meals"`
	Services           []serviceView `json:"services"`
	ConflictCode       *string       `json:"conflictCode"`
	Version            int64         `json:"version"`
	UpdatedAt          string        `json:"updatedAt"`
}

func toReservationView(reservation *store.Reservation) reservationView {
	if reservation == nil {
		return reservationView{}
	}

	// Dates are rendered as plain calendar dates, never timestamps: a night is a
	// calendar day, and adding a time component would let a client in another timezone
	// shift it.
	nights := make([]nightView, 0, len(reservation.Nights))
	for _, night := range reservation.Nights {
		nights = append(nights, nightView{Date: night.NightDate.String()})
	}
	// Services were previously omitted from the response, so a client could show the total
	// but not what composed it. The rows were always stored.
	services := make([]serviceView, 0, len(reservation.Services))
	for _, service := range reservation.Services {
		services = append(services, serviceView{
			Type: service.ServiceType, Name: service.ServiceName,
			UnitPriceMinor: service.UnitPriceMinor, Quantity: service.Quantity,
		})
	}
	meals := make([]mealView, 0, len(reservation.Meals))
	for _, meal := range reservation.Meals {
		meals = append(meals, mealView{
			Date: meal.MealDate.String(), Type: meal.MealType, AmountMinor: meal.AmountMinor,
		})
	}

	var actualCheckOut *string
	if reservation.ActualCheckOutDate != nil {
		rendered := reservation.ActualCheckOutDate.String()
		actualCheckOut = &rendered
	}

	return reservationView{
		ID:                 reservation.ID,
		UnitID:             reservation.UnitID,
		GuestName:          reservation.GuestName,
		GuestPhone:         reservation.GuestPhone,
		GuestEmail:         reservation.GuestEmail,
		CheckInDate:        reservation.CheckInDate.String(),
		CheckOutDate:       reservation.CheckOutDate.String(),
		ActualCheckOutDate: actualCheckOut,
		Adults:             reservation.Adults,
		Children:           reservation.Children,
		Status:             reservation.Status,
		NightlyRateMinor:   reservation.NightlyRateMinor,
		AccommodationMinor: reservation.AccommodationMinor,
		ServicesMinor:      reservation.ServicesMinor,
		TotalMinor:         reservation.TotalMinor,
		PrepaidMinor:       reservation.PrepaidMinor,
		DepositMinor:       reservation.DepositMinor,
		DepositStatus:      reservation.DepositStatus,
		Notes:              reservation.Notes,
		BookingKind:        reservation.BookingKind,
		MonthlyRateMinor:   reservation.MonthlyRateMinor,
		MeterReadings:      decodeJSONOrEmpty(reservation.MeterReadings),
		Nights:             nights,
		Meals:              meals,
		Services:           services,
		ConflictCode:       reservation.ConflictCode,
		Version:            reservation.Version,
		UpdatedAt:          reservation.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
}

func toReservationViews(reservations []store.Reservation) []reservationView {
	views := make([]reservationView, 0, len(reservations))
	for i := range reservations {
		views = append(views, toReservationView(&reservations[i]))
	}
	return views
}

// decodeJSONOrEmpty renders a jsonb column for the wire.
//
// An unreadable value becomes `{}` rather than null or an error: meter readings are
// reference data an operator typed in, and a malformed blob must not make an otherwise
// valid booking unreadable.
func decodeJSONOrEmpty(raw []byte) any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return map[string]any{}
	}
	return decoded
}
