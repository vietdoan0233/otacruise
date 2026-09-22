import assert from "node:assert/strict";
import test from "node:test";
import { isFourPersonVariant, selectFourPersonVariants, totalCents } from "../src/selector.js";

const variants = [
  { id: "c2", name: "Cabin C, 2 pers.", totalPriceCents: 21600, available: true, stock: null, maxQuantity: 1 },
  { id: "c4", name: "Cabin C, 4 pers.", totalPriceCents: 36600, available: true, stock: null, maxQuantity: 1 },
  { id: "b4", name: "Cabin B, 4 pers.", totalPriceCents: 38600, available: true, stock: null, maxQuantity: 1 },
  { id: "p4", name: "Prom., 4 pers.", totalPriceCents: 39800, available: true, stock: null, maxQuantity: 1 },
  { id: "a4", name: "Cabin A, 4 pers.", totalPriceCents: 39800, available: true, stock: null, maxQuantity: 1 },
];

test("recognizes exact four-person price thresholds", () => {
  assert.equal(isFourPersonVariant(variants[1]), true);
  assert.equal(isFourPersonVariant(variants[0]), false);
});

test("selects all available four-person variants", () => {
  const result = selectFourPersonVariants(variants);
  assert.deepEqual(result.selected.map((variant) => variant.id), ["c4", "b4", "p4", "a4"]);
  assert.deepEqual(result.rejected.map((variant) => variant.id), ["c2"]);
  assert.equal(totalCents(result.selected), 154800);
});

test("does not guess when a threshold has an unknown visible label", () => {
  const result = selectFourPersonVariants([
    {
      id: "unknown",
      name: "Unknown cabin, 4 pers.",
      totalPriceCents: 39800,
      available: true,
      stock: null,
      maxQuantity: 1,
    },
  ]);

  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.ambiguous.map((variant) => variant.id), ["unknown"]);
});

test("fails closed when a known four-person label is duplicated", () => {
  const result = selectFourPersonVariants([
    {
      id: "a4-1",
      name: "Cabin A, 4 pers.",
      totalPriceCents: 39800,
      available: true,
      stock: null,
      maxQuantity: 1,
    },
    {
      id: "a4-2",
      name: "Cabin A, 4 pers.",
      totalPriceCents: 39800,
      available: true,
      stock: null,
      maxQuantity: 1,
    },
  ]);

  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.ambiguous.map((variant) => variant.id), ["a4-1", "a4-2"]);
});
