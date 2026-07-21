import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import tasks from "./baseline";

const fingerprints: Record<string, string> = {
  "clinic-next-steps@1": "2ccb9f2e11eb",
  "clinic-punchlist@1": "b672d6c99473",
  "clinic-ticket-mfa-copy@1": "d0d2834ff948",
  "ops-digest@1": "6cbc722c55bd",
  "ops-parallel@1": "c2005cf27f2b",
  "ops-release@1": "6a55e8c7dbec",
  "ops-seed-sandbox@1": "fd09c678575d",
  "py-fix-pricing@1": "c75ebdca133b",
};

test("frozen eval task contracts change only with an explicit fingerprint update", () => {
  const actual = Object.fromEntries(
    tasks.map((task) => [
      `${task.id}@${task.version}`,
      createHash("sha256").update(JSON.stringify(task)).digest("hex").slice(0, 12),
    ]),
  );
  expect(actual).toEqual(fingerprints);
});
