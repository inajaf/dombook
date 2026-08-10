export type UserRole = "owner" | "admin" | "staff";
export type AccountPlan = "free" | "pro" | "business";

export interface Account {
  id: string;
  name: string;
  plan: AccountPlan;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  account_id: string;
  email: string;
  name: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  account_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Invite {
  id: string;
  account_id: string;
  email: string;
  role: "admin" | "staff";
  token_hash: string;
  created_by: string;
  status: "pending" | "accepted" | "revoked";
  expires_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TenantState {
  tenant_id: string;
  version: number;
  updated_at: string;
}

export interface Place {
  id: string;
  tenant_id: string;
  name: string;
  address: string;
  has_food_service: number;
  breakfast_price_minor: number;
  lunch_price_minor: number;
  dinner_price_minor: number;
  status: "active" | "archived";
  notes: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  last_writer: string;
}

export interface Property {
  id: string;
  tenant_id: string;
  place_id: string | null;
  kind: "cottage" | "house";
  name: string;
  location: string;
  capacity: number;
  base_price_minor: number;
  deposit_minor: number;
  currency: string;
  check_in_time: string;
  check_out_time: string;
  status: "active" | "archived";
  notes: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  last_writer: string;
}

export type ReservationStatus =
  | "hold"
  | "confirmed"
  | "checked_in"
  | "checked_out"
  | "cancelled"
  | "no_show";

export type DepositStatus =
  | "none"
  | "due"
  | "received"
  | "returned"
  | "partially_withheld"
  | "withheld";

export interface Reservation {
  id: string;
  tenant_id: string;
  property_id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  check_in_date: string;
  check_out_date: string;
  adults: number;
  children: number;
  status: ReservationStatus;
  nightly_rate_minor: number;
  accommodation_minor: number;
  services_minor: number;
  total_minor: number;
  prepaid_minor: number;
  deposit_minor: number;
  deposit_status: DepositStatus;
  actual_check_out_date: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  last_writer: string;
}

export interface ReservationNight {
  id: string;
  tenant_id: string;
  reservation_id: string;
  property_id: string;
  night_date: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  last_writer: string;
}

export interface ReservationService {
  id: string;
  tenant_id: string;
  reservation_id: string;
  service_type: "breakfast" | "lunch" | "dinner";
  service_name: string;
  unit_price_minor: number;
  quantity: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  last_writer: string;
}

export interface ReservationMeal {
  id: string;
  tenant_id: string;
  reservation_id: string;
  meal_date: string;
  meal_type: "breakfast" | "lunch" | "dinner";
  amount_minor: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  last_writer: string;
}

export interface AppSetting {
  id: string;
  tenant_id: string;
  setting_key: string;
  setting_value: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  last_writer: string;
}

// Tables replicated to clients via /sync/*. Order matters: rows are applied
// by the client in this order (parents before children).
export const SYNC_TABLES = [
  "places",
  "properties",
  "reservations",
  "reservation_nights",
  "reservation_services",
  "reservation_meals",
  "app_settings",
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];
export type SyncRow = Record<string, unknown>;
