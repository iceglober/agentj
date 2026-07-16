import type { Defect } from "../sources/seeded-defect";

/**
 * The ops fixture: a small TypeScript repo (run with bun, which the sandbox
 * bootstrap installs) whose "external systems" are local mocks that record
 * side effects into files — a release pipeline that appends to an audit log,
 * a tenant store as JSON files per environment, and digest source data. Ops
 * requests ("/release staging and production", "seed sandbox like dev",
 * "create the next weekly digest") become gradeable: checks observe the
 * recorded state, and reference.command proves each task solvable.
 *
 * Fixture code deliberately avoids template literals so these TS sources can
 * live inside template literals here without escaping games.
 */

const DIGEST_TS = `export interface Entry {
  date: string;
  category: string;
  title: string;
}

const DAY_MS = 86_400_000;

const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(iso + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);

export function buildDigest(entries: Entry[], weekStart: string): string {
  const weekEnd = addDays(weekStart, 7); // exclusive: the week is [start, start+7)
  const inWeek = entries.filter((e) => e.date >= weekStart && e.date < weekEnd);
  const lines = ["# Week of " + weekStart, ""];
  for (const category of [...new Set(inWeek.map((e) => e.category))].sort()) {
    lines.push("## " + category);
    for (const e of inWeek.filter((x) => x.category === category)) {
      lines.push("- " + e.title + " (" + e.date + ")");
    }
    lines.push("");
  }
  return lines.join("\\n");
}
`;

const SEED_TS = `export interface Tenant {
  name: string;
  plan: string;
  records: { id: string; kind: string }[];
}

export interface Db {
  tenants: Record<string, Tenant>;
}

const STARTER_RECORDS = ["profile", "billing", "welcome"];

export function seedTenant(db: Db, name: string): Db {
  if (db.tenants[name]) return db;
  const records = STARTER_RECORDS.map((kind, index) => ({
    id: name + "-" + (index + 1),
    kind,
  }));
  return { ...db, tenants: { ...db.tenants, [name]: { name, plan: "standard", records } } };
}
`;

const NOTIFY_TS = `export function formatReminder(name: string, dueDate: string): string {
  return "Reminder for " + name + ": due " + dueDate;
}
`;

const SEED_CLI_TS = `import { seedTenant } from "../src/seed";

const [env, tenant] = process.argv.slice(2);
if (!env || !tenant) {
  console.error("usage: bun bin/seed.ts <env> <tenant>");
  process.exit(2);
}
const path = "data/" + env + ".json";
const db = await Bun.file(path).json();
await Bun.write(path, JSON.stringify(seedTenant(db, tenant), null, 2) + "\\n");
console.log("seeded " + tenant + " into " + env);
`;

const RELEASE_SH = `#!/bin/sh
# Mock of the external release pipeline: validates the target, refuses to ship
# on red tests, and records the release in .release-log for audit.
set -e
ENV="$1"
case "$ENV" in
  staging|production|sandbox) ;;
  *) echo "usage: sh bin/release <staging|production|sandbox>" >&2; exit 2 ;;
esac
bun tests.ts >/dev/null 2>&1 || { echo "refusing to release: tests failing" >&2; exit 1; }
echo "released $ENV" >> .release-log
echo "released $ENV"
`;

const TESTS_TS = `import { buildDigest } from "./src/digest";
import { formatReminder } from "./src/notify";
import { seedTenant } from "./src/seed";

const failures: string[] = [];
const check = (name: string, cond: boolean) => {
  if (!cond) failures.push(name);
};

// Digest: the week is [start, start+7) — the final day belongs to the week.
const entries = [
  { date: "2026-07-13", category: "product", title: "Alpha" },
  { date: "2026-07-19", category: "ops", title: "Bravo" },
  { date: "2026-07-20", category: "ops", title: "Charlie" },
];
const digest = buildDigest(entries, "2026-07-13");
check("digest is titled by week start", digest.includes("Week of 2026-07-13"));
check("digest includes the week start day", digest.includes("Alpha"));
check("digest includes the final day of the week", digest.includes("Bravo"));
check("digest excludes the next week", !digest.includes("Charlie"));

// Seeding: standard shape, safe to re-run.
const db = { tenants: {} };
const once = seedTenant(db, "T");
const twice = seedTenant(once, "T");
check("seeded tenant gets the standard plan", once.tenants["T"]?.plan === "standard");
check("seeded tenant gets 3 starter records", once.tenants["T"]?.records.length === 3);
check("re-seeding is idempotent", twice.tenants["T"]?.records.length === 3);

// Notifications.
check(
  "reminder format",
  formatReminder("Dana", "2026-08-01") === "Reminder for Dana: due 2026-08-01",
);

if (failures.length > 0) {
  console.log("FAILED: " + failures.join("; "));
  process.exit(1);
}
console.log("OK");
`;

const RELEASE_MD = `# Release runbook

1. Ensure tests pass: \`bun tests.ts\`
2. Release to an environment: \`sh bin/release <staging|production|sandbox>\`
3. Releases are recorded in \`.release-log\` for audit.

Always release staging before production.
`;

const PREVIOUS_DIGEST_MD = `# Week of 2026-07-06

## product
- Payer mapping editor shipped (2026-07-08)
`;

const NEXT_DIGEST_MD = `# Week of 2026-07-13

## ops
- Sandbox environment refreshed (2026-07-16)
- Rotated portal credentials (2026-07-19)

## product
- Bulk claim export beta (2026-07-13)
`;

const ENTRIES_JSON = `[
  { "date": "2026-07-08", "category": "product", "title": "Payer mapping editor shipped" },
  { "date": "2026-07-13", "category": "product", "title": "Bulk claim export beta" },
  { "date": "2026-07-16", "category": "ops", "title": "Sandbox environment refreshed" },
  { "date": "2026-07-19", "category": "ops", "title": "Rotated portal credentials" },
  { "date": "2026-07-21", "category": "product", "title": "Assistant labels finalized" }
]
`;

const DEV_JSON = `{
  "tenants": {
    "Acme Dental": {
      "name": "Acme Dental",
      "plan": "standard",
      "records": [
        { "id": "Acme Dental-1", "kind": "profile" },
        { "id": "Acme Dental-2", "kind": "billing" },
        { "id": "Acme Dental-3", "kind": "welcome" }
      ]
    }
  }
}
`;

const SANDBOX_JSON = `{
  "tenants": {}
}
`;

export const CORRECT_FILES: Record<string, string> = {
  "src/digest.ts": DIGEST_TS,
  "src/seed.ts": SEED_TS,
  "src/notify.ts": NOTIFY_TS,
  "bin/seed.ts": SEED_CLI_TS,
  "bin/release": RELEASE_SH,
  "tests.ts": TESTS_TS,
  "docs/release.md": RELEASE_MD,
  "docs/digests/2026-07-06.md": PREVIOUS_DIGEST_MD,
  "data/entries.json": ENTRIES_JSON,
  "data/dev.json": DEV_JSON,
  "data/sandbox.json": SANDBOX_JSON,
};

/** The digest an agent should produce for the week after the last one on file. */
export const REFERENCE_NEXT_DIGEST = NEXT_DIGEST_MD;

export const OPS_DEFECTS = {
  digestBoundary: {
    id: "digest-boundary",
    file: "src/digest.ts",
    find: "  const weekEnd = addDays(weekStart, 7); // exclusive: the week is [start, start+7)",
    replace: "  const weekEnd = addDays(weekStart, 6);",
    note: "week end off by one: the final day is dropped",
    prompt:
      "Anything dated on the last day of a week keeps missing from our weekly digests — " +
      "the other six days show up fine. Fix it.",
  },
  seedDupes: {
    id: "seed-dupes",
    file: "src/seed.ts",
    find:
      "  if (db.tenants[name]) return db;\n" +
      "  const records = STARTER_RECORDS.map((kind, index) => ({\n" +
      '    id: name + "-" + (index + 1),\n' +
      "    kind,\n" +
      "  }));",
    replace:
      "  const records = [\n" +
      "    ...(db.tenants[name]?.records ?? []),\n" +
      "    ...STARTER_RECORDS.map((kind, index) => ({\n" +
      '      id: name + "-" + (index + 1),\n' +
      "      kind,\n" +
      "    })),\n" +
      "  ];",
    note: "idempotency guard removed; re-seeding duplicates records",
    prompt:
      "If someone runs seeding twice for the same tenant, the tenant's starter records get " +
      "duplicated. Seeding must be safe to re-run.",
  },
  reminderFormat: {
    id: "reminder-format",
    file: "src/notify.ts",
    find: 'return "Reminder for " + name + ": due " + dueDate;',
    replace: 'return "Reminder for " + dueDate + ": due " + name;',
    note: "name and due date swapped",
    prompt:
      "Reminder notifications are coming out backwards — the date is where the person's " +
      "name should be and vice versa.",
  },
} satisfies Record<string, Defect>;
