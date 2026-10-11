import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HaloError, type HaloApi, type Query } from "../src/halo/client.js";
import type { HaloTicket, HaloUser } from "../src/halo/types.js";
import { UserFacingError, WilmaService } from "../src/service.js";

const cfg = loadConfig({
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
  VERIFY_ATTEMPTS_PER_15MIN: "50",
});

const users: HaloUser[] = [
  {
    id: 101, firstname: "Michael", surname: "Smith", name: "Michael Smith", emailaddress: "mike@acme.com",
    phonenumber: "(604) 555-1234", client_id: 10, client_name: "Acme Widgets Inc.", site_id: 11,
  },
  {
    // shares the office main line with Michael
    id: 102, firstname: "Sarah", surname: "Jones", name: "Sarah Jones", emailaddress: "sarah@acme.com",
    phonenumber: "604-555-1234", mobilenumber: "778 555 0000", client_id: 10, client_name: "Acme Widgets Inc.", site_id: 11,
  },
  {
    id: 201, firstname: "Pat", surname: "Lee", name: "Pat Lee", emailaddress: "pat@globex.com",
    phonenumber: "250 555 9999", client_id: 20, client_name: "Globex", site_id: 21,
  },
  {
    id: 301, firstname: "Old", surname: "User", emailaddress: "old@acme.com", phonenumber: "604 555 7777",
    client_id: 10, client_name: "Acme Widgets Inc.", inactive: true,
  },
];

const tickets: HaloTicket[] = [
  { id: 5001, summary: "Printer jam", status_id: 2, status_name: "In Progress", user_id: 101, client_id: 10, agent_name: "Dana Tech" },
  { id: 5002, summary: "Old issue", status_id: 9, status_name: "Closed", user_id: 101, client_id: 10 },
  { id: 6001, summary: "Globex secret", status_id: 2, status_name: "New", user_id: 201, client_id: 20 },
  { id: 5003, summary: "Sarah's laptop", status_id: 1, status_name: "New", user_id: 102, client_id: 10 },
];

class FakeHalo implements HaloApi {
  posts: { path: string; body: any }[] = [];
  gets: { path: string; query?: Query }[] = [];

  async get<T>(path: string, query?: Query): Promise<T> {
    this.gets.push({ path, query });
    if (path === "/Users") {
      const s = String(query?.search ?? "").toLowerCase();
      const hits = users.filter((u) =>
        query?.search_phonenumbers
          ? [u.phonenumber, u.mobilenumber].some((p) => (p ?? "").replace(/\D/g, "").includes(s))
          : [u.emailaddress, u.name].some((f) => (f ?? "").toLowerCase().includes(s)),
      );
      // Halo list results omit some fields; force detail lookups for phone fields
      return { users: hits.map(({ id, name, inactive }) => ({ id, name, inactive })) } as T;
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

async function tokenFor(name = "Mike Smith", company = "Acme") {
  const r = await svc.verifyCaller({ caller_id: "+16045551234", full_name: name, company_name: company });
  expect(r.verified).toBe(true);
  return r.token!;
}

describe("verifyCaller", () => {
  it("verifies by caller ID + name + company and disambiguates a shared line", async () => {
    const r = await svc.verifyCaller({ caller_id: "16045551234", full_name: "Sarah Jones", company_name: "acme widgets" });
    expect(r).toMatchObject({ verified: true, first_name: "Sarah", company: "Acme Widgets Inc." });
  });

  it("rejects a wrong name without leaking who owns the number", async () => {
    const r = await svc.verifyCaller({ caller_id: "6045551234", full_name: "Bob Brown", company_name: "Acme" });
    expect(r.verified).toBe(false);
    expect(r.token).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/Michael|Sarah|Smith|Jones/);
    expect(r.next_step).toMatch(/email/);
  });

  it("rejects a wrong company", async () => {
    const r = await svc.verifyCaller({ caller_id: "6045551234", full_name: "Michael Smith", company_name: "Globex" });
    expect(r.verified).toBe(false);
  });

  it("falls back to email + name + company when caller ID doesn't match", async () => {
    const r = await svc.verifyCaller({
      caller_id: "4165550000", full_name: "Pat Lee", company_name: "Globex", email: "PAT@globex.com",
    });
    expect(r).toMatchObject({ verified: true, first_name: "Pat" });
  });

  it("rejects email fallback when the name doesn't match the email owner", async () => {
    const r = await svc.verifyCaller({
      caller_id: "4165550000", full_name: "Michael Smith", company_name: "Globex", email: "pat@globex.com",
    });
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
});

describe("verifyChatUser", () => {
  it("verifies an exact email match only", async () => {
    expect((await svc.verifyChatUser({ email: "mike@acme.com" })).verified).toBe(true);
    expect((await svc.verifyChatUser({ email: "acme.com" })).verified).toBe(false);
    expect((await svc.verifyChatUser({ email: "nobody@acme.com" })).verified).toBe(false);
    expect((await svc.verifyChatUser({ email: "old@acme.com" })).verified).toBe(false);
  });
});

describe("tickets", () => {
  it("lists only the verified user's open tickets even if Halo ignores the filter", async () => {
    const r = await svc.listMyOpenTickets(await tokenFor());
    expect(r.tickets.map((t) => t.ticket_id)).toEqual([5001]);
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
    expect(other).toBeInstanceOf(UserFacingError);
    expect(colleague.message).toBe(other.message);
    expect(missing.message).toBe(other.message);
    await expect(svc.addTicketUpdate(token, 6001, "hi")).rejects.toBeInstanceOf(UserFacingError);
    expect(halo.posts).toHaveLength(0);
  });

  it("allows colleague tickets when client-wide access is enabled", async () => {
    const wide = new WilmaService(halo, { ...cfg, ALLOW_CLIENT_WIDE_TICKETS: true });
    const r = await wide.verifyCaller({ caller_id: "6045551234", full_name: "Mike Smith", company_name: "Acme" });
    expect((await wide.getTicketUpdate(r.token!, 5003)).ticket_id).toBe(5003);
    await expect(wide.getTicketUpdate(r.token!, 6001)).rejects.toBeInstanceOf(UserFacingError);
  });

  it("rejects missing / forged tokens", async () => {
    await expect(svc.listMyOpenTickets("not-a-token")).rejects.toBeInstanceOf(UserFacingError);
    const token = await tokenFor();
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: 201, cid: 20, m: "phone", fn: "x", cn: "x", exp: 9e9 })).toString("base64url");
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
