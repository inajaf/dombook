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
  return (await json<{ place: Record<string, unknown> }>(response)).place;
}

describe("sync pull/push", () => {
  it("exposes created rows via /sync/pull with a monotonic version", async () => {
    const { token } = await createAccount("sync1@example.test", "Дом");
    const before = await api("GET", "/sync/pull?since=0", { token });
    const beforeBody = await json<{ state: { version: number } }>(before);
    expect(beforeBody.state.version).toBe(0);

    const place = await makePlace(token, { name: "Синк-дом" });

    const pull = await api("GET", "/sync/pull?since=0", { token });
    const body = await json<{
      state: { version: number };
      changes: { places: { id: string; name: string }[]; properties: unknown[] };
    }>(pull);
    expect(body.state.version).toBeGreaterThan(0);
    expect(body.changes.places).toHaveLength(1);
    expect(body.changes.places[0]?.id).toBe(place.id);
    expect(body.changes.places[0]?.name).toBe("Синк-дом");
    expect(body.changes.properties).toHaveLength(0);
  });

  it("incremental pull with `since` only returns new changes", async () => {
    const { token } = await createAccount("sync2@example.test", "Дом");
    await makePlace(token, { name: "Первый дом" });

    const afterFirst = await api("GET", "/sync/pull?since=0", { token });
    const firstBody = await json<{ state: { version: number } }>(afterFirst);
    const versionAfterFirst = firstBody.state.version;

    const place2 = await makePlace(token, { name: "Второй дом" });

    const incremental = await api("GET", `/sync/pull?since=${versionAfterFirst}`, { token });
    const incBody = await json<{ changes: { places: { name: string }[] } }>(incremental);
    expect(incBody.changes.places).toHaveLength(1);
    expect(incBody.changes.places[0]?.name).toBe("Второй дом");

    const full = await api("GET", "/sync/pull?since=0", { token });
    const fullBody = await json<{ changes: { places: unknown[] } }>(full);
    expect(fullBody.changes.places.length).toBeGreaterThanOrEqual(2);
  });

  it("applies a pushed row and scopes it to the tenant", async () => {
    const a = await createAccount("sync3@example.test", "Дом А");
    const b = await createAccount("sync4@example.test", "Дом Б", SETUP_TOKEN);

    const pushed = await api("POST", "/sync/push", {
      token: a.token,
      body: {
        clientId: "test-desktop-1",
        changes: {
          places: [
            {
              id: "pushed-place-1",
              name: "Пришёл с клиента",
              address: "",
              has_food_service: 0,
              status: "active",
              notes: "",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    expect(pushed.status).toBe(200);
    const pushedBody = await json<{ applied: number }>(pushed);
    expect(pushedBody.applied).toBe(1);

    const pullA = await api("GET", "/sync/pull?since=0", { token: a.token });
    const pullABody = await json<{ changes: { places: { id: string }[] } }>(pullA);
    expect(pullABody.changes.places.map((p) => p.id)).toContain("pushed-place-1");

    const pullB = await api("GET", "/sync/pull?since=0", { token: b.token });
    const pullBBody = await json<{ changes: { places: unknown[] } }>(pullB);
    expect(pullBBody.changes.places).toHaveLength(0);
  });

  it("last-write-wins: an older push loses and is not applied", async () => {
    const { token } = await createAccount("sync5@example.test", "Дом");
    const row = {
      id: "lww-place",
      name: "Базовая версия",
      address: "",
      has_food_service: 0,
      status: "active",
      notes: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    const newer = await api("POST", "/sync/push", {
      token,
      body: { clientId: "device-new", changes: { places: [{ ...row, name: "Новая версия" }] } },
    });
    expect((await json<{ applied: number }>(newer)).applied).toBe(1);

    const older = await api("POST", "/sync/push", {
      token,
      body: { clientId: "device-old", changes: { places: [{ ...row, updated_at: "2025-01-01T00:00:00.000Z" }] } },
    });
    expect((await json<{ applied: number }>(older)).applied).toBe(0);

    const pull = await api("GET", "/sync/pull?since=0", { token });
    const body = await json<{ changes: { places: { name: string }[] } }>(pull);
    expect(body.changes.places[0]?.name).toBe("Новая версия");
  });

  it("rejects unknown tables and empty changes", async () => {
    const { token } = await createAccount("sync6@example.test", "Дом");
    const badTable = await api("POST", "/sync/push", {
      token,
      body: { clientId: "x", changes: { hacks: [] } },
    });
    expect(badTable.status).toBe(400);

    const empty = await api("POST", "/sync/push", {
      token,
      body: { clientId: "x", changes: {} },
    });
    expect(empty.status).toBe(200);
  });

  it("exports a full backup", async () => {
    const { token, accountId } = await createAccount("sync7@example.test", "Дом");
    const place = await makePlace(token, { name: "Бэкап-дом" });

    const exportResponse = await api("GET", "/backups/export", { token });
    expect(exportResponse.status).toBe(200);
    const body = await json<{
      schemaVersion: string;
      accountId: string;
      data: { places: { id: string }[] };
    }>(exportResponse);
    expect(body.accountId).toBe(accountId);
    expect(body.schemaVersion).toBe("0001");
    expect(body.data.places.map((p) => p.id)).toContain(place.id);
  });

  it("pushes a full reservation graph and pulls it back", async () => {
    const { token } = await createAccount("sync8@example.test", "Дом");
    const { checkInDate, checkOutDate, night } = reservationDates();
    const resId = "graph-reservation";
    const propId = "graph-property";
    const placeId = "graph-place";

    const push = await api("POST", "/sync/push", {
      token,
      body: {
        clientId: "desktop",
        changes: {
          places: [
            {
              id: placeId,
              name: "Граф-дом",
              address: "",
              has_food_service: 1,
              breakfast_price_minor: 500,
              lunch_price_minor: 800,
              dinner_price_minor: 700,
              status: "active",
              notes: "",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          properties: [
            {
              id: propId,
              place_id: placeId,
              kind: "house",
              name: "Граф-домик",
              location: "",
              capacity: 4,
              base_price_minor: 6000,
              deposit_minor: 0,
              currency: "AZN",
              check_in_time: "15:00",
              check_out_time: "11:00",
              status: "active",
              notes: "",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          reservations: [
            {
              id: resId,
              property_id: propId,
              guest_name: "Граф Гость",
              guest_phone: "+994551111111",
              guest_email: "",
              check_in_date: checkInDate,
              check_out_date: checkOutDate,
              adults: 2,
              children: 0,
              status: "confirmed",
              nightly_rate_minor: 6000,
              accommodation_minor: 6000,
              services_minor: 0,
              total_minor: 6000,
              prepaid_minor: 0,
              deposit_minor: 0,
              deposit_status: "none",
              actual_check_out_date: null,
              notes: "",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          reservation_nights: [
            {
              id: "graph-night",
              reservation_id: resId,
              property_id: propId,
              night_date: night,
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    expect(push.status).toBe(200);
    expect((await json<{ applied: number }>(push)).applied).toBeGreaterThanOrEqual(4);

    const pull = await api("GET", "/sync/pull?since=0", { token });
    const body = await json<{
      changes: {
        places: unknown[];
        properties: unknown[];
        reservations: unknown[];
        reservation_nights: unknown[];
      };
    }>(pull);
    expect(body.changes.reservations).toHaveLength(1);
    expect(body.changes.reservation_nights).toHaveLength(1);
  });
});
