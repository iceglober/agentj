# AGENTS.md — cloud-incident

A four-service commerce system (pure Bun, no dependencies): gateway → orders → { inventory, payments }
over real HTTP.

- `services/gateway.ts` — public `POST /checkout`; forwards to orders with a hard upstream timeout
  and one retry.
- `services/orders.ts` — reserves stock with inventory, charges through payments under a hard
  deadline, releases the reservation on any payment failure.
- `services/payments.ts` — charges cards through a bounded PSP connection pool and tracks auth
  holds (one hold per order, ever — a duplicate charge must return the existing hold).
- `services/inventory.ts` — stock + reservations.
- `e2e/` — cross-service tests booting the whole system in-process: `bun test e2e`.

**Production observability** is queried through the cloud CLI at `./ops/cloudctl` — logs (grouped,
time-filtered), deploy history, config history, and metrics. Start with `./ops/cloudctl help`.
Incident context lives in `ops/INC-407.md`.
