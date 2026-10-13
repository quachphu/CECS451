import { describe, expect, it } from "vitest";
import { START_ERRORS, startErrorMessage } from "@/lib/start-errors";

describe("start page error codes", () => {
  it("maps known codes to their message", () => {
    expect(startErrorMessage("code-not-found")).toBe(START_ERRORS["code-not-found"]);
  });

  it("shows nothing for unknown or crafted values, so a link can't inject text", () => {
    expect(startErrorMessage("Your account is locked, call 555-0100")).toBeNull();
    expect(startErrorMessage("__proto__")).toBeNull();
    expect(startErrorMessage(undefined)).toBeNull();
  });
});
