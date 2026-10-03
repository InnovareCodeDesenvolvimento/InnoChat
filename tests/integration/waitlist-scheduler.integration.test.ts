/**
 * Agendador da lista de espera no próprio processo (5 em 5 minutos): liga uma vez só, a passada nunca lança e não roda
 * duas ao mesmo tempo (trava no banco).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const tick = vi.hoisted(() => ({ calls: 0, delayMs: 0 }));
vi.mock("@/modules/waitlist/respond", () => ({
  runWaitlistTick: async () => {
    tick.calls += 1;
    if (tick.delayMs) await new Promise((r) => setTimeout(r, tick.delayMs));
    return { offersExpired: 0, acceptedRecovered: 0, pastEntriesExpired: 0, windowOffers: 0 };
  },
}));

import { runWaitlistSchedulerPass, startWaitlistScheduler } from "@/modules/waitlist/scheduler";

afterEach(() => {
  tick.calls = 0;
  tick.delayMs = 0;
  const g = globalThis as { __innochatWaitlistTimer__?: NodeJS.Timeout };
  if (g.__innochatWaitlistTimer__) clearInterval(g.__innochatWaitlistTimer__);
  delete g.__innochatWaitlistTimer__;
});

describe("agendador da lista de espera", () => {
  it("liga o timer uma vez só por processo", () => {
    const first = startWaitlistScheduler(60_000);
    const second = startWaitlistScheduler(60_000);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("duas passadas ao mesmo tempo: só uma roda a lista (trava no banco)", async () => {
    tick.delayMs = 300;
    await Promise.all([runWaitlistSchedulerPass(), runWaitlistSchedulerPass()]);
    expect(tick.calls).toBe(1);
  });

  it("a passada nunca lança, nem se a lista falhar", async () => {
    const respond = await import("@/modules/waitlist/respond");
    vi.spyOn(respond, "runWaitlistTick").mockRejectedValueOnce(new Error("banco fora"));
    await expect(runWaitlistSchedulerPass()).resolves.toBeUndefined();
  });
});
