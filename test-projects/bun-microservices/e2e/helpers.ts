// Boot the full three-service system in-process on ephemeral ports (real HTTP between services),
// so e2e tests are hermetic, parallel-safe, and leave no orphan processes.
import { createGateway } from "../services/gateway";
import { createInventory } from "../services/inventory";
import { createOrders } from "../services/orders";

export function boot() {
  const inventory = createInventory();
  const orders = createOrders(inventory.url);
  const gateway = createGateway(orders.url);
  return {
    inventory,
    orders,
    gateway,
    stop() {
      inventory.server.stop(true);
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
