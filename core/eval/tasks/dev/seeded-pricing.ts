import type { Task } from "../../../lib/eval/types";
import { CORRECT_FILES } from "../../fixtures/pricing";
import { type Defect, seededDefects } from "../../sources/seeded-defect";

/**
 * Single-bug variants of the pricing package: each starts from the fully
 * correct map and re-injects one of ab-edit's real defects, so exactly one test
 * fails. The find-strings below are asserted present in CORRECT_FILES at load.
 */
const DEFECTS: Defect[] = [
  {
    id: "round-money",
    file: "utils.py",
    find: '    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))',
    replace: "    return round(value, 2)",
    note: "float round() drops half-up rounding",
  },
  {
    id: "reserve-boundary",
    file: "models.py",
    find: "if self.stock.get(sku, 0) >= qty:",
    replace: "if self.stock.get(sku, 0) > qty:",
    note: "off-by-one: exact-stock reserve fails",
  },
  {
    id: "surcharge-sign",
    file: "pricing.py",
    find: '"""Surcharged price: rate 0.2 -> 20% extra."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 + rate)',
    replace:
      '"""Surcharged price: rate 0.2 -> 20% extra."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 - rate)',
    note: "surcharge subtracts instead of adds",
  },
  {
    id: "bulk-boundary",
    file: "pricing.py",
    find: "if qty >= 10:",
    replace: "if qty > 10:",
    note: "qty==10 falls through to no discount",
  },
  {
    id: "cart-qty-guard",
    file: "cart.py",
    find: "if qty <= 0:",
    replace: "if qty < 0:",
    note: "zero-qty line is no longer rejected",
  },
  {
    id: "cart-total-floor",
    file: "cart.py",
    find: "for item, qty in self.lines:",
    replace: "for item, qty in self.lines[:-1]:",
    note: "total() drops the last line",
  },
];

const PROMPT =
  "The test suite in tests.py is failing. Find the bug and fix it. Do not modify tests.py.";

const tasks: Task[] = seededDefects({
  idPrefix: "seeded-pricing",
  base: CORRECT_FILES,
  prompt: PROMPT,
  defects: DEFECTS,
  tags: ["ambiguity:explicit"],
});

export default tasks;
