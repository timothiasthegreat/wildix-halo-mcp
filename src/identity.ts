import { createHmac, timingSafeEqual } from "node:crypto";
import type { HaloUser } from "./halo/types.js";

// ---------- Phone numbers ----------

/**
 * Canonicalise a phone number to digits including the country code.
 * Handles "+1 (604) 555-1234 x22", "001...", "011...", national trunk "0" prefixes.
 * Returns "" when there aren't enough digits to be a real number.
 */
export function normalizePhone(raw: string | number | undefined | null, defaultCountryCode = "1"): string {
  if (raw === undefined || raw === null) return "";
  let s = String(raw).toLowerCase();
  s = s.split(/\s*(?:x|ext\.?|extension|#)\s*\d*$/)[0] ?? s; // drop extensions
  const hadPlus = s.trim().startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (!hadPlus) {
    if (digits.startsWith("011")) digits = digits.slice(3);
    else if (digits.startsWith("00")) digits = digits.slice(2);
    else if (defaultCountryCode === "1" && digits.length === 11 && digits.startsWith("1")) {
      // already NANP with country code
    } else if (digits.length <= 10) {
      digits = defaultCountryCode + digits.replace(/^0/, "");
    }
  }
  return digits.length >= 8 ? digits : "";
}

export function userPhoneNumbers(u: HaloUser, cc: string): string[] {
  const raw = [
    u.phonenumber,
    u.phonenumber_preferred,
    u.mobilenumber,
    u.mobilenumber2,
    u.homenumber,
    u.phonenumberint,
    u.mobileint,
    u.mobilenumber2int,
    u.homenumberint,
  ];
  return [...new Set(raw.map((r) => normalizePhone(r, cc)).filter(Boolean))];
}

export function hasPhoneFields(u: HaloUser): boolean {
  return [u.phonenumber, u.mobilenumber, u.mobilenumber2, u.homenumber, u.phonenumberint, u.mobileint].some(
    (v) => v !== undefined,
  );
}

// ---------- Names / companies ----------

export function normalizeText(s: string | undefined | null): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Edit distance counting adjacent transpositions as one edit (optimal string alignment). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

const NICKNAMES: string[][] = [
  ["robert", "rob", "bob", "bobby", "robbie"],
  ["william", "will", "bill", "billy", "liam"],
  ["michael", "mike", "mick", "mikey"],
  ["james", "jim", "jimmy", "jamie"],
  ["richard", "rick", "rich", "dick", "ricky"],
  ["thomas", "tom", "tommy"],
  ["timothy", "tim", "timmy"],
  ["christopher", "chris", "topher"],
  ["christine", "chris", "christina", "tina"],
  ["elizabeth", "liz", "beth", "betty", "eliza", "lisa", "libby"],
  ["katherine", "kathryn", "catherine", "kate", "katie", "kathy", "cathy", "kat"],
  ["margaret", "maggie", "meg", "peggy"],
  ["jennifer", "jen", "jenny"],
  ["anthony", "tony"],
  ["joseph", "joe", "joey"],
  ["daniel", "dan", "danny"],
  ["david", "dave", "davey"],
  ["matthew", "matt"],
  ["andrew", "andy", "drew"],
  ["alexander", "alex", "sasha"],
  ["alexandra", "alex", "alexa", "sandra"],
  ["nicholas", "nick", "nicky"],
  ["stephen", "steven", "steve"],
  ["jonathan", "jon", "john", "johnny"],
  ["edward", "ed", "eddie", "ted", "ned"],
  ["benjamin", "ben", "benny"],
  ["samuel", "sam", "sammy"],
  ["samantha", "sam", "sammy"],
  ["patricia", "pat", "patty", "trish"],
  ["patrick", "pat", "paddy"],
  ["gregory", "greg"],
  ["jeffrey", "geoffrey", "jeff", "geoff"],
  ["kenneth", "ken", "kenny"],
  ["ronald", "ron", "ronnie"],
  ["donald", "don", "donnie"],
  ["douglas", "doug"],
  ["susan", "sue", "suzy"],
  ["deborah", "debra", "deb", "debbie"],
  ["rebecca", "becky", "becca"],
  ["victoria", "vicky", "tori"],
  ["abigail", "abby"],
  ["frederick", "fred", "freddie"],
  ["lawrence", "larry"],
  ["gerald", "gerry", "jerry"],
];

function nicknameEquivalent(a: string, b: string): boolean {
  return NICKNAMES.some((group) => group.includes(a) && group.includes(b));
}

function firstNameMatches(stated: string, actual: string): boolean {
  if (!stated || !actual) return false;
  if (stated === actual) return true;
  if (nicknameEquivalent(stated, actual)) return true;
  if (stated.length >= 3 && actual.length >= 3 && (actual.startsWith(stated) || stated.startsWith(actual))) return true;
  return stated.length >= 4 && similarity(stated, actual) >= 0.75; // voice transcription slips
}

function surnameMatches(stated: string, actual: string): boolean {
  if (!stated || !actual) return false;
  const a = stated.replace(/ /g, "");
  const b = actual.replace(/ /g, "");
  if (a === b) return true;
  // compound surnames: stated may be one part of a hyphenated/double surname
  if (actual.split(" ").includes(stated)) return true;
  return Math.min(a.length, b.length) >= 4 && similarity(a, b) >= 0.8;
}

/** Does "full name as stated by the caller" match the Halo user? Requires first AND last name. */
export function nameMatches(statedFullName: string, user: HaloUser): boolean {
  const stated = normalizeText(statedFullName).split(" ").filter(Boolean);
  if (stated.length < 2) return false;
  let first = normalizeText(user.firstname);
  let last = normalizeText(user.surname);
  if (!first || !last) {
    const parts = normalizeText(user.name).split(" ").filter(Boolean);
    if (parts.length < 2) return false;
    first = parts[0]!;
    last = parts.slice(1).join(" ");
  }
  const statedFirst = stated[0]!;
  const statedLast = stated.slice(1).join(" ");
  const statedLastToken = stated[stated.length - 1]!;
  return (
    firstNameMatches(statedFirst, first.split(" ")[0]!) &&
    (surnameMatches(statedLast, last) || surnameMatches(statedLastToken, last))
  );
}

const COMPANY_NOISE = new Set([
  "inc", "incorporated", "ltd", "limited", "llc", "llp", "corp", "corporation", "co", "company",
  "the", "and", "group", "plc", "pty", "gmbh", "ulc", "lp",
]);

export function normalizeCompany(s: string | undefined | null): string {
  return normalizeText(s)
    .split(" ")
    .filter((w) => w && !COMPANY_NOISE.has(w))
    .join(" ");
}

export function companyMatches(stated: string, actual: string | undefined): boolean {
  const a = normalizeCompany(stated);
  const b = normalizeCompany(actual);
  if (!a || !b) return false;
  if (a === b) return true;
  const shortest = Math.min(a.length, b.length);
  if (shortest >= 4 && (b.includes(a) || a.includes(b))) return true;
  const acronym = b
    .split(" ")
    .map((w) => w[0])
    .join("");
  if (a.replace(/ /g, "").length >= 2 && a.replace(/ /g, "") === acronym) return true;
  return shortest >= 4 && similarity(a, b) >= 0.8;
}

// ---------- Verification tokens ----------

export interface VerifiedIdentity {
  uid: number; // Halo user id
  cid: number; // Halo client id
  sid?: number; // Halo site id
  m: "phone" | "email" | "chat"; // how they were verified
  fn: string; // first name (for friendly replies)
  cn: string; // client name
  exp: number; // epoch seconds
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function signToken(identity: Omit<VerifiedIdentity, "exp">, secret: string, ttlMinutes: number): string {
  const payload: VerifiedIdentity = { ...identity, exp: Math.floor(Date.now() / 1000) + ttlMinutes * 60 };
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export class TokenError extends Error {}

export function verifyToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): VerifiedIdentity {
  const [body, sig] = (token ?? "").trim().split(".");
  if (!body || !sig) throw new TokenError("malformed");
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new TokenError("bad signature");
  let payload: VerifiedIdentity;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("malformed");
  }
  if (typeof payload.exp !== "number" || payload.exp < nowSec) throw new TokenError("expired");
  if (!Number.isInteger(payload.uid) || !Number.isInteger(payload.cid)) throw new TokenError("malformed");
  return payload;
}
