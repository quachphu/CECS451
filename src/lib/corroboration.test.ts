import { describe, expect, it } from "vitest";
import { confirmationStatus } from "@/lib/corroboration";

describe("planner confirmation corroboration", () => {
  it("holds a figure that contradicts a strongly believed capacity by more than 50%", () => {
    expect(confirmationStatus({ max_capacity: 60, capacity_confidence: 0.9, capacity_trust: "verified" }, 600)).toBe(
      "pending"
    );
    expect(confirmationStatus({ max_capacity: 60, capacity_confidence: 0.9, capacity_trust: "verified" }, 25)).toBe(
      "pending"
    );
  });

  it("accepts a figure within 50% of a strongly believed capacity", () => {
    expect(confirmationStatus({ max_capacity: 60, capacity_confidence: 0.9, capacity_trust: "verified" }, 85)).toBe(
      "accepted"
    );
    expect(confirmationStatus({ max_capacity: 60, capacity_confidence: 0.9, capacity_trust: "verified" }, 90)).toBe(
      "accepted"
    );
  });

  it("accepts any figure when the existing capacity is weakly believed", () => {
    expect(confirmationStatus({ max_capacity: 60, capacity_confidence: 0.2, capacity_trust: "unverified" }, 600)).toBe(
      "accepted"
    );
  });

  it("falls back to the tier weight for rows without a stored confidence", () => {
    expect(confirmationStatus({ max_capacity: 60, capacity_confidence: null, capacity_trust: "verified" }, 600)).toBe(
      "pending"
    );
    expect(confirmationStatus({ max_capacity: 60, capacity_confidence: null, capacity_trust: "likely" }, 600)).toBe(
      "accepted"
    );
  });

  it("accepts minimum-spend-only confirmations and missing rooms", () => {
    expect(confirmationStatus({ max_capacity: 60, capacity_confidence: 0.95, capacity_trust: "verified" }, null)).toBe(
      "accepted"
    );
    expect(confirmationStatus(null, 600)).toBe("accepted");
  });
});
