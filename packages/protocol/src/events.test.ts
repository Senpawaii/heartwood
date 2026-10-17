import { describe, expect, it } from "vitest";
import {
  EventValidationError,
  eventTypes,
  type HeartwoodEvent,
  parseEvent,
  validateNewEvent,
} from "./index.js";

const base = {
  seq: 1,
  id: "01J",
  at: "2026-10-17T00:00:00.000Z",
  v: 1,
  actor: { kind: "daemon" },
  correlation: {},
};

describe("event schemas", () => {
  it("round-trips a valid event", () => {
    const e = {
      ...base,
      type: "skill.used",
      payload: {
        soulId: "s1",
        skill: { name: "tdd", digest: "sha256:abc" },
        dispatchId: "d1",
        outcome: "succeeded",
        evidence: "injected",
      },
    };
    expect(parseEvent(e)).toEqual(e);
  });

  it("requires evidence on skill.used", () => {
    const e = {
      ...base,
      type: "skill.used",
      payload: {
        soulId: "s",
        skill: { name: "a", digest: "b" },
        dispatchId: "d",
        outcome: "unknown",
      },
    };
    expect(() => parseEvent(e)).toThrow();
  });

  it("rejects unknown event types and invalid payloads", () => {
    expect(() => parseEvent({ ...base, type: "nope.nope", payload: {} })).toThrow(
      EventValidationError,
    );
    expect(() =>
      parseEvent({
        ...base,
        type: "soul.xp_gained",
        payload: { soulId: "s", amount: -1, reason: "task" },
      }),
    ).toThrow();
  });

  it("does not model heartbeats as events and stores no rank on soul.named", () => {
    expect(eventTypes).not.toContain("orca.heartbeat");
    const e = validateNewEvent({
      type: "soul.named",
      payload: {
        soulId: "s",
        name: "Oakhand",
        species: "dwarf",
        ministryId: "m",
        persona: "p",
        magiculesSpent: 5,
      },
      actor: { kind: "sovereign" },
    });
    expect("rank" in e.payload).toBe(false);
  });

  it("validateNewEvent rejects bad payloads", () => {
    expect(() =>
      validateNewEvent({
        type: "soul.leveled",
        payload: { soulId: "s" } as never,
        actor: { kind: "daemon" },
      }),
    ).toThrow(EventValidationError);
  });

  it("types narrow by event type", () => {
    const e = parseEvent({
      ...base,
      type: "dispatch.settled",
      payload: { dispatchId: "d", outcome: "abandoned" },
    }) as HeartwoodEvent;
    if (e.type === "dispatch.settled") expect(e.payload.outcome).toBe("abandoned");
  });
});
