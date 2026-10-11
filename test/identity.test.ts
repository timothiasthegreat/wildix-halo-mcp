import { describe, expect, it } from "vitest";
import {
  allSamePerson,
  companyMatches,
  nameMatches,
  normalizePhone,
  signToken,
  verifyToken,
} from "../src/identity.js";

describe("normalizePhone", () => {
  it.each([
    ["(604) 555-1234", "16045551234"],
    ["604.555.1234", "16045551234"],
    ["+1 604 555 1234", "16045551234"],
    ["1-604-555-1234", "16045551234"],
    ["011 44 20 7946 0958", "442079460958"],
    ["+44 20 7946 0958", "442079460958"],
    ["604-555-1234 x22", "16045551234"],
    ["604-555-1234 ext. 22", "16045551234"],
    [6045551234, "16045551234"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePhone(input, "1")).toBe(expected);
  });

  it("rejects junk", () => {
    expect(normalizePhone("123", "1")).toBe("");
    expect(normalizePhone(undefined, "1")).toBe("");
    expect(normalizePhone("anonymous", "1")).toBe("");
  });
});

describe("nameMatches", () => {
  const user = { id: 1, firstname: "Michael", surname: "O'Brien" };
  it("matches exact and nickname forms", () => {
    expect(nameMatches("Michael O'Brien", user)).toBe(true);
    expect(nameMatches("mike obrien", user)).toBe(true);
    expect(nameMatches("Mike O Brien", user)).toBe(true);
  });
  it("tolerates small transcription errors", () => {
    expect(nameMatches("Micheal O'Brian", user)).toBe(true);
  });
  it("requires a surname and rejects other people", () => {
    expect(nameMatches("Michael", user)).toBe(false);
    expect(nameMatches("Michael Smith", user)).toBe(false);
    expect(nameMatches("Sarah O'Brien", user)).toBe(false);
  });
  it("falls back to the name field", () => {
    expect(nameMatches("Jose Garcia", { id: 2, name: "José García" })).toBe(true);
  });
});

describe("companyMatches", () => {
  it("ignores suffixes and case", () => {
    expect(companyMatches("acme", "ACME Widgets Inc.")).toBe(true);
    expect(companyMatches("Acme Widgets", "Acme Widgets Ltd")).toBe(true);
    expect(companyMatches("FIP", "Fireside IT Partners")).toBe(true);
  });
  it("rejects different companies", () => {
    expect(companyMatches("Globex", "Acme Widgets Inc.")).toBe(false);
    expect(companyMatches("Inc", "Acme Inc")).toBe(false);
  });
});

describe("allSamePerson", () => {
  it("treats nickname variants as one person and different names as different people", () => {
    const mike = { id: 1, firstname: "Michael", surname: "Smith" };
    expect(allSamePerson([mike, { id: 2, firstname: "Mike", surname: "Smith" }])).toBe(true);
    expect(allSamePerson([mike, { id: 3, firstname: "Sarah", surname: "Jones" }])).toBe(false);
    expect(allSamePerson([mike])).toBe(true);
  });
});

describe("tokens", () => {
  const secret = "x".repeat(40);
  const ident = { ids: [{ u: 5, c: 7, s: 9, cn: "Acme" }, { u: 6, c: 8, cn: "Globex" }], m: "phone" as const, fn: "Mike" };

  it("round-trips", () => {
    const t = signToken(ident, secret, 60);
    expect(verifyToken(t, secret)).toMatchObject(ident);
  });
  it("rejects tampering, wrong secret and expiry", () => {
    const t = signToken(ident, secret, 60);
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...ident, ids: [{ u: 99, c: 99, cn: "x" }], exp: 9e9 })).toString("base64url");
    expect(() => verifyToken(`${forged}.${sig}`, secret)).toThrow();
    expect(() => verifyToken(`${body}.${sig}`, "y".repeat(40))).toThrow();
    expect(() => verifyToken(t, secret, Math.floor(Date.now() / 1000) + 3601)).toThrow(/expired/);
    expect(() => verifyToken("garbage", secret)).toThrow();
  });
});
