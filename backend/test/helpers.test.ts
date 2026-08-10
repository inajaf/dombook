import { describe, expect, it } from "vitest";
import {
  base64url,
  base64urlDecode,
  signJwt,
  verifyJwt,
  constantTimeEqual,
  uuid,
  otpCode,
  randomToken,
  sha256Hex,
} from "../src/crypto";
import {
  addDaysIso,
  addCalendarMonths,
  todayInTimeZone,
  bookingLimits,
  assertBookingDates,
  BOOKING_POLICY,
} from "../src/time";

describe("crypto", () => {
  it("signs and verifies a JWT round-trip", async () => {
    const token = await signJwt({ sub: "account-1", role: "owner" }, "secret", 3600);
    const payload = await verifyJwt(token, "secret");
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("account-1");
    expect(payload!.role).toBe("owner");
    expect(typeof payload!.iat).toBe("number");
    expect(typeof payload!.exp).toBe("number");
    expect(payload!.exp! > payload!.iat!).toBe(true);
  });

  it("rejects a JWT signed with the wrong secret", async () => {
    const token = await signJwt({ sub: "x" }, "secret-a", 3600);
    expect(await verifyJwt(token, "secret-b")).toBeNull();
  });

  it("rejects a tampered JWT", async () => {
    const token = await signJwt({ sub: "x" }, "secret", 3600);
    const [header, body, sig] = token.split(".");
    const tampered = `${header}.${body!.replace(/.$/, sig!.slice(-1))}.${sig}`;
    expect(await verifyJwt(tampered, "secret")).toBeNull();
  });

  it("rejects an expired JWT", async () => {
    const token = await signJwt({ sub: "x" }, "secret", -10);
    expect(await verifyJwt(token, "secret")).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyJwt("not-a-jwt", "secret")).toBeNull();
    expect(await verifyJwt("a.b", "secret")).toBeNull();
  });

  it("constantTimeEqual matches and mismatches", async () => {
    expect(await constantTimeEqual("same", "same")).toBe(true);
    expect(await constantTimeEqual("same", "diff")).toBe(false);
  });

  it("base64url round-trips bytes", () => {
    const input = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
    expect([...base64urlDecode(base64url(input))]).toEqual([...input]);
  });

  it("generates shaped tokens", async () => {
    expect(uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(otpCode(6)).toMatch(/^\d{6}$/);
    expect(await sha256Hex("abc")).toHaveLength(64);
  });
});

describe("time", () => {
  it("addDaysIso rolls over month boundaries", () => {
    expect(addDaysIso("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysIso("2026-01-31", 30)).toBe("2026-03-02");
  });

  it("addCalendarMonths clamps to the last day", () => {
    expect(addCalendarMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addCalendarMonths("2026-08-11", 3)).toBe("2026-11-11");
    expect(addCalendarMonths("2026-12-31", 1)).toBe("2027-01-31");
  });

  it("todayInTimeZone returns YYYY-MM-DD", () => {
    const today = todayInTimeZone();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("bookingLimits computes the advance window", () => {
    const today = "2026-08-11";
    const limits = bookingLimits(today, today);
    expect(limits.maximumCheckInDate).toBe(addDaysIso(today, 21));
    expect(limits.maximumStayMonths).toBe(3);
    expect(limits.timeZone).toBe("Asia/Baku");
    expect(limits.maximumCheckOutDate).toBe(addCalendarMonths(today, 3));
  });

  it("assertBookingDates accepts a valid window", () => {
    const today = "2026-08-11";
    expect(() => assertBookingDates({ checkInDate: today, checkOutDate: addDaysIso(today, 1), today })).not.toThrow();
  });

  it("assertBookingDates rejects past check-in", () => {
    const today = "2026-08-11";
    expect(() => assertBookingDates({ checkInDate: "2026-08-10", checkOutDate: "2026-08-11", today })).toThrow(
      "не может быть в прошлом",
    );
  });

  it("assertBookingDates rejects check-in beyond the advance window", () => {
    const today = "2026-08-11";
    const far = addDaysIso(today, BOOKING_POLICY.maximumAdvanceDays + 1);
    expect(() => assertBookingDates({ checkInDate: far, checkOutDate: addDaysIso(far, 1), today })).toThrow(
      "день вперёд",
    );
  });

  it("assertBookingDates rejects stays longer than the maximum", () => {
    const today = "2026-08-11";
    const tooLong = addCalendarMonths(today, 3) + "1";
    expect(() => assertBookingDates({ checkInDate: today, checkOutDate: tooLong, today })).toThrow("быть дольше");
  });

  it("assertBookingDates skips validation when dates are unchanged", () => {
    const today = "2026-08-11";
    expect(() =>
      assertBookingDates({
        checkInDate: today,
        checkOutDate: addDaysIso(today, 1),
        today,
        existingReservation: { check_in_date: today, check_out_date: addDaysIso(today, 1) },
      }),
    ).not.toThrow();
  });
});
