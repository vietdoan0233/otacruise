import type { SelectionResult, TicketVariant } from "./types.js";

// Exact total-price thresholds supplied for the Otacruise event.
export const FOUR_PERSON_PRICE_CENTS = new Set([36600, 38600, 39800]);

const EXPECTED_NAMES_BY_PRICE = new Map<number, Set<string>>([
  [36600, new Set(["Cabin C, 4 pers."])],
  [38600, new Set(["Cabin B, 4 pers."])],
  [39800, new Set(["Prom., 4 pers.", "Cabin A, 4 pers."])],
]);

export function normalizeVariantName(name: string): string {
  return name.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function isFourPersonVariant(variant: TicketVariant): boolean {
  return FOUR_PERSON_PRICE_CENTS.has(variant.totalPriceCents);
}

export function isKnownFourPersonLabel(variant: TicketVariant): boolean {
  const expected = EXPECTED_NAMES_BY_PRICE.get(variant.totalPriceCents);
  return expected?.has(normalizeVariantName(variant.name)) ?? false;
}

export function selectFourPersonVariants(
  variants: TicketVariant[],
): SelectionResult {
  const available = variants.filter((variant) => variant.available);
  const unavailable = variants.filter((variant) => !variant.available);
  const matching = available.filter(isFourPersonVariant);

  // Equal prices are distinct variants. Their visible labels are required to
  // distinguish Cabin A from Promenade at the shared €398 threshold.
  const selected: TicketVariant[] = [];
  const ambiguous: TicketVariant[] = [];
  const seenIds = new Set<string>();

  for (const variant of matching) {
    if (seenIds.has(variant.id) || !isKnownFourPersonLabel(variant)) {
      ambiguous.push(variant);
      continue;
    }
    seenIds.add(variant.id);
    selected.push(variant);
  }

  return {
    selected,
    ambiguous,
    rejected: [
      ...unavailable,
      ...available.filter((variant) => !isFourPersonVariant(variant)),
    ],
  };
}

export function totalCents(variants: TicketVariant[]): number {
  return variants.reduce((sum, variant) => sum + variant.totalPriceCents, 0);
}
