import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HaloError, type HaloApi, type Query } from "../src/halo/client.js";
import type { HaloTicket, HaloUser } from "../src/halo/types.js";
import { UserFacingError, WilmaService } from "../src/service.js";

const baseEnv = {
  MCP_API_KEY: "k".repeat(32),
  TOKEN_SECRET: "s".repeat(40),
  HALO_BASE_URL: "https://halo.example.com/api",
  HALO_AUTH_URL: "https://halo.example.com/auth",
  HALO_CLIENT_ID: "id",
  HALO_CLIENT_SECRET: "secret",
  HALO_TICKETTYPE_ID: "3",
  HALO_TEAM_ID: "2",
  HALO_PRIORITY_NORMAL: "3",
  HALO_PRIORITY_HIGH: "2",
  HALO_UPDATE_OUTCOME_ID: "1",
  HALO_CLOSED_STATUS_IDS: "9",
  VERIFY_ATTEMPTS_PER_15MIN: "100",
};
const cfg = loadConfig(baseEnv);

const ACME = { client_id: 10, client_name: "Acme Widgets Inc." };
const ACME_HOLD = { client_id: 30, client_name: "Acme Holdings" };
const GLOBEX = { client_id: 20, client_name: "Globex" };
const INITECH = { client_id: 40, client_name: "Initech" };
const MEGA = { client_id: 50, client_name: "Megacorp" };

const users: HaloUser[] = [
  // Michael exists under two clients with the same phone and email
  { id: 101, firstname: "Michael", surname: "Smith", name: "Michael Smith", emailaddress: "mike@acme.com", phonenumber: "(604) 555-1234", site_id: 11, ...ACME },
  { id: 103, firstname: "Mike", surname: "Smith", name: "Mike Smith", emailaddress: "mike@acme.com", phonenumber: "604 555 1234", site_id: 31, ...ACME_HOLD },
  // shares Acme's main line with Michael
  { id: 102, firstname: "Sarah", surname: "Jones", name: "Sarah Jones", emailaddress: "sarah@acme.com", phonenumber: "604-555-1234", ...ACME },
  { id: 201, firstname: "Pat", surname: "Lee", name: "Pat Lee", emailaddress: "pat@globex.com", phonenumber: "250 555 9999", ...GLOBEX },
  // Pat is also a contact at two more clients, one with a similar name
  { id: 202, firstname: "Pat", surname: "Lee", name: "Pat Lee", emailaddress: "pat@globex.com", phonenumber: "250 555 9999", client_id: 60, client_name: "Globex Labs" },
  { id: 203, firstname: "Patricia", surname: "Lee", name: "Patricia Lee", emailaddress: "pat@globex.com", phonenumber: "250 555 9999", ...INITECH },
  { id: 301, firstname: "Old", surname: "User", name: "Old User", emailaddress: "old@acme.com", phonenumber: "604 555 7777", inactive: true, ...ACME },
  // Initech: shared office@ mailbox and a main line with two different John Smiths
  { id: 401, firstname: "Bill", surname: "Lumbergh", name: "Bill Lumbergh", emailaddress: "office@initech.com", phonenumber: "512 555 0100", ...INITECH },
  { id: 402, firstname: "Peter", surname: "Gibbons", name: "Peter Gibbons", emailaddress: "office@initech.com", phonenumber: "512 555 0100", ...INITECH },
  { id: 403, firstname: "John", surname: "Smith", name: "John Smith", emailaddress: "j.smith@initech.com", phonenumber: "512 555 0100", ...INITECH },
  { id: 404, firstname: "John", surname: "Smith", name: "John Smith", emailaddress: "john.smith2@initech.com", phonenumber: "512 555 0100", ...INITECH },
  // Service account (PBX alert mailbox) carrying a client's main number; Halo returns it despite the filter
  { id: 601, firstname: "unknown", surname: "unknown", name: "unknown unknown", emailaddress: "pbx@chapel.example", phonenumber: "(403) 555-7311", client_id: 70, client_name: "Example Chapel", isserviceaccount: true },
  // Megacorp: 150 contacts on one main line; the real caller is near the end
  ...Array.from({ length: 150 }, (_, i): HaloUser =>
    i === 140
      ? { id: 5000 + i, firstname: "Zelda", surname: "Quinn", name: "Zelda Quinn", emailaddress: "zq@mega.com", phonenumber: "416 555 0000", ...MEGA }
      : { id: 5000 + i, firstname: "Filler", surname: "Person", name: "Filler Person", phonenumber: "416 555 0000", ...MEGA },
  ),
];

const tickets: HaloTicket[] = [
  { id: 5001, summary: "Printer jam", status_id: 2, status_name: "In Progress", user_id: 101, client_id: 10, agent_name: "Dana Tech", lastactiondate: "2026-10-01T00:00:00Z" },
  { id: 5002, summary: "Old issue", status_id: 9, status_name: "Closed", user_id: 101, client_id: 10 },
  { id: 5003, summary: "Sarah's laptop", status_id: 1, status_name: "New", user_id: 102, client_id: 10 },
  { id: 7001, summary: "Holdings VPN", status_id: 1, status_name: "New", user_id: 103, client_id: 30, client_name: "Acme Holdings", lastactiondate: "2026-10-05T00:00:00Z" },
  { id: 6001, summary: "Globex secret", status_id: 2, status_name: "New", user_id: 201, client_id: 20 },
];

class FakeHalo implements HaloApi {
  posts: { path: string; body: any }[] = [];
  failClientSearch = false;
  gets: { path: string; query?: Query }[] = [];

  async get<T>(path: string, query?: Query): Promise<T> {
    this.gets.push({ path, query });
    if (path === "/Client") {
      if (this.failClientSearch) throw new HaloError("boom", 500);
      const s = String(query?.search ?? "").toLowerCase();
      const clients = [...new Map(users.map((u) => [u.client_id, { id: u.client_id!, name: u.client_name }])).values()];
      return { clients: clients.filter((c) => (c.name ?? "").toLowerCase().includes(s)) } as T;
    }
    if (path === "/Users") {
      const s = String(query?.search ?? "").toLowerCase();
      const hits = users.filter((u) =>
        (query?.client_id === undefined || u.client_id === query.client_id) &&
        query?.search_phonenumbers
          ? [u.phonenumber, u.mobilenumber].some((p) => (p ?? "").replace(/\D/g, "").includes(s))
          : [u.emailaddress, u.name].some((f) => (f ?? "").toLowerCase().includes(s)),
      );
      const size = Number(query?.page_size ?? 100);
      const page = Number(query?.page_no ?? 1);
      const slice = query?.pageinate ? hits.slice((page - 1) * size, page * size) : hits.slice(0, size);
      // Halo list results omit some fields; force detail lookups for phone/email fields
      return { users: slice.map(({ id, name, inactive }) => ({ id, name, inactive })), record_count: hits.length } as T;
    }
    const um = path.match(/^\/Users\/(\d+)$/);
    if (um) return users.find((u) => u.id === Number(um[1])) as T;
    if (path === "/Tickets") {
      // Simulate Halo ignoring the user filter to prove we filter client-side.
      return { tickets: tickets.filter((t) => t.status_id !== 9 || !query?.open_only) } as T;
    }
    const tm = path.match(/^\/Tickets\/(\d+)$/);
    if (tm) {
      const t = tickets.find((x) => x.id === Number(tm[1]));
      if (!t) throw new HaloError("not found", 404);
      return t as T;
    }
    if (path === "/Actions") {
      return {
        actions: [
          { id: 1, datetime: "2026-10-01T10:00:00Z", who: "Dana Tech", note: "<p>Ordered a new <b>fuser</b>.</p>", hiddenfromuser: false },
          { id: 2, datetime: "2026-10-02T10:00:00Z", who: "Dana Tech", note: "Internal: client owes money", hiddenfromuser: true },
          { id: 3, datetime: "2026-10-03T10:00:00Z", who: "Dana Tech", note: "Part arrives Friday.", hiddenfromuser: false },
        ],
      } as T;
    }
    throw new Error(`unexpected GET ${path}`);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    this.posts.push({ path, body });
    if (path === "/Tickets") return { id: 7777 } as T;
    if (path === "/Actions") return [{ id: 8888 }] as T;
    throw new Error(`unexpected POST ${path}`);
  }
}

let halo: FakeHalo;
let svc: WilmaService;
beforeEach(() => {
  halo = new FakeHalo();
  svc = new WilmaService(halo, cfg);
});

/** Token for Michael narrowed to Acme Widgets only. */
async function tokenFor(company = "Acme Widgets") {
  const r = await svc.verifyCaller({ caller_id: "+16045551234", full_name: "Mike Smith", company_name: company });
  expect(r.verified).toBe(true);
  return r.token!;
}

const payload = (token: string) => JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());

describe("verifyCaller", () => {
  it("picks the right person off a shared office line by name", async () => {
    const r = await svc.verifyCaller({ caller_id: "16045551234", full_name: "Sarah Jones", company_name: "acme widgets" });
    expect(r).toMatchObject({ verified: true, first_name: "Sarah", companies: ["Acme Widgets Inc."] });
    expect(payload(r.token!).ids.map((x: any) => x.u)).toEqual([102]);
  });

  it("rejects a wrong name without leaking who owns the number", async () => {
    const r = await svc.verifyCaller({ caller_id: "6045551234", full_name: "Bob Brown", company_name: "Acme" });
    expect(r.verified).toBe(false);
    expect(r.token).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/Michael|Sarah|Smith|Jones|Holdings/);
    expect(r.next_step).toMatch(/email/);
  });

  it("rejects a company the person doesn't belong to", async () => {
    const r = await svc.verifyCaller({ caller_id: "6045551234", full_name: "Michael Smith", company_name: "Globex" });
    expect(r.verified).toBe(false);
  });

  it("falls back to email + name + company when caller ID doesn't match", async () => {
    const r = await svc.verifyCaller({ caller_id: "4165559999", full_name: "Pat Lee", company_name: "Globex", email: "PAT@globex.com" });
    expect(r).toMatchObject({ verified: true, first_name: "Pat" });
  });

  it("rejects email fallback when the name doesn't match the email owner", async () => {
    const r = await svc.verifyCaller({ caller_id: "4165559999", full_name: "Michael Smith", company_name: "Globex", email: "pat@globex.com" });
    expect(r.verified).toBe(false);
  });

  it("ignores inactive users", async () => {
    const r = await svc.verifyCaller({ caller_id: "6045557777", full_name: "Old User", company_name: "Acme" });
    expect(r.verified).toBe(false);
  });

  it("rate limits repeated attempts", async () => {
    const strict = new WilmaService(halo, { ...cfg, VERIFY_ATTEMPTS_PER_15MIN: 2 });
    const args = { caller_id: "6045550000", full_name: "X Y", company_name: "Z" };
    await strict.verifyCaller(args);
    await strict.verifyCaller(args);
    await expect(strict.verifyCaller(args)).rejects.toBeInstanceOf(UserFacingError);
  });

  it("finds a caller beyond the first page of a large client's main line", async () => {
    const r = await svc.verifyCaller({ caller_id: "4165550000", full_name: "Zelda Quinn", company_name: "Megacorp" });
    expect(r.verified).toBe(true);
    expect(payload(r.token!).ids[0].u).toBe(5140);
    // Name filtering before detail lookups: only Zelda's record was fetched in full
    expect(halo.gets.filter((g) => g.path.startsWith("/Users/"))).toHaveLength(1);
  });

  it("needs the email when two same-named people share a line, then picks the right one", async () => {
    const first = await svc.verifyCaller({ caller_id: "5125550100", full_name: "John Smith", company_name: "Initech" });
    expect(first.verified).toBe(false);
    expect(first.next_step).toMatch(/email/);
    const second = await svc.verifyCaller({
      caller_id: "5125550100", full_name: "John Smith", company_name: "Initech", email: "john.smith2@initech.com",
    });
    expect(second.verified).toBe(true);
    expect(payload(second.token!).ids.map((x: any) => x.u)).toEqual([404]);
  });
});

describe("same person under several companies", () => {
  it("a vague company verifies them across all their records", async () => {
    const r = await svc.verifyCaller({ caller_id: "6045551234", full_name: "Michael Smith", company_name: "Acme" });
    expect(r.verified).toBe(true);
    expect(r.companies).toEqual(["Acme Widgets Inc.", "Acme Holdings"]);
    expect(payload(r.token!).ids.map((x: any) => x.u)).toEqual([101, 103]);
    expect(r.message).toMatch(/ask which company/i);
  });

  it("a company matching two of three clients still covers all of the person's records", async () => {
    const r = await svc.verifyCaller({ caller_id: "2505559999", full_name: "Pat Lee", company_name: "Globex" });
    expect(r.verified).toBe(true);
    expect(payload(r.token!).ids.map((x: any) => x.u).sort()).toEqual([201, 202, 203]);
    const exact = await svc.verifyCaller({ caller_id: "2505559999", full_name: "Pat Lee", company_name: "Initech" });
    expect(payload(exact.token!).ids.map((x: any) => x.u)).toEqual([203]);
  });

  it("a specific company narrows the token to that record", async () => {
    const r = await svc.verifyCaller({ caller_id: "6045551234", full_name: "Mike Smith", company_name: "Acme Holdings" });
    expect(payload(r.token!).ids.map((x: any) => x.u)).toEqual([103]);
  });

  it("chat with an email on both records verifies across both", async () => {
    const r = await svc.verifyChatUser({ email: "mike@acme.com" });
    expect(r.verified).toBe(true);
    expect(r.companies).toHaveLength(2);
  });

  it("lists open tickets from every company, tagged and newest first", async () => {
    const r = await svc.verifyChatUser({ email: "mike@acme.com" });
    const list = await svc.listMyOpenTickets(r.token!);
    expect(list.tickets.map((t) => [t.ticket_id, t.company])).toEqual([
      [7001, "Acme Holdings"],
      [5001, "Acme Widgets Inc."],
    ]);
  });

  it("can read and update tickets from either company but not a third company's", async () => {
    const { token } = await svc.verifyChatUser({ email: "mike@acme.com" });
    expect((await svc.getTicketUpdate(token!, 7001)).company).toBe("Acme Holdings");
    await svc.addTicketUpdate(token!, 5001, "still jammed");
    await expect(svc.getTicketUpdate(token!, 6001)).rejects.toBeInstanceOf(UserFacingError);
    await expect(svc.getTicketUpdate(token!, 5003)).rejects.toBeInstanceOf(UserFacingError); // colleague's ticket
  });

  it("create_ticket asks which company, then files under the chosen one", async () => {
    const { token } = await svc.verifyChatUser({ email: "mike@acme.com" });
    const input = { summary: "New laptop setup", details: "Need a laptop set up" };
    await expect(svc.createTicket(token!, input)).rejects.toThrow(/Acme Widgets Inc\. or Acme Holdings/);
    await expect(svc.createTicket(token!, { ...input, company: "Acme" })).rejects.toThrow(/doesn't clearly match/);
    await expect(svc.createTicket(token!, { ...input, company: "Globex" })).rejects.toThrow(/doesn't clearly match/);
    expect(halo.posts).toHaveLength(0);

    const r = await svc.createTicket(token!, { ...input, company: "holdings" });
    expect(r.company).toBe("Acme Holdings");
    expect(halo.posts[0]!.body[0]).toMatchObject({ user_id: 103, client_id: 30, site_id: 31 });
  });
});

describe("verifyChatUser", () => {
  it("verifies an exact email match only", async () => {
    expect((await svc.verifyChatUser({ email: "sarah@acme.com" })).verified).toBe(true);
    expect((await svc.verifyChatUser({ email: "acme.com" })).verified).toBe(false);
    expect((await svc.verifyChatUser({ email: "nobody@acme.com" })).verified).toBe(false);
    expect((await svc.verifyChatUser({ email: "old@acme.com" })).verified).toBe(false);
  });

  it("asks for a name on a shared mailbox, then narrows to that person", async () => {
    const first = await svc.verifyChatUser({ email: "office@initech.com" });
    expect(first.verified).toBe(false);
    expect(first.next_step).toMatch(/full_name/);
    expect(JSON.stringify(first)).not.toMatch(/Bill|Peter|Lumbergh|Gibbons/);

    const r = await svc.verifyChatUser({ email: "office@initech.com", full_name: "Peter Gibbons" });
    expect(r.verified).toBe(true);
    expect(payload(r.token!).ids.map((x: any) => x.u)).toEqual([402]);
  });

  it("rejects a shared mailbox when the name matches nobody on it", async () => {
    const r = await svc.verifyChatUser({ email: "office@initech.com", full_name: "Milton Waddams" });
    expect(r.verified).toBe(false);
  });
});

describe("tickets", () => {
  it("lists only the verified user's open tickets even if Halo ignores the filter", async () => {
    const r = await svc.listMyOpenTickets(await tokenFor());
    expect(r.tickets.map((t) => t.ticket_id)).toEqual([5001]);
    expect(r.tickets[0]).not.toHaveProperty("company");
    expect(halo.gets.find((g) => g.path === "/Tickets")?.query).toMatchObject({ user_id: 101, open_only: true });
  });

  it("returns public notes only, newest first, as plain text", async () => {
    const r = await svc.getTicketUpdate(await tokenFor(), 5001);
    expect(r.status).toBe("In Progress");
    expect(r.assigned_to).toBe("Dana");
    expect(r.recent_public_updates.map((n) => n.note)).toEqual(["Part arrives Friday.", "Ordered a new fuser ."]);
    expect(JSON.stringify(r)).not.toMatch(/owes money/);
    expect(halo.gets.find((g) => g.path === "/Actions")?.query).toMatchObject({ excludeprivate: true, excludesys: true });
  });

  it("refuses tickets belonging to someone else, same message as not found", async () => {
    const token = await tokenFor();
    const other = await svc.getTicketUpdate(token, 6001).catch((e) => e);
    const colleague = await svc.getTicketUpdate(token, 5003).catch((e) => e);
    const missing = await svc.getTicketUpdate(token, 9999).catch((e) => e);
    const otherRecord = await svc.getTicketUpdate(token, 7001).catch((e) => e); // narrowed token: Holdings not included
    expect(other).toBeInstanceOf(UserFacingError);
    expect(colleague.message).toBe(other.message);
    expect(missing.message).toBe(other.message);
    expect(otherRecord.message).toBe(other.message);
    await expect(svc.addTicketUpdate(token, 6001, "hi")).rejects.toBeInstanceOf(UserFacingError);
    expect(halo.posts).toHaveLength(0);
  });

  it("allows colleague tickets when client-wide access is enabled", async () => {
    const wide = new WilmaService(halo, { ...cfg, ALLOW_CLIENT_WIDE_TICKETS: true });
    const r = await wide.verifyCaller({ caller_id: "6045551234", full_name: "Mike Smith", company_name: "Acme Widgets" });
    expect((await wide.getTicketUpdate(r.token!, 5003)).ticket_id).toBe(5003);
    await expect(wide.getTicketUpdate(r.token!, 6001)).rejects.toBeInstanceOf(UserFacingError);
  });

  it("rejects missing / forged tokens", async () => {
    await expect(svc.listMyOpenTickets("not-a-token")).rejects.toBeInstanceOf(UserFacingError);
    const token = await tokenFor();
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ids: [{ u: 201, c: 20, cn: "x" }], m: "phone", fn: "x", exp: 9e9 })).toString("base64url");
    await expect(svc.listMyOpenTickets(`${forged}.${sig}`)).rejects.toBeInstanceOf(UserFacingError);
  });

  it("creates a ticket with identity from the token and configured defaults", async () => {
    const r = await svc.createTicket(await tokenFor(), {
      summary: "Outlook not syncing",
      details: "Since this morning <script>x</script>\nno new mail",
      urgency: "high",
      callback_number: "604 555 1234",
    });
    expect(r.ticket_id).toBe(7777);
    const [body] = halo.posts[0]!.body;
    expect(body).toMatchObject({
      summary: "Outlook not syncing", user_id: 101, client_id: 10, site_id: 11,
      tickettype_id: 3, team_id: 2, priority_id: 2,
    });
    expect(body.details_html).toContain("&lt;script&gt;");
    expect(body.details_html).toContain("<br>");
    expect(body.details_html).toContain("Callback number");
  });

  it("de-duplicates an identical create within a few minutes", async () => {
    const token = await tokenFor();
    const input = { summary: "Outlook not syncing", details: "no new mail at all" };
    await svc.createTicket(token, input);
    const again = await svc.createTicket(token, input);
    expect(again).toMatchObject({ ticket_id: 7777, duplicate: true });
    expect(halo.posts).toHaveLength(1);
  });

  it("adds a public update to an owned open ticket", async () => {
    const r = await svc.addTicketUpdate(await tokenFor(), 5001, "It works after a reboot");
    expect(r.ticket_id).toBe(5001);
    const [body] = halo.posts[0]!.body;
    expect(body).toMatchObject({ ticket_id: 5001, outcome_id: 1, hiddenfromuser: false, sendemail: false });
    expect(body.note_html).toContain("It works after a reboot");
  });

  it("refuses updates on closed tickets", async () => {
    await expect(svc.addTicketUpdate(await tokenFor(), 5002, "still broken")).rejects.toThrow(/closed/);
    expect(halo.posts).toHaveLength(0);
  });
});

describe("logUnverifiedRequest", () => {
  const base = {
    channel: "phone" as const,
    stated_name: "Michael Smith",
    stated_company: "Acme Widgets",
    callback_number: "403 555 1212",
    caller_id: "604-555-1234",
    summary: "Can't log in to email",
    details: "Locked out since this morning",
    verification_issue: "name didn't match caller ID",
  };

  it("files under the Unknown client and General User, never the claimed client", async () => {
    const r = await svc.logUnverifiedRequest(base);
    expect(r.ticket_id).toBe(7777);
    const ticket = halo.posts.find((p) => p.path === "/Tickets")!.body[0];
    expect(ticket).toMatchObject({ user_id: 19, client_id: 1, site_id: 1, tickettype_id: 3, priority_id: 3 });
    expect(ticket.summary).toBe("[Unverified] Can't log in to email");
    expect(ticket.details_html).toMatch(/UNVERIFIED CALLER/);
    expect(ticket.details_html).toContain("403 555 1212");
    expect(ticket.details_html).toContain("Acme Widgets");
  });

  it("tells the caller nothing about Halo matches", async () => {
    const r = await svc.logUnverifiedRequest({ ...base, stated_name: "Sarah Jones" });
    expect(JSON.stringify(r)).not.toMatch(/user 1\d\d|Michael|Sarah|Acme Widgets Inc|possible/i);
    expect(r.message).toMatch(/403 555 1212/);
  });

  it("puts possible matches in a private note for the technician", async () => {
    await svc.logUnverifiedRequest(base);
    const note = halo.posts.find((p) => p.path === "/Actions")!.body[0];
    expect(note).toMatchObject({ ticket_id: 7777, hiddenfromuser: true, sendemail: false });
    expect(note.note_html).toContain("user 101");
    expect(note.note_html).toContain("caller ID and name match");
  });

  it("suggests contacts by name + company when there's no caller ID match", async () => {
    await svc.logUnverifiedRequest({ ...base, channel: "chat", caller_id: undefined, stated_name: "Sarah Jones" });
    const note = halo.posts.find((p) => p.path === "/Actions")!.body[0].note_html;
    expect(note).toContain("user 102");
    expect(note).toContain("name and company match");
  });

  it("notes a matching company even when no contact has that name", async () => {
    await svc.logUnverifiedRequest({ ...base, caller_id: "4035550000", stated_name: "New Hire", stated_company: "Globex" });
    const note = halo.posts.find((p) => p.path === "/Actions")!.body[0].note_html;
    expect(note).toMatch(/Globex.*client 20.*no contact by that name/);
  });

  it("still logs the ticket if the match lookup fails", async () => {
    halo.failClientSearch = true;
    const r = await svc.logUnverifiedRequest(base);
    expect(r.ticket_id).toBe(7777);
    expect(halo.posts.filter((p) => p.path === "/Tickets")).toHaveLength(1);
  });

  it("escapes what the caller says", async () => {
    await svc.logUnverifiedRequest({ ...base, stated_name: "<img src=x onerror=alert(1)> Bob" });
    expect(halo.posts[0]!.body[0].details_html).not.toContain("<img");
  });

  it("rate limits per caller ID and de-duplicates repeats", async () => {
    const strict = new WilmaService(halo, { ...cfg, UNVERIFIED_REQUESTS_PER_HOUR: 2 });
    await strict.logUnverifiedRequest({ ...base, summary: "one thing" });
    const dup = await strict.logUnverifiedRequest({ ...base, summary: "one thing" });
    expect(dup).toMatchObject({ duplicate: true });
    await expect(strict.logUnverifiedRequest({ ...base, summary: "another thing" })).rejects.toThrow(/Too many/);
  });

  it("applies a global cap across all callers", async () => {
    const strict = new WilmaService(halo, { ...cfg, UNVERIFIED_REQUESTS_GLOBAL_PER_HOUR: 2 });
    await strict.logUnverifiedRequest({ ...base, caller_id: "4035550001" }, "1.1.1.1");
    await strict.logUnverifiedRequest({ ...base, caller_id: "4035550002" }, "2.2.2.2");
    await expect(strict.logUnverifiedRequest({ ...base, caller_id: "4035550003" }, "3.3.3.3")).rejects.toThrow(/Too many/);
  });

  it("can be disabled", async () => {
    const off = new WilmaService(halo, loadConfig({ ...baseEnv, HALO_UNVERIFIED_USER_ID: "" }));
    await expect(off.logUnverifiedRequest(base)).rejects.toThrow(/aren't enabled/);
    expect(halo.posts).toHaveLength(0);
  });
});

describe("service accounts", () => {
  it("asks Halo to exclude them", async () => {
    await svc.verifyChatUser({ email: "mike@acme.com" });
    expect(halo.gets.find((g) => g.path === "/Users")?.query).toMatchObject({
      includeserviceaccount: false,
      includenonserviceaccount: true,
    });
  });

  it("can't be verified as, even if Halo returns them", async () => {
    expect((await svc.verifyChatUser({ email: "pbx@chapel.example" })).verified).toBe(false);
    const r = await svc.verifyCaller({ caller_id: "4035557311", full_name: "Unknown Unknown", company_name: "Example Chapel" });
    expect(r.verified).toBe(false);
  });

  it("never shows up as a possible match", async () => {
    await svc.logUnverifiedRequest({
      channel: "phone", stated_name: "Jane Doe", caller_id: "403-555-7311", email: "pbx@chapel.example",
      summary: "Phones down", details: "No dial tone on any phone",
    });
    const note = halo.posts.find((p) => p.path === "/Actions")!.body[0].note_html;
    expect(note).not.toContain("user 601");
    expect(note).toContain("None found");
  });
});
