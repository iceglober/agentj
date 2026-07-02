// VENDOR CODE — PSP sandbox simulator (vendored, DO NOT MODIFY).
// The vendor's documented behavior: the sandbox intermittently returns transient 503s and clients
// are expected to retry. Flakiness is off unless PSP_SANDBOX_FLAKY=1 (the sandbox's "chaos" mode);
// in chaos mode the FIRST charge attempt for any given order fails with a transient error.
export const PSP_LATENCY_MS = 100;

export class PSPTransientError extends Error {
  constructor() {
    super("PSP sandbox: transient 503 — safe to retry");
  }
}

const seenOrders = new Set<string>();

export async function pspCharge(orderId: string, _amountCents: number): Promise<{ ref: string }> {
  if (process.env.PSP_SANDBOX_FLAKY === "1" && !seenOrders.has(orderId)) {
    seenOrders.add(orderId);
    await new Promise((r) => setTimeout(r, 20));
    throw new PSPTransientError();
  }
  seenOrders.add(orderId);
  await new Promise((r) => setTimeout(r, PSP_LATENCY_MS));
  return { ref: `psp-${orderId}` };
}
