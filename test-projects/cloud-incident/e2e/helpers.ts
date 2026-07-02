// Boot the full four-service system in-process on ephemeral ports (real HTTP between services).
import { createGateway } from "../services/gateway";
import { createInventory } from "../services/inventory";
import { createOrders } from "../services/orders";
import { createPayments } from "../services/payments";

export function boot() {
  const inventory = createInventory();
  const payments = createPayments();
  const orders = createOrders(inventory.url, payments.url);
  const gateway = createGateway(orders.url);
  return {
    inventory,
    payments,
    orders,
    gateway,
    stop() {
      inventory.server.stop(true);
      payments.server.stop(true);
      orders.server.stop(true);
      gateway.server.stop(true);
    },
  };
}

export async function getJson(url: string) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
}
