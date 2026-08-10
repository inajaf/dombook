import { describe, expect, it } from "vitest";

const SETUP_TOKEN = "test-setup-token";
import { api, json, createAccount, placePayload, propertyPayload } from "./helpers";

async function createPlaceFor(token: string, name: string) {
  const response = await api("POST", "/places", { token, body: placePayload({ name }) });
  expect(response.status).toBe(201);
  return (await json<{ place: { id: string; name: string } }>(response)).place;
}

describe("tenant isolation", () => {
  it("keeps tenant A's places invisible to tenant B", async () => {
    const a = await createAccount("tenant-a@example.test", "Дом А");
    const b = await createAccount("tenant-b@example.test", "Дом Б", SETUP_TOKEN);
    const placeA = await createPlaceFor(a.token, "Кемпинг А");

    const listB = await api("GET", "/places", { token: b.token });
    const listBBody = await json<{ places: unknown[] }>(listB);
    expect(listBBody.places).toHaveLength(0);

    const getB = await api("GET", `/places/${placeA.id}`, { token: b.token });
    expect(getB.status).toBe(404);

    const listA = await api("GET", "/places", { token: a.token });
    const listABody = await json<{ places: { id: string }[] }>(listA);
    expect(listABody.places).toHaveLength(1);
  });

  it("prevents cross-tenant updates and deletes", async () => {
    const a = await createAccount("tenant-c@example.test", "Дом C");
    const b = await createAccount("tenant-d@example.test", "Дом D", SETUP_TOKEN);
    const placeA = await createPlaceFor(a.token, "Кемпинг C");

    const updateB = await api("PUT", `/places/${placeA.id}`, {
      token: b.token,
      body: placePayload({ name: "Взлом" }),
    });
    expect(updateB.status).toBe(404);

    const deleteB = await api("DELETE", `/places/${placeA.id}`, { token: b.token });
    expect(deleteB.status).toBe(404);

    const stillThere = await api("GET", `/places/${placeA.id}`, { token: a.token });
    expect(stillThere.status).toBe(200);
  });

  it("isolates properties and reservations across tenants", async () => {
    const a = await createAccount("tenant-e@example.test", "Дом E");
    const b = await createAccount("tenant-f@example.test", "Дом F", SETUP_TOKEN);

    const place = await createPlaceFor(a.token, "Кемпинг E");
    const prop = await api("POST", "/properties", {
      token: a.token,
      body: propertyPayload({ placeId: place.id, name: "Домик E" }),
    });
    expect(prop.status).toBe(201);
    const propBody = await json<{ property: { id: string } }>(prop);

    const listB = await api("GET", "/properties", { token: b.token });
    const listBBody = await json<{ properties: unknown[] }>(listB);
    expect(listBBody.properties).toHaveLength(0);

    const getB = await api("GET", `/properties/${propBody.property.id}`, { token: b.token });
    expect(getB.status).toBe(404);

    const reservationsB = await api("GET", "/reservations", { token: b.token });
    const reservationsBBody = await json<{ reservations: unknown[] }>(reservationsB);
    expect(reservationsBBody.reservations).toHaveLength(0);
  });

  it("rejects a reservation that references another tenant's property", async () => {
    const a = await createAccount("tenant-g@example.test", "Дом G");
    const b = await createAccount("tenant-h@example.test", "Дом H", SETUP_TOKEN);
    const place = await createPlaceFor(a.token, "Кемпинг G");
    const prop = await api("POST", "/properties", {
      token: a.token,
      body: propertyPayload({ placeId: place.id, name: "Домик G" }),
    });
    const propBody = await json<{ property: { id: string } }>(prop);

    const response = await api("POST", "/reservations", {
      token: b.token,
      body: {
        propertyId: propBody.property.id,
        guestName: "Чужой гость",
        guestPhone: "+994551111111",
        checkInDate: "2030-01-10",
        checkOutDate: "2030-01-12",
        adults: 1,
      },
    });
    expect(response.status).toBe(400);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("validation_error");
  });

  it("does not leak settings or sync data across tenants", async () => {
    const a = await createAccount("tenant-i@example.test", "Дом I");
    const b = await createAccount("tenant-j@example.test", "Дом J", SETUP_TOKEN);

    await api("PUT", "/settings/theme", { token: a.token, body: { value: "dark" } });
    await createPlaceFor(a.token, "Кемпинг I");

    const settingsB = await api("GET", "/settings", { token: b.token });
    const settingsBBody = await json<{ settings: unknown[] }>(settingsB);
    expect(settingsBBody.settings).toHaveLength(0);

    const pullB = await api("GET", "/sync/pull?since=0", { token: b.token });
    const pullBBody = await json<{ changes: Record<string, unknown[]> }>(pullB);
    expect(pullBBody.changes.places).toHaveLength(0);
    expect(pullBBody.changes.app_settings).toHaveLength(0);
  });
});
