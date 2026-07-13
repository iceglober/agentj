/**
 * The pricing-package fixture, ported byte-identically from
 * core/lib/tools/edit/benchmarks/ab-edit.ts. A 4-module Python package plus its
 * test suite: `BUGGY_FILES` is the 8-bug version, `CORRECT_FILES` is the fully
 * fixed version (the benchmark's FIXED map merged over FILES). tests.py is the
 * same in both. Keep these strings identical to ab-edit's constants.
 */

const UTILS_PY = `"""Shared helpers."""

import re
from decimal import Decimal, ROUND_HALF_UP

SKU_RE = re.compile(r"^[A-Z]{3}-\\d{4}$")


def validate_sku(sku):
    if not SKU_RE.match(sku):
        raise ValueError(f"bad sku: {sku}")
    return sku


def round_money(value):
    """Round to cents, half away from zero."""
    return round(value, 2)


def fmt_money(value):
    return f"\${round_money(value):.2f}"
`;

const MODELS_PY = `"""Catalog and inventory."""

from utils import validate_sku


class Item:
    def __init__(self, sku, name, price):
        self.sku = validate_sku(sku)
        self.name = name
        self.price = price

    def __repr__(self):
        return f"Item({self.sku!r}, {self.name!r}, {self.price!r})"


class Inventory:
    def __init__(self, stock=None):
        self.stock = dict(stock or {})

    def restock(self, sku, qty):
        self.stock[sku] = self.stock.get(sku, 0) + qty

    def available(self, sku):
        return self.stock.get(sku, 0)

    def reserve(self, sku, qty):
        """Reserve qty units; return True on success."""
        if self.stock.get(sku, 0) > qty:
            self.stock[sku] -= qty
            return True
        return False
`;

const PRICING_PY = `"""Price adjustment helpers."""

import utils


def apply_discount(price, rate):
    """Discounted price: rate 0.2 -> 20% off."""
    if rate < 0 or rate > 1:
        raise ValueError("rate out of range")
    return price * (1 - rate)


def apply_surcharge(price, rate):
    """Surcharged price: rate 0.2 -> 20% extra."""
    if rate < 0 or rate > 1:
        raise ValueError("rate out of range")
    return price * (1 - rate)


def apply_tax(price, rate):
    """Price with sales tax applied."""
    if rate < 0 or rate > 1:
        raise ValueError("rate out of range")
    return price * (1 - rate)


def bulk_discount_rate(qty):
    if qty >= 50:
        return 0.15
    if qty >= 20:
        return 0.10
    if qty > 10:
        return 0.05
    return 0.0


def line_total(item, qty):
    rate = bulk_discount_rate(qty)
    return utils.round_money(item.price * qty * (1 - rate))
`;

const CART_PY = `"""Shopping cart built on pricing and inventory."""

import pricing
import utils


class Cart:
    def __init__(self, inventory):
        self.inventory = inventory
        self.lines = []

    def add(self, item, qty):
        if qty < 0:
            raise ValueError("qty must be positive")
        if not self.inventory.reserve(item.sku, qty):
            raise ValueError(f"insufficient stock for {item.sku}")
        self.lines.append((item, qty))

    def total(self):
        subtotal = 0.0
        for item, qty in self.lines[:-1]:
            subtotal += pricing.line_total(item, qty)
        return utils.round_money(subtotal)

    def receipt(self):
        parts = [f"{item.name} x{qty}" for item, qty in self.lines]
        parts.append(utils.format_money(self.total()))
        return "\\n".join(parts)
`;

const TESTS_PY = `import sys

import cart as cart_mod
import pricing
import utils
from models import Inventory, Item

failures = []


def run(name, fn, want):
    try:
        got = fn()
    except Exception as e:
        failures.append(f"FAIL {name}: raised {type(e).__name__}: {e}")
        return
    ok = got == want or (
        isinstance(got, float) and isinstance(want, float) and abs(got - want) < 1e-9
    )
    if not ok:
        failures.append(f"FAIL {name}: got {got!r}, want {want!r}")


def raises(name, fn, exc):
    try:
        fn()
    except exc:
        return
    except Exception as e:
        failures.append(f"FAIL {name}: raised {type(e).__name__}, want {exc.__name__}")
        return
    failures.append(f"FAIL {name}: no exception, want {exc.__name__}")


run("round_money_half_up", lambda: utils.round_money(2.675), 2.68)
run("round_money_down", lambda: utils.round_money(2.664), 2.66)
run("discount", lambda: pricing.apply_discount(100, 0.2), 80.0)
run("surcharge", lambda: pricing.apply_surcharge(100, 0.2), 120.0)
run("tax", lambda: pricing.apply_tax(100, 0.08), 108.0)
run("bulk_rate_none", lambda: pricing.bulk_discount_rate(5), 0.0)
run("bulk_rate_10", lambda: pricing.bulk_discount_rate(10), 0.05)
run("bulk_rate_20", lambda: pricing.bulk_discount_rate(20), 0.10)
run("bulk_rate_50", lambda: pricing.bulk_discount_rate(50), 0.15)

widget = Item("AAA-0001", "widget", 2.50)
gadget = Item("BBB-0002", "gadget", 10.00)
gizmo = Item("CCC-0003", "gizmo", 0.99)

run("line_total_bulk", lambda: pricing.line_total(widget, 10), 23.75)


def reserve_exact():
    inv = Inventory({"AAA-0001": 5})
    ok = inv.reserve("AAA-0001", 5)
    return (ok, inv.available("AAA-0001"))


run("reserve_exact", reserve_exact, (True, 0))


def reserve_too_many():
    inv = Inventory({"AAA-0001": 5})
    return inv.reserve("AAA-0001", 6)


run("reserve_too_many", reserve_too_many, False)


def make_cart():
    inv = Inventory({"AAA-0001": 10, "BBB-0002": 10, "CCC-0003": 10})
    c = cart_mod.Cart(inv)
    c.add(widget, 2)
    c.add(gadget, 1)
    c.add(gizmo, 3)
    return c


raises("add_zero_qty", lambda: make_cart().add(widget, 0), ValueError)
run("cart_total", lambda: make_cart().total(), 17.97)
run("receipt", lambda: "$17.97" in make_cart().receipt(), True)

if failures:
    print("\\n".join(failures))
    sys.exit(1)
print("ALL TESTS PASSED")
`;

/** Path key for the frozen test suite; graders reset it so edits can't game it. */
export const TESTS_PY_PATH = "tests.py";

/** The buggy 8-defect package (ab-edit's FILES). */
export const BUGGY_FILES: Record<string, string> = {
  "utils.py": UTILS_PY,
  "models.py": MODELS_PY,
  "pricing.py": PRICING_PY,
  "cart.py": CART_PY,
  [TESTS_PY_PATH]: TESTS_PY,
};

/** The fully correct package (ab-edit's FIXED merged over FILES). */
export const CORRECT_FILES: Record<string, string> = {
  ...BUGGY_FILES,
  "utils.py": UTILS_PY.replace(
    "    return round(value, 2)",
    '    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))',
  ),
  "models.py": MODELS_PY.replace(
    "if self.stock.get(sku, 0) > qty:",
    "if self.stock.get(sku, 0) >= qty:",
  ),
  "pricing.py": PRICING_PY.replace(
    '"""Surcharged price: rate 0.2 -> 20% extra."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 - rate)',
    '"""Surcharged price: rate 0.2 -> 20% extra."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 + rate)',
  )
    .replace(
      '"""Price with sales tax applied."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 - rate)',
      '"""Price with sales tax applied."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 + rate)',
    )
    .replace("if qty > 10:", "if qty >= 10:"),
  "cart.py": CART_PY.replace("if qty < 0:", "if qty <= 0:")
    .replace("for item, qty in self.lines[:-1]:", "for item, qty in self.lines:")
    .replace("utils.format_money(", "utils.fmt_money("),
};

/** ab-edit's PROMPT verbatim: the omnibus fix-all-bugs task. */
export const OMNIBUS_PROMPT =
  "The directory /workspace contains a small Python package (models.py, pricing.py, cart.py, utils.py) " +
  "and its test suite tests.py. Run `python3 tests.py` to see what fails, then fix the bugs in the " +
  "source files so all tests pass, and re-run the tests to confirm. " +
  "Rules: modify source files only via the edit tool — never rewrite whole files and never write to them " +
  "with shell redirection or heredocs. Do not modify tests.py.";
