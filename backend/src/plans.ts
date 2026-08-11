// Plan definitions and limit enforcement. This is the single authoritative
// source for what each `accounts.plan` allows, used both for per-request
// limit checks and for the admin plans listing.
//
// Captain's intent:
//   - free    = 1 active place + 1 active property (paid upgrade prompt)
//   - business = unlimited
//   - pro exists in the schema as an intermediate plan but is not yet part of
//     the business logic; leave its limits undefined (unlimited) until the
//     captain assigns them. Treating an unknown plan as unlimited is the safe
//     choice: it never blocks an existing account from operating.
//
// Limit semantics: limits apply to *creating new active records*. Archive,
// restore, edit, and soft-delete never consume a limit.
//
// Decision on archived rows: archived places/properties do NOT count toward
// the limit. Rationale: a free user should be able to archive their first
// property and create a replacement, rather than being permanently blocked by
// inactive historical rows. This is verified by tests. Deleted (soft-deleted)
// rows never count either, since they are gone from the active set.

import type { AccountPlan } from "./types";
import { planLimitError } from "./http";

export interface PlanDefinition {
  id: AccountPlan;
  name: string;
  description: string;
  /** maxPlaces = null means unlimited (no cap). */
  maxPlaces: number | null;
  /** maxProperties = null means unlimited (no cap). */
  maxProperties: number | null;
}

export const PLANS: readonly PlanDefinition[] = [
  {
    id: "free",
    name: "Бесплатный",
    description: "1 дом отдыха и 1 объект размещения",
    maxPlaces: 1,
    maxProperties: 1,
  },
  {
    id: "pro",
    name: "Pro",
    description: "Промежуточный тариф (лимиты ещё не заданы)",
    maxPlaces: null,
    maxProperties: null,
  },
  {
    id: "business",
    name: "Business",
    description: "Без лимитов: дома и объекты без ограничений",
    maxPlaces: null,
    maxProperties: null,
  },
];

export const PLAN_BY_ID: Readonly<Record<string, PlanDefinition>> = Object.fromEntries(
  PLANS.map((plan) => [plan.id, plan]),
);

export function planDefinition(plan: string): PlanDefinition {
  return PLAN_BY_ID[plan] ?? (PLAN_BY_ID.business as PlanDefinition);
}

export function isKnownPlan(plan: string): boolean {
  return plan in PLAN_BY_ID;
}

// Enforces the plan limit for creating a new active place. Throws an ApiError
// (403, `plan_limit`) with the plan's cap embedded in the Russian message so a
// client can show an upgrade prompt.
export function assertCanCreatePlace(current: number, plan: string): void {
  const def = planDefinition(plan);
  if (def.maxPlaces !== null && current >= def.maxPlaces) {
    throw planLimitError(
      "places",
      def.maxPlaces,
      `Тариф «${def.name}» позволяет создать не более ${def.maxPlaces} дома отдыха.`,
    );
  }
}

export function assertCanCreateProperty(current: number, plan: string): void {
  const def = planDefinition(plan);
  if (def.maxProperties !== null && current >= def.maxProperties) {
    throw planLimitError(
      "properties",
      def.maxProperties,
      `Тариф «${def.name}» позволяет создать не более ${def.maxProperties} объекта размещения.`,
    );
  }
}
