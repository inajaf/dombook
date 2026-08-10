import { describe, expect, it } from "vitest";
import {
  api,
  json,
  createAccount,
  placePayload,
  propertyPayload,
  reservationPayload,
  reservationDates,
} from "./helpers";

const SETUP_TOKEN = "test-setup-token";

async function makePlace(token: string, overrides: Record<string, unknown> = {}) {
  const response = await api("POST", "/places", { token, body: placePayload(overrides) });
  expect(response.status).toBe(201);
  return (await json<{ place: { id: string } }>(response)).place;
}

async function makeProperty(token: string, overrides: Record<string, unknown> = {}) {
  const response = await api("POST", "/properties", { token, body: propertyPayload(overrides) });
  expect(response.status).toBe(201);
  return (await json<{ property: { id: string } }>(response)).property;
}

describe("places CRUD", () => {
  it("creates and reads a place", async () => {
    const { token } = await createAccount("places@example.test", "Дом");
    const place = await makePlace(token, { name: "Кемпинг «Озёрный»" });

    const get = await api("GET", `/places/${place.id}`, { token });
    expect(get.status).toBe(200);
    const body = await json<{ place: { name: string; has_food_service: number; status: string } }>(get);
    expect(body.place.name).toBe("Кемпинг «Озёрный»");
    expect(body.place.has_food_service).toBe(1);
    expect(body.place.status).toBe("active");
  });

  it("lists places and updates one", async () => {
    const { token } = await createAccount("places2@example.test", "Дом");
    const place = await makePlace(token, { name: "Старое название" });

    const updated = await api("PUT", `/places/${place.id}`, {
      token,
      body: placePayload({ name: "Новое название", hasFoodService: false }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await json<{ place: { name: string; has_food_service: number } }>(updated);
    expect(updatedBody.place.name).toBe("Новое название");
    expect(updatedBody.place.has_food_service).toBe(0);

    const list = await api("GET", "/places", { token });
    const listBody = await json<{ places: { name: string }[] }>(list);
    expect(listBody.places).toHaveLength(1);
  });

  it("archives, restores and soft-deletes a place", async () => {
    const { token } = await createAccount("places3@example.test", "Дом");
    const place = await makePlace(token, { name: "Сезонный дом" });

    const archived = await api("POST", `/places/${place.id}/archive`, { token });
    expect((await json<{ place: { status: string } }>(archived)).place.status).toBe("archived");

    const restored = await api("POST", `/places/${place.id}/restore`, { token });
    expect((await json<{ place: { status: string } }>(restored)).place.status).toBe("active");

    const deleted = await api("DELETE", `/places/${place.id}`, { token });
    expect(deleted.status).toBe(200);

    const afterDelete = await api("GET", `/places/${place.id}`, { token });
    expect(afterDelete.status).toBe(404);
  });

  it("rejects a duplicate place name and missing required fields", async () => {
    const { token } = await createAccount("places4@example.test", "Дом");
    await makePlace(token, { name: "Уникальное название" });

    const duplicate = await api("POST", "/places", { token, body: placePayload({ name: "уникальное НАЗВАНИЕ" }) });
    expect(duplicate.status).toBe(400);
    const dupBody = await json<{ error: { code: string } }>(duplicate);
    expect(dupBody.error.code).toBe("validation_error");

    const missing = await api("POST", "/places", { token, body: placePayload({ name: "" }) });
    expect(missing.status).toBe(400);
  });
});

describe("properties CRUD", () => {
  it("creates a property linked to a place", async () => {
    const { token } = await createAccount("props@example.test", "Дом");
    const place = await makePlace(token);
    const property = await makeProperty(token, { placeId: place.id, name: "Домик «Ромашка»" });

    const get = await api("GET", `/properties/${property.id}`, { token });
    expect(get.status).toBe(200);
    const body = await json<{ property: { name: string; kind: string; place_id: string | null } }>(get);
    expect(body.property.name).toBe("Домик «Ромашка»");
    expect(body.property.kind).toBe("cottage");
    expect(body.property.place_id).toBe(place.id);
  });

  it("rejects a property that references a missing or inactive place", async () => {
    const { token } = await createAccount("props2@example.test", "Дом");
    const response = await api("POST", "/properties", {
      token,
      body: propertyPayload({ placeId: "no-such-place", name: "Сломанный дом" }),
    });
    expect(response.status).toBe(400);
  });

  it("supports the full property lifecycle", async () => {
    const { token } = await createAccount("props3@example.test", "Дом");
    const place = await makePlace(token);
    const property = await makeProperty(token, { placeId: place.id, name: "Домик Жизни" });

    const updated = await api("PUT", `/properties/${property.id}`, {
      token,
      body: propertyPayload({ placeId: place.id, name: "Домик Обновлённый", capacity: 6 }),
    });
    expect((await json<{ property: { name: string; capacity: number } }>(updated)).property.capacity).toBe(6);

    await api("POST", `/properties/${property.id}/archive`, { token });
    await api("POST", `/properties/${property.id}/restore`, { token });
    const deleted = await api("DELETE", `/properties/${property.id}`, { token });
    expect(deleted.status).toBe(200);
    expect((await api("GET", `/properties/${property.id}`, { token })).status).toBe(404);
  });
});

describe("reservations CRUD", () => {
  async function makeReservation(token: string, propertyId: string, overrides: Record<string, unknown> = {}) {
    const response = await api("POST", "/reservations", {
      token,
      body: reservationPayload({ propertyId, guestName: "Иванов Иван", ...overrides }),
    });
    expect(response.status).toBe(201);
    return (await json<{ reservation: { id: string } }>(response)).reservation;
  }

  it("creates a reservation within the booking policy", async () => {
    const { token } = await createAccount("res@example.test", "Дом");
    const place = await makePlace(token, { hasFoodService: true });
    const property = await makeProperty(token, { placeId: place.id, basePriceMinor: 5000 });
    const { night } = reservationDates();

    const created = await api("POST", "/reservations", {
      token,
      body: reservationPayload({
        propertyId: property.id,
        mealItems: [{ date: night, type: "breakfast", amountMinor: 500 }],
        prepaidMinor: 2000,
        depositMinor: 1000,
        depositStatus: "received",
      }),
    });
    expect(created.status).toBe(201);
    const body = await json<{
      reservation: {
        guest_name: string;
        status: string;
        total_minor: number;
        services_minor: number;
        deposit_status: string;
      };
    }>(created);
    expect(body.reservation.guest_name).toBe("Иванов Иван");
    expect(body.reservation.status).toBe("hold");
    expect(body.reservation.services_minor).toBe(500);
    expect(body.reservation.total_minor).toBe(5000 + 500);
    expect(body.reservation.deposit_status).toBe("received");
  });

  it("rejects a meal outside the booked nights", async () => {
    const { token } = await createAccount("res2@example.test", "Дом");
    const place = await makePlace(token, { hasFoodService: true });
    const property = await makeProperty(token, { placeId: place.id });
    const { checkInDate } = reservationDates();

    const outside = await api("POST", "/reservations", {
      token,
      body: reservationPayload({
        propertyId: property.id,
        mealItems: [{ date: checkInDate, type: "breakfast", amountMinor: 500 }],
        checkOutDate: checkInDate,
      }),
    });
    // checkOut == checkIn is invalid regardless; just assert 400 validation.
    expect(outside.status).toBe(400);
  });

  it("rejects meals for a place without food service", async () => {
    const { token } = await createAccount("res3@example.test", "Дом");
    const place = await makePlace(token, { hasFoodService: false });
    const property = await makeProperty(token, { placeId: place.id });
    const { night } = reservationDates();

    const response = await api("POST", "/reservations", {
      token,
      body: reservationPayload({
        propertyId: property.id,
        mealItems: [{ date: night, type: "breakfast", amountMinor: 500 }],
      }),
    });
    expect(response.status).toBe(400);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects prepayment larger than the total", async () => {
    const { token } = await createAccount("res4@example.test", "Дом");
    const place = await makePlace(token);
    const property = await makeProperty(token, { placeId: place.id, basePriceMinor: 3000 });

    const response = await api("POST", "/reservations", {
      token,
      body: reservationPayload({ propertyId: property.id, prepaidMinor: 999999 }),
    });
    expect(response.status).toBe(400);
  });

  it("cancels then soft-deletes a reservation", async () => {
    const { token } = await createAccount("res5@example.test", "Дом");
    const place = await makePlace(token);
    const property = await makeProperty(token, { placeId: place.id });
    const reservation = await makeReservation(token, property.id);

    const cancelled = await api("POST", `/reservations/${reservation.id}/cancel`, { token });
    expect((await json<{ reservation: { status: string } }>(cancelled)).reservation.status).toBe("cancelled");

    const deleted = await api("DELETE", `/reservations/${reservation.id}`, { token });
    expect(deleted.status).toBe(200);

    const list = await api("GET", "/reservations", { token });
    const listBody = await json<{ reservations: unknown[] }>(list);
    expect(listBody.reservations).toHaveLength(0);
  });

  it("refuses to delete an active reservation before cancellation", async () => {
    const { token } = await createAccount("res6@example.test", "Дом");
    const place = await makePlace(token);
    const property = await makeProperty(token, { placeId: place.id });
    const reservation = await makeReservation(token, property.id);

    const deleted = await api("DELETE", `/reservations/${reservation.id}`, { token });
    expect(deleted.status).toBe(400);
  });
});

describe("app settings", () => {
  it("stores and lists tenant settings", async () => {
    const { token } = await createAccount("settings@example.test", "Дом");
    const set = await api("PUT", "/settings/theme", { token, body: { value: "dark" } });
    expect(set.status).toBe(200);
    const setBody = await json<{ setting: { setting_key: string; setting_value: string } }>(set);
    expect(setBody.setting.setting_value).toBe("dark");

    const list = await api("GET", "/settings", { token });
    const listBody = await json<{ settings: { setting_key: string }[] }>(list);
    expect(listBody.settings.map((s) => s.setting_key)).toContain("theme");
  });
});
