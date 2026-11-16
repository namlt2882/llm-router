import { describe, expect, it } from "vitest";
import { withKeylessAccountName } from "../../src/shared/utils/keylessAccountLabel.js";

const free = { opencode: { noAuth: true }, kiro: {} };

describe("withKeylessAccountName", () => {
  it("renames the keyless lane that the server could only call 'Account opencode...'", () => {
    const out = withKeylessAccountName({ connectionId: "opencode", accountName: "Account opencode..." }, free);
    expect(out.accountName).toBe("opencode (miễn phí)");
  });
  it("leaves a real connection name alone", () => {
    const item = { connectionId: "opencode", accountName: "my-key" };
    expect(withKeylessAccountName(item, free)).toBe(item);
  });
  it("leaves a provider that is not keyless alone", () => {
    const item = { connectionId: "kiro", accountName: "Account kiro..." };
    expect(withKeylessAccountName(item, free)).toBe(item);
  });
  it("tolerates a missing connection id", () => {
    const item = { accountName: "Account undefined..." };
    expect(withKeylessAccountName(item, free)).toBe(item);
  });
});
