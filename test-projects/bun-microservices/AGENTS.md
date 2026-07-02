# AGENTS.md — bun-microservices

A three-service toy commerce system (pure Bun, no dependencies): gateway → orders → inventory over
real HTTP.

- `services/gateway.ts` — public `POST /checkout`; forwards to orders with a hard upstream timeout
  and one retry.
- `services/orders.ts` — `POST /orders`: reserves stock with inventory, then charges payment; a
  declined payment releases the reservation.
- `services/inventory.ts` — stock + reservations: `POST /reserve`, `POST /release`,
  `GET /stock/:sku`.
- `lib/` — shared structured JSON logger and a tiny HTTP client with timeouts. Every service also
  serves its recent log lines at `GET /__logs`.
- `e2e/` — cross-service tests that boot all three services in-process on ephemeral ports.
- `ops/logs/` — captured production logs from incident INC-231 (context in `ops/incident.md`).

Run the tests from this directory: `bun test e2e`
