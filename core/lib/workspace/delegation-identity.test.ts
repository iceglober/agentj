import { describe, expect, test } from "bun:test";
import { createDelegationChildIdFactory, delegationWorktreeRoot } from "./delegation-identity";

describe("delegation worktree identity", () => {
  test("namespaces temporary worktrees by repository identity", () => {
    const one = delegationWorktreeRoot("/tmp", "/repos/one/.git");
    const two = delegationWorktreeRoot("/tmp", "/repos/two/.git");

    expect(one).toMatch(/^\/tmp\/glorious-worktrees\/[0-9a-f]{16}$/);
    expect(one).not.toBe(two);
    expect(delegationWorktreeRoot("/tmp", "/repos/one/.git")).toBe(one);
  });

  test("uses an instance nonce plus counter for collision-proof child ids", () => {
    const first = createDelegationChildIdFactory("0123456789abcdef");
    const second = createDelegationChildIdFactory("fedcba9876543210");

    expect(first("t1")).toBe("job-0123456789abcdef-0001-t1");
    expect(first("t1")).toBe("job-0123456789abcdef-0002-t1");
    expect(second("t1")).toBe("job-fedcba9876543210-0001-t1");
  });

  test("keeps generated ids valid and bounded", () => {
    const id = createDelegationChildIdFactory("0123456789abcdef")("Task / with * punctuation");

    expect(id).toBe("job-0123456789abcdef-0001-task-with-punctuation");
    expect(id.length).toBeLessThanOrEqual(64);
  });
});
