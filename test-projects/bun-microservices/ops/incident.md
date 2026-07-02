# INC-231 — double charge + stock drift on a single checkout

**Report (from support):** A customer clicked "buy" once for two WIDGET-9 and saw an error page —
but was charged twice, and our stock counter for WIDGET-9 dropped from 5 to 1 even though nothing
shipped twice.

Logs captured from the incident window are in `ops/logs/` (one JSON-lines file per service).
The services' code is in `services/`.
