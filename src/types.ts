export type TicketVariant = {
  id: string;
  name: string;
  totalPriceCents: number;
  available: boolean;
  stock: number | null;
  maxQuantity: number | null;
};

export type SelectionResult = {
  selected: TicketVariant[];
  ambiguous: TicketVariant[];
  rejected: TicketVariant[];
};

export type AutomationOutput = {
  selected_variant_ids: string[];
  selected_names: string[];
  selected_prices: number[];
  total_before_fees: number;
  ambiguous_variant_ids: string[];
  reason: string;
};

export type DomVariantState = {
  name: string;
  disabled: boolean;
  reserved: boolean;
  text: string;
};

export type ProductInspection = {
  variants: TicketVariant[];
  domVariants: DomVariantState[];
  saleCountdownText: string | null;
  eventTitle: string | null;
};
