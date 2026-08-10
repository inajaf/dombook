// Field validation mirroring the desktop domain rules
// (src/database.cjs) so the cloud API accepts the same shapes and enforces
// the same invariants. Errors are 400 validation_error responses.

import { ApiError } from "./http";
import { assertBookingDates, todayInTimeZone } from "./time";
import type { DepositStatus, Place, Property, Reservation, ReservationMeal, ReservationStatus } from "./types";

const ALLOWED_RESERVATION_STATUSES = new Set<ReservationStatus>([
  "hold", "confirmed", "checked_in", "checked_out", "cancelled", "no_show",
]);

const ALLOWED_DEPOSIT_STATUSES = new Set<DepositStatus>([
  "none", "due", "received", "returned", "partially_withheld", "withheld",
]);

const ALLOWED_MEAL_TYPES = new Set(["breakfast", "lunch", "dinner"]);

function requiredText(value: unknown, label: string, max = 200): string {
  const result = String(value ?? "").trim();
  if (!result) throw new ApiError(400, "validation_error", `${label}: обязательное поле`);
  if (result.length > max) throw new ApiError(400, "validation_error", `${label}: максимум ${max} символов`);
  return result;
}

function optionalText(value: unknown, max = 2000): string {
  const result = String(value ?? "").trim();
  if (result.length > max) throw new ApiError(400, "validation_error", `Текст: максимум ${max} символов`);
  return result;
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new ApiError(400, "validation_error", `${label}: укажите целое число от ${min} до ${max}`);
  }
  return result;
}

function money(value: unknown, label: string): number {
  return integer(value, label, 0, 1_000_000_000);
}

function validDate(value: unknown, label: string): string {
  const result = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new ApiError(400, "validation_error", `${label}: неверная дата`);
  }
  const [year, month, day] = result.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month! - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ApiError(400, "validation_error", `${label}: неверная дата`);
  }
  return result;
}

export function eachNight(checkIn: string, checkOut: string): string[] {
  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  if (end <= start) throw new ApiError(400, "validation_error", "Дата выезда должна быть позже даты заезда");
  const result: string[] = [];
  for (let cursor = start; cursor < end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    result.push(cursor.toISOString().slice(0, 10));
    if (result.length > 730) throw new ApiError(400, "validation_error", "Бронирование не может быть длиннее 730 ночей");
  }
  return result;
}

function normalizePhone(value: unknown): string {
  return String(value ?? "").replace(/[^\d+]/g, "").slice(0, 32);
}

function canonicalName(value: string): string {
  return value.trim().toLocaleLowerCase("ru-RU");
}

export function canonicalNameOf(value: unknown): string {
  return canonicalName(String(value ?? ""));
}

export type PlaceInput = {
  name: string;
  address: string;
  hasFoodService: number;
  breakfastPriceMinor: number;
  lunchPriceMinor: number;
  dinnerPriceMinor: number;
  notes: string;
  status: "active" | "archived";
};

export function validatePlace(input: Record<string, unknown>): PlaceInput {
  const hasFoodService =
    input.hasFoodService === true || input.hasFoodService === 1 || input.hasFoodService === "1";
  return {
    name: requiredText(input.name, "Название дома отдыха", 140),
    address: optionalText(input.address, 240),
    hasFoodService: hasFoodService ? 1 : 0,
    breakfastPriceMinor: hasFoodService ? money(input.breakfastPriceMinor ?? 0, "Цена завтрака") : 0,
    lunchPriceMinor: hasFoodService ? money(input.lunchPriceMinor ?? 0, "Цена обеда") : 0,
    dinnerPriceMinor: hasFoodService ? money(input.dinnerPriceMinor ?? 0, "Цена ужина") : 0,
    notes: optionalText(input.notes, 2000),
    status: input.status === "archived" ? "archived" : "active",
  };
}

export type PropertyInput = {
  placeId: string | null;
  kind: "cottage" | "house";
  name: string;
  location: string;
  capacity: number;
  basePriceMinor: number;
  depositMinor: number;
  currency: string;
  checkInTime: string;
  checkOutTime: string;
  notes: string;
  status: "active" | "archived";
};

export function validateProperty(
  input: Record<string, unknown>,
  placeResolver: (id: string) => Promise<Place | null>,
): Promise<PropertyInput> {
  return (async () => {
    const rawPlaceId = input.placeId === null || input.placeId === "" || input.placeId === undefined
      ? null
      : String(input.placeId);
    const placeId = rawPlaceId ? requiredText(rawPlaceId, "Дом отдыха", 64) : null;
    if (placeId) {
      const place = await placeResolver(placeId);
      if (!place || place.status !== "active") {
        throw new ApiError(400, "validation_error", "Выберите активный дом отдыха");
      }
    }
    return {
      placeId,
      kind: input.kind === "cottage" ? "cottage" : "house",
      name: requiredText(input.name, "Наименование дома", 120),
      location: optionalText(input.location, 200),
      capacity: integer(input.capacity, "Вместимость", 1, 100),
      basePriceMinor: money(input.basePriceMinor, "Базовая цена"),
      depositMinor: money(input.depositMinor, "Депозит"),
      currency: requiredText(input.currency || "AZN", "Валюта", 3).toUpperCase(),
      checkInTime: requiredText(input.checkInTime || "15:00", "Время заезда", 5),
      checkOutTime: requiredText(input.checkOutTime || "11:00", "Время выезда", 5),
      notes: optionalText(input.notes, 2000),
      status: input.status === "archived" ? "archived" : "active",
    };
  })();
}

export interface ReservationInput {
  propertyId: string;
  guestName: string;
  guestPhone: string;
  guestEmail: string;
  checkInDate: string;
  checkOutDate: string;
  nights: string[];
  adults: number;
  children: number;
  status: ReservationStatus;
  nightlyRateMinor: number;
  accommodationMinor: number;
  meals: ReservationMeal[];
  servicesMinor: number;
  totalMinor: number;
  prepaidMinor: number;
  depositMinor: number;
  depositStatus: DepositStatus;
  actualCheckOutDate: string | null;
  notes: string;
}

export interface ReservationDeps {
  getProperty(id: string): Promise<Property | null>;
  getPlace(id: string): Promise<Place | null>;
  getReservation(id: string): Promise<Reservation | null>;
  todayProvider(): string;
}

export function validateReservation(
  input: Record<string, unknown>,
  deps: ReservationDeps,
  reservationId: string | null = null,
): Promise<ReservationInput> {
  return (async () => {
    const propertyId = String(input.propertyId);
    const property = await deps.getProperty(propertyId);
    if (!property || property.status !== "active") {
      throw new ApiError(400, "validation_error", "Выберите активный дом");
    }
    const checkInDate = validDate(input.checkInDate, "Дата заезда");
    const checkOutDate = validDate(input.checkOutDate, "Дата выезда");
    const nights = eachNight(checkInDate, checkOutDate);
    const status = ALLOWED_RESERVATION_STATUSES.has(input.status as ReservationStatus)
      ? (input.status as ReservationStatus)
      : "hold";
    const depositStatus = ALLOWED_DEPOSIT_STATUSES.has(input.depositStatus as DepositStatus)
      ? (input.depositStatus as DepositStatus)
      : "none";
    const adults = integer(input.adults ?? 1, "Взрослые", 1, 100);
    const children = integer(input.children ?? 0, "Дети", 0, 100);
    const prepaidMinor = money(input.prepaidMinor, "Предоплата");
    const depositMinor = money(input.depositMinor, "Депозит");
    if (adults + children > property.capacity) {
      throw new ApiError(
        400,
        "validation_error",
        `Вместимость дома — ${property.capacity}. Уменьшите число гостей или выберите другой дом`,
      );
    }
    const existing = reservationId ? await deps.getReservation(reservationId) : null;
    assertBookingDates({
      checkInDate,
      checkOutDate,
      today: deps.todayProvider(),
      existingReservation: existing,
    });
    const actualCheckOutDate = existing?.actual_check_out_date ?? null;
    if (actualCheckOutDate && (actualCheckOutDate < checkInDate || actualCheckOutDate >= checkOutDate)) {
      throw new ApiError(
        400,
        "validation_error",
        "После досрочного выезда даты проживания нельзя сдвинуть за фактическую дату выезда",
      );
    }
    const nightlyRateMinor =
      existing && existing.property_id === propertyId ? existing.nightly_rate_minor : property.base_price_minor;
    const accommodationMinor = actualCheckOutDate
      ? existing!.accommodation_minor
      : nightlyRateMinor * nights.length;

    const place = property.place_id ? await deps.getPlace(property.place_id) : null;

    const rawMeals = Array.isArray(input.mealItems) ? (input.mealItems as unknown[]) : [];
    if (rawMeals.length > 2190) {
      throw new ApiError(400, "validation_error", "Питание: слишком много записей");
    }
    const effectiveNights = actualCheckOutDate ? nights.filter((night) => night < actualCheckOutDate) : nights;
    const allowedDates = new Set(effectiveNights);
    const mealKeys = new Set<string>();
    const meals: ReservationMeal[] = [];
    for (const raw of rawMeals) {
      const item = raw as Record<string, unknown>;
      const date = validDate(item.date, "Дата питания");
      const type = String(item.type ?? "");
      if (!ALLOWED_MEAL_TYPES.has(type)) throw new ApiError(400, "validation_error", "Питание: неизвестный тип");
      const amountMinor = money(item.amountMinor ?? 0, "Сумма питания");
      if (amountMinor <= 0) continue;
      if (!allowedDates.has(date)) {
        throw new ApiError(
          400,
          "validation_error",
          `Питание за ${date} находится вне фактических дат проживания`,
        );
      }
      const key = `${date}:${type}`;
      if (mealKeys.has(key)) throw new ApiError(400, "validation_error", `Питание за ${date} указано повторно`);
      mealKeys.add(key);
      meals.push({
        id: "",
        tenant_id: "",
        reservation_id: "",
        meal_date: date,
        meal_type: type as ReservationMeal["meal_type"],
        amount_minor: amountMinor,
        created_at: "",
        updated_at: "",
        deleted_at: null,
        version: 0,
        last_writer: "",
      });
    }

    const servicesMinor = meals.reduce((sum, item) => sum + item.amount_minor, 0);
    if (servicesMinor > 0 && !place?.has_food_service) {
      throw new ApiError(
        400,
        "validation_error",
        "Для выбранного дома питание недоступно: включите кухню или ресторан в доме отдыха",
      );
    }
    const totalMinor = accommodationMinor + servicesMinor;
    if (prepaidMinor > totalMinor) {
      throw new ApiError(400, "validation_error", "Предоплата не может быть больше общей стоимости брони");
    }
    if (depositMinor === 0 && depositStatus !== "none") {
      throw new ApiError(
        400,
        "validation_error",
        "Для статуса депозита укажите сумму или выберите «Не требуется»",
      );
    }

    return {
      propertyId: property.id,
      guestName: requiredText(input.guestName, "Имя гостя", 160),
      guestPhone: normalizePhone(input.guestPhone),
      guestEmail: optionalText(input.guestEmail, 200),
      checkInDate,
      checkOutDate,
      nights,
      adults,
      children,
      status,
      nightlyRateMinor,
      accommodationMinor,
      meals,
      servicesMinor,
      totalMinor,
      prepaidMinor,
      depositMinor,
      depositStatus,
      actualCheckOutDate,
      notes: optionalText(input.notes, 2000),
    };
  })();
}

export { requiredText, optionalText, integer, money, validDate, normalizePhone, canonicalName };
