import type { Config } from "./config.js";
import { log, RateLimiter } from "./audit.js";
import { HaloError, type HaloApi, type Query } from "./halo/client.js";
import type { ActionList, ClientList, HaloAction, HaloTicket, HaloUser, TicketList, UserList } from "./halo/types.js";
import {
  allSamePerson,
  companyMatches,
  hasPhoneFields,
  nameMatches,
  normalizePhone,
  normalizeText,
  signToken,
  TokenError,
  userPhoneNumbers,
  verifyToken,
  type IdentityRecord,
  type VerifiedIdentity,
} from "./identity.js";

/** An error whose message is safe to show to Wilma / the end user. */
export class UserFacingError extends Error {}

export interface VerifyResult {
  verified: boolean;
  token?: string;
  first_name?: string;
  companies?: string[];
  expires_in_minutes?: number;
  message: string;
  next_step?: string;
}

const NOT_VERIFIED =
  "I wasn't able to verify the person with the details provided. Do not reveal any account or ticket information.";
const TICKET_NOT_FOUND =
  "No ticket with that number was found on this person's account. Ask them to double-check the number, or offer to list their open tickets.";
const CALLBACK = "Offer to have a technician call them back.";

const PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 10; // up to 1,000 contacts on one main line
const MAX_DETAIL_LOOKUPS = 25;

export class WilmaService {
  private readonly verifyLimiter: RateLimiter;
  private readonly unverifiedLimiter: RateLimiter;
  private readonly unverifiedGlobalLimiter: RateLimiter;
  private readonly recentCreates = new Map<string, { id: number; at: number }>();

  constructor(
    private readonly halo: HaloApi,
    private readonly cfg: Config,
  ) {
    this.verifyLimiter = new RateLimiter(cfg.VERIFY_ATTEMPTS_PER_15MIN, 15 * 60_000);
    this.unverifiedLimiter = new RateLimiter(cfg.UNVERIFIED_REQUESTS_PER_HOUR, 60 * 60_000);
    this.unverifiedGlobalLimiter = new RateLimiter(cfg.UNVERIFIED_REQUESTS_GLOBAL_PER_HOUR, 60 * 60_000);
  }

  // ---------------- Halo lookups ----------------

  private async getUser(id: number): Promise<HaloUser> {
    return this.halo.get<HaloUser>(`/Users/${id}`);
  }

  /** Paged user search; returns active users only. */
  private async searchUsers(query: Query, maxPages = MAX_SEARCH_PAGES): Promise<HaloUser[]> {
    const out: HaloUser[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.halo.get<UserList>("/Users", {
        includeactive: true,
        includeinactive: false,
        pageinate: true,
        page_size: PAGE_SIZE,
        page_no: page,
        ...query,
      });
      const batch = res?.users ?? [];
      out.push(...batch);
      const total = res?.record_count;
      if (batch.length < PAGE_SIZE || (total !== undefined && out.length >= total)) return out.filter((u) => !u.inactive);
    }
    log("warn", "user_search_truncated", { pages: maxPages });
    return out.filter((u) => !u.inactive);
  }

  /**
   * Full user records for hits that fit the stated name. Name filtering happens on the list
   * result first so a big main line doesn't trigger hundreds of detail lookups.
   */
  private async detailsForName(hits: HaloUser[], fullName: string | undefined, needsDetail: (u: HaloUser) => boolean) {
    const shortlist = fullName ? hits.filter((h) => !(h.name || h.surname) || nameMatches(fullName, h)) : hits;
    const out: HaloUser[] = [];
    for (const hit of shortlist.slice(0, MAX_DETAIL_LOOKUPS)) {
      const u = needsDetail(hit) ? await this.getUser(hit.id) : hit;
      if (!u.inactive && (!fullName || nameMatches(fullName, u))) out.push(u);
    }
    if (shortlist.length > MAX_DETAIL_LOOKUPS) log("warn", "detail_lookups_capped", { shortlist: shortlist.length });
    return out;
  }

  /** Active users whose phone/mobile numbers include `phone` and whose name fits. */
  private async usersByPhone(phone: string, fullName: string): Promise<HaloUser[]> {
    const hits = await this.searchUsers({ search: phone.slice(-4), search_phonenumbers: true });
    const cc = this.cfg.DEFAULT_COUNTRY_CODE;
    const named = await this.detailsForName(hits, fullName, (u) => !hasPhoneFields(u) || u.client_name === undefined);
    return named.filter((u) => userPhoneNumbers(u, cc).includes(phone));
  }

  /** Active users with `email` as any of their addresses (optionally also fitting a name). */
  private async usersByEmail(email: string, fullName?: string): Promise<HaloUser[]> {
    const wanted = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(wanted)) return [];
    const hits = await this.searchUsers({ search: wanted }, 3);
    const users = await this.detailsForName(hits, fullName, (u) => u.emailaddress === undefined || u.client_name === undefined);
    return users.filter((u) => [u.emailaddress, u.email2, u.email3].some((e) => (e ?? "").trim().toLowerCase() === wanted));
  }

  // ---------------- Identity ----------------

  private matchesCompany(company: string, u: HaloUser): boolean {
    return companyMatches(company, u.client_name) || companyMatches(company, u.site_name);
  }

  /**
   * Given records that already share the verifying factor and fit the stated name, decide who
   * this is. Different people → ambiguous. Same person under several clients → all of them,
   * unless the stated company singles one client out. `company` undefined = no company check (chat).
   *
   * `distinctClients`: a shared phone line can't tell apart two same-named contacts under the
   * same client (two John Smiths at Acme), so on the phone path that counts as ambiguous and the
   * email fallback decides. An email address is personal, so same-client duplicates there are
   * treated as duplicate records of one person.
   */
  private resolvePerson(
    users: HaloUser[],
    company?: string,
    distinctClients = false,
  ): HaloUser[] | "none" | "ambiguous" {
    if (users.length === 0) return "none";
    if (!allSamePerson(users)) return "ambiguous";
    let chosen = users;
    if (company !== undefined) {
      const byCompany = users.filter((u) => this.matchesCompany(company, u));
      if (byCompany.length === 0) return "none"; // company is a required confirmation factor on calls
      if (new Set(byCompany.map((u) => u.client_id)).size === 1) chosen = byCompany;
    }
    if (distinctClients && new Set(chosen.map((u) => u.client_id)).size < chosen.length) return "ambiguous";
    return chosen;
  }

  private issue(users: HaloUser[], method: VerifiedIdentity["m"]): VerifyResult {
    const primary = users[0]!;
    const firstName = primary.firstname || (primary.name ?? "").split(" ")[0] || "there";
    const ids: IdentityRecord[] = users.map((u) => ({ u: u.id, c: u.client_id ?? 0, s: u.site_id, cn: u.client_name ?? "" }));
    const token = signToken({ ids, m: method, fn: firstName }, this.cfg.TOKEN_SECRET, this.cfg.TOKEN_TTL_MIN);
    const companies = [...new Set(ids.map((r) => r.cn).filter(Boolean))];
    log("info", "verify_success", { method, user_ids: ids.map((r) => r.u), client_ids: ids.map((r) => r.c) });
    return {
      verified: true,
      token,
      first_name: firstName,
      companies,
      expires_in_minutes: this.cfg.TOKEN_TTL_MIN,
      message:
        companies.length > 1
          ? `Verified ${firstName}, who has accounts with ${listOr(companies)}. Pass this token to the ticket tools. When logging a new ticket, ask which company it's for.`
          : `Verified ${firstName} at ${companies[0] ?? "their company"}. Pass this token to the ticket tools for the rest of the conversation.`,
    };
  }

  private rateLimit(keys: string[]) {
    for (const k of keys) {
      if (!this.verifyLimiter.take(k)) {
        log("warn", "verify_rate_limited", { key: k.replace(/:.*/, ":***") });
        throw new UserFacingError(
          "Too many verification attempts. Do not try again; offer to have a technician call them back instead.",
        );
      }
    }
  }

  async verifyCaller(
    input: { caller_id: string; full_name: string; company_name: string; email?: string },
    ip = "unknown",
  ): Promise<VerifyResult> {
    const phone = normalizePhone(input.caller_id, this.cfg.DEFAULT_COUNTRY_CODE);
    this.rateLimit([`ip:${ip}`, `phone:${phone || input.caller_id}`, ...(input.email ? [`email:${input.email.toLowerCase()}`] : [])]);

    // 1) Caller ID → records with that number and the stated name, confirmed by company.
    if (phone) {
      const found = this.resolvePerson(await this.usersByPhone(phone, input.full_name), input.company_name, true);
      if (Array.isArray(found)) return this.issue(found, "phone");
      log("info", "verify_phone_unresolved", { outcome: found });
    }

    // 2) Fallback: email on file + name + company must all agree.
    if (input.email) {
      const found = this.resolvePerson(await this.usersByEmail(input.email, input.full_name), input.company_name);
      if (Array.isArray(found)) return this.issue(found, "email");
      log("info", "verify_email_unresolved", { outcome: found });
      return { verified: false, message: NOT_VERIFIED, next_step: CALLBACK };
    }

    return {
      verified: false,
      message: NOT_VERIFIED,
      next_step:
        "Ask the caller to confirm their full first and last name, company name, and the email address on their account, then call verify_caller again including the email.",
    };
  }

  async verifyChatUser(input: { email: string; full_name?: string }, ip = "unknown"): Promise<VerifyResult> {
    this.rateLimit([`ip:${ip}`, `email:${input.email.toLowerCase()}`]);
    const all = await this.usersByEmail(input.email);
    if (all.length === 0) {
      log("info", "verify_chat_unresolved", { outcome: "none" });
      return {
        verified: false,
        message:
          "That email address isn't registered with us. Do not reveal any account or ticket information; offer to have a technician follow up.",
      };
    }
    if (allSamePerson(all)) return this.issue(all, "chat");

    // Shared mailbox: several different people use this address. Narrow by the person's name.
    if (!input.full_name) {
      log("info", "verify_chat_shared_mailbox", { contacts: all.length });
      return {
        verified: false,
        message: "This email address is shared by more than one person.",
        next_step: "Ask for their full first and last name, then call verify_chat_user again with full_name.",
      };
    }
    const found = this.resolvePerson(all.filter((u) => nameMatches(input.full_name!, u)));
    if (Array.isArray(found)) return this.issue(found, "chat");
    log("info", "verify_chat_unresolved", { outcome: found, shared: true });
    return { verified: false, message: NOT_VERIFIED, next_step: "Offer to have a technician follow up." };
  }

  identityFromToken(token: string): VerifiedIdentity {
    try {
      return verifyToken(token, this.cfg.TOKEN_SECRET);
    } catch (e) {
      const reason = e instanceof TokenError ? e.message : "invalid";
      log("warn", "token_rejected", { reason });
      throw new UserFacingError(
        reason === "expired"
          ? "The verification has expired. Verify the person again before continuing."
          : "Invalid verification token. Verify the person first using verify_caller or verify_chat_user.",
      );
    }
  }

  // ---------------- Tickets ----------------

  private owns(id: VerifiedIdentity, t: HaloTicket): boolean {
    if (id.ids.some((r) => t.user_id === r.u)) return true;
    return this.cfg.ALLOW_CLIENT_WIDE_TICKETS && id.ids.some((r) => !!r.c && t.client_id === r.c);
  }

  private isClosed(t: HaloTicket): boolean {
    return t.status_id !== undefined && this.cfg.HALO_CLOSED_STATUS_IDS.includes(t.status_id);
  }

  private companyOf(id: VerifiedIdentity, t: HaloTicket): string | undefined {
    return t.client_name ?? id.ids.find((r) => r.u === t.user_id || r.c === t.client_id)?.cn;
  }

  private async getOwnedTicket(id: VerifiedIdentity, ticketId: number): Promise<HaloTicket> {
    let t: HaloTicket;
    try {
      t = await this.halo.get<HaloTicket>(`/Tickets/${ticketId}`);
    } catch (e) {
      if (e instanceof HaloError && (e.status === 404 || e.status === 400)) throw new UserFacingError(TICKET_NOT_FOUND);
      throw e;
    }
    if (!t || t.id !== ticketId || !this.owns(id, t)) {
      log("warn", "ticket_ownership_denied", { user_ids: id.ids.map((r) => r.u), ticket_id: ticketId });
      throw new UserFacingError(TICKET_NOT_FOUND);
    }
    return t;
  }

  async listMyOpenTickets(token: string) {
    const id = this.identityFromToken(token);
    const filters = this.cfg.ALLOW_CLIENT_WIDE_TICKETS
      ? [...new Set(id.ids.map((r) => r.c).filter(Boolean))].map((c) => ({ client_id: c }))
      : id.ids.map((r) => ({ user_id: r.u }));
    const byId = new Map<number, HaloTicket>();
    for (const filter of filters) {
      const res = await this.halo.get<TicketList>("/Tickets", {
        ...filter,
        open_only: true,
        count: 10,
        order: "lastactiondate",
        orderdesc: true,
      });
      for (const t of res?.tickets ?? []) byId.set(t.id, t);
    }
    // Defence in depth: never trust the filter alone.
    const tickets = [...byId.values()]
      .filter((t) => this.owns(id, t) && !this.isClosed(t))
      .sort((a, b) => (Date.parse(b.lastactiondate ?? "") || 0) - (Date.parse(a.lastactiondate ?? "") || 0))
      .slice(0, 15);
    log("info", "list_open_tickets", { user_ids: id.ids.map((r) => r.u), count: tickets.length });
    const multiCompany = new Set(id.ids.map((r) => r.c)).size > 1;
    return {
      count: tickets.length,
      tickets: tickets.map((t) => ({
        ticket_id: t.id,
        summary: t.summary,
        status: t.status_name,
        ...(multiCompany ? { company: this.companyOf(id, t) } : {}),
        assigned_to: firstName(t.agent_name),
        opened: t.dateoccurred,
        last_updated: t.lastactiondate,
      })),
    };
  }

  async getTicketUpdate(token: string, ticketId: number) {
    const id = this.identityFromToken(token);
    const t = await this.getOwnedTicket(id, ticketId);
    const res = await this.halo.get<ActionList>("/Actions", {
      ticket_id: ticketId,
      excludeprivate: true,
      excludesys: true,
      count: 25,
    });
    const notes = (res?.actions ?? [])
      .filter((a) => a.hiddenfromuser !== true)
      .map((a) => ({ a, text: actionText(a) }))
      .filter((x) => x.text)
      .sort((x, y) => actionDate(y.a) - actionDate(x.a))
      .slice(0, this.cfg.MAX_PUBLIC_NOTES)
      .map(({ a, text }) => ({
        date: a.datetime ?? a.actiondatecreated,
        by: firstName(a.who),
        note: truncate(text, this.cfg.NOTE_CHAR_LIMIT),
      }));
    log("info", "get_ticket_update", { user_ids: id.ids.map((r) => r.u), ticket_id: ticketId, notes: notes.length });
    return {
      ticket_id: t.id,
      summary: t.summary,
      company: this.companyOf(id, t),
      status: t.status_name,
      is_closed: this.isClosed(t),
      assigned_to: firstName(t.agent_name) ?? "not yet assigned",
      opened: t.dateoccurred,
      last_updated: t.lastactiondate,
      recent_public_updates: notes,
    };
  }

  /** Which of the verified person's records a new ticket belongs to. */
  private pickRecord(id: VerifiedIdentity, company?: string): IdentityRecord {
    if (id.ids.length === 1) return id.ids[0]!;
    const names = [...new Set(id.ids.map((r) => r.cn))];
    if (!company) {
      throw new UserFacingError(
        `${id.fn} has accounts with ${listOr(names)}. Ask which company this ticket is for, then call create_ticket again with company.`,
      );
    }
    const matches = id.ids.filter((r) => companyMatches(company, r.cn));
    if (matches.length === 1) return matches[0]!;
    // Several user records under one client (rare): any of them is the same person at that company.
    if (matches.length > 1 && new Set(matches.map((r) => r.c)).size === 1) return matches[0]!;
    throw new UserFacingError(
      `"${company}" doesn't clearly match one of ${id.fn}'s companies. Ask whether it's for ${listOr(names)}, then call create_ticket again with that exact company name.`,
    );
  }

  async createTicket(
    token: string,
    input: { summary: string; details: string; urgency?: "low" | "normal" | "high"; callback_number?: string; company?: string },
  ) {
    const id = this.identityFromToken(token);
    const rec = this.pickRecord(id, input.company);
    const summary = input.summary.trim().slice(0, 200);

    // Guard against the LLM double-submitting the same request.
    const dedupeKey = `${rec.u}:${summary.toLowerCase()}`;
    const recent = this.recentCreates.get(dedupeKey);
    if (recent && Date.now() - recent.at < 10 * 60_000) {
      return { ticket_id: recent.id, duplicate: true, message: `This was already logged as ticket ${recent.id}.` };
    }

    const priority =
      input.urgency === "high"
        ? this.cfg.HALO_PRIORITY_HIGH
        : input.urgency === "low"
          ? this.cfg.HALO_PRIORITY_LOW
          : this.cfg.HALO_PRIORITY_NORMAL;
    const channel = id.m === "chat" ? "chat" : "phone";
    const lines = [
      `<p>${escapeHtml(input.details.trim()).replace(/\r?\n/g, "<br>")}</p>`,
      input.callback_number ? `<p><b>Callback number:</b> ${escapeHtml(input.callback_number)}</p>` : "",
      `<p><i>Logged by Wilma (Wildix AI) via ${channel}. Identity verified by ${verifiedBy(id.m)}.</i></p>`,
    ];
    const body = [
      {
        summary,
        details_html: lines.join(""),
        user_id: rec.u,
        client_id: rec.c || undefined,
        site_id: rec.s,
        tickettype_id: this.cfg.HALO_TICKETTYPE_ID,
        team_id: this.cfg.HALO_TEAM_ID,
        priority_id: priority,
        source: this.cfg.HALO_TICKET_SOURCE_ID,
      },
    ];
    const created = first(await this.halo.post<HaloTicket | HaloTicket[]>("/Tickets", body));
    if (!created?.id) throw new Error("Halo did not return a ticket id");
    this.recentCreates.set(dedupeKey, { id: created.id, at: Date.now() });
    log("info", "ticket_created", { user_id: rec.u, client_id: rec.c, ticket_id: created.id, urgency: input.urgency });
    return {
      ticket_id: created.id,
      company: rec.cn,
      message: `Ticket ${created.id} has been logged for ${id.fn}${id.ids.length > 1 ? ` under ${rec.cn}` : ""}. Read the ticket number back to them.`,
    };
  }

  // ---------------- Unverified requests ----------------

  /**
   * Log a callback request from someone who couldn't be verified. Always filed under the
   * configured Unknown client / General User — never the client they claim — so it can't
   * reach a real client's tickets, notifications or billing. The caller only gets a reference
   * number back; possible Halo matches go in a private note for the technician.
   */
  async logUnverifiedRequest(
    input: {
      channel: "phone" | "chat";
      stated_name: string;
      stated_company?: string;
      callback_number?: string;
      caller_id?: string;
      email?: string;
      summary: string;
      details: string;
      verification_issue?: string;
    },
    ip = "unknown",
  ) {
    const userId = this.cfg.HALO_UNVERIFIED_USER_ID;
    if (!userId) {
      throw new UserFacingError("Unverified requests aren't enabled. Offer to take their name and number for a callback another way.");
    }
    const phone = normalizePhone(input.caller_id, this.cfg.DEFAULT_COUNTRY_CODE);
    const email = input.email?.trim().toLowerCase();
    const keys = [`ip:${ip}`, phone ? `phone:${phone}` : email ? `email:${email}` : "anonymous"];
    if (!this.unverifiedGlobalLimiter.take("all") || !keys.every((k) => this.unverifiedLimiter.take(k))) {
      log("warn", "unverified_rate_limited", { channel: input.channel });
      throw new UserFacingError(
        "Too many requests have been logged from this caller recently. Apologise and suggest they email or call back later; do not retry.",
      );
    }

    const summary = `[Unverified] ${input.summary.trim()}`.slice(0, 200);
    const dedupeKey = `unverified:${keys[1]}:${summary.toLowerCase()}`;
    const recent = this.recentCreates.get(dedupeKey);
    if (recent && Date.now() - recent.at < 10 * 60_000) {
      return { ticket_id: recent.id, duplicate: true, message: `This was already logged as ticket ${recent.id}.` };
    }

    const row = (label: string, value?: string) =>
      value?.trim() ? `<tr><td><b>${label}</b></td><td>${escapeHtml(value.trim())}</td></tr>` : "";
    const details = [
      `<p style="color:#b00020"><b>⚠ UNVERIFIED CALLER — confirm identity before acting.</b> ` +
        `Do not reset passwords or MFA, grant access, or change accounts based on this ticket alone.</p>`,
      `<p>${escapeHtml(input.details.trim()).replace(/\r?\n/g, "<br>")}</p>`,
      "<table>",
      row("Stated name", input.stated_name),
      row("Stated company", input.stated_company),
      row("Callback number", input.callback_number),
      row("Caller ID", input.caller_id),
      row("Email given", input.email),
      row("Channel", input.channel === "chat" ? "Wilma chat" : "Wilma phone"),
      row("Why unverified", input.verification_issue),
      "</table>",
      `<p><i>Logged by Wilma (Wildix AI). Possible Halo matches are in a private note.</i></p>`,
    ].join("");

    const created = first(
      await this.halo.post<HaloTicket | HaloTicket[]>("/Tickets", [
        {
          summary,
          details_html: details,
          user_id: userId,
          client_id: this.cfg.HALO_UNVERIFIED_CLIENT_ID,
          site_id: this.cfg.HALO_UNVERIFIED_SITE_ID,
          tickettype_id: this.cfg.HALO_TICKETTYPE_ID,
          team_id: this.cfg.HALO_TEAM_ID,
          priority_id: this.cfg.HALO_PRIORITY_NORMAL, // unverified callers can't escalate
          source: this.cfg.HALO_TICKET_SOURCE_ID,
        },
      ]),
    );
    if (!created?.id) throw new Error("Halo did not return a ticket id");
    this.recentCreates.set(dedupeKey, { id: created.id, at: Date.now() });
    log("info", "unverified_ticket_created", { ticket_id: created.id, channel: input.channel });

    // Best effort: a failed lookup or note must not lose the ticket.
    try {
      const hints = await this.possibleMatches(input.stated_name, input.stated_company, phone, email);
      await this.halo.post("/Actions", [
        {
          ticket_id: created.id,
          outcome_id: this.cfg.HALO_UPDATE_OUTCOME_ID,
          note_html: `<p><b>Possible Halo matches (Wilma, for technician only):</b></p>${
            hints.length ? `<ul>${hints.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>` : "<p>None found.</p>"
          }<p><i>Matches are suggestions from what the caller said; confirm identity on callback before reassigning.</i></p>`,
          hiddenfromuser: true,
          sendemail: false,
        },
      ]);
    } catch (e) {
      log("warn", "unverified_hint_failed", { ticket_id: created.id, error: e instanceof Error ? e.message : String(e) });
    }

    const callback = input.callback_number?.trim();
    return {
      ticket_id: created.id,
      message:
        `Logged as ticket ${created.id}. Tell them a technician will confirm their identity and follow up` +
        (callback ? ` at ${callback}.` : ".") +
        " Do not share any other account or ticket information.",
    };
  }

  /** Loose matches for the technician: by caller ID, email, and stated name within the stated company. */
  private async possibleMatches(name: string, company: string | undefined, phone: string, email?: string) {
    const hints = new Map<number, string>();
    const describe = (u: HaloUser, why: string) =>
      hints.set(u.id, `${u.name ?? `${u.firstname ?? ""} ${u.surname ?? ""}`.trim()} — ${u.client_name ?? "?"} (user ${u.id}) — ${why}`);

    if (phone) {
      const hits = await this.searchUsers({ search: phone.slice(-4), search_phonenumbers: true }, 3);
      const cc = this.cfg.DEFAULT_COUNTRY_CODE;
      // Name first so a main line with hundreds of contacts stays cheap; fall back to anyone on the number.
      let onNumber = (await this.detailsForName(hits, name, (u) => !hasPhoneFields(u))).filter((u) =>
        userPhoneNumbers(u, cc).includes(phone),
      );
      let why = "caller ID and name match";
      if (!onNumber.length && hits.length <= 5) {
        onNumber = (await this.detailsForName(hits, undefined, (u) => !hasPhoneFields(u))).filter((u) =>
          userPhoneNumbers(u, cc).includes(phone),
        );
        why = "caller ID matches";
      }
      onNumber.forEach((u) => describe(u, why));
    }
    if (email) (await this.usersByEmail(email)).forEach((u) => describe(u, "email matches"));
    if (company) {
      const res = await this.halo.get<ClientList>("/Client", { search: company, count: 25 });
      const clients = (res?.clients ?? []).filter((c) => !c.inactive && companyMatches(company, c.name)).slice(0, 3);
      const last = normalizeText(name).split(" ").pop();
      for (const c of clients) {
        const users = last ? await this.searchUsers({ client_id: c.id, search: last }, 1) : [];
        const named = users.filter((u) => nameMatches(name, u));
        named.forEach((u) => hints.has(u.id) || describe({ ...u, client_name: u.client_name ?? c.name }, "name and company match"));
        if (!named.length) hints.set(-c.id, `Company "${c.name}" (client ${c.id}) matches; no contact by that name`);
      }
    }
    return [...hints.values()].slice(0, 10);
  }

  async addTicketUpdate(token: string, ticketId: number, note: string) {
    const id = this.identityFromToken(token);
    const t = await this.getOwnedTicket(id, ticketId);
    if (this.isClosed(t)) {
      throw new UserFacingError(
        `Ticket ${ticketId} is closed, so the update was not added. Offer to log a new ticket that references ticket ${ticketId}.`,
      );
    }
    const channel = id.m === "chat" ? "chat" : "phone";
    const body = [
      {
        ticket_id: ticketId,
        outcome_id: this.cfg.HALO_UPDATE_OUTCOME_ID,
        note_html:
          `<p><b>Update from ${escapeHtml(id.fn)} via Wilma (${channel}):</b></p>` +
          `<p>${escapeHtml(note.trim()).replace(/\r?\n/g, "<br>")}</p>`,
        hiddenfromuser: false,
        sendemail: false,
        new_status: this.cfg.HALO_UPDATE_NEW_STATUS_ID,
      },
    ];
    const created = first(await this.halo.post<HaloAction | HaloAction[]>("/Actions", body));
    log("info", "ticket_update_added", { user_ids: id.ids.map((r) => r.u), ticket_id: ticketId, action_id: created?.id });
    return { ticket_id: ticketId, message: `The update was added to ticket ${ticketId}. The assigned technician will see it.` };
  }
}

// ---------------- helpers ----------------

function first<T>(x: T | T[] | undefined): T | undefined {
  return Array.isArray(x) ? x[0] : x;
}

function firstName(name?: string): string | undefined {
  const n = (name ?? "").trim();
  return n ? n.split(/\s+/)[0] : undefined;
}

function listOr(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function verifiedBy(m: VerifiedIdentity["m"]): string {
  return m === "phone" ? "caller ID + name + company" : m === "email" ? "email + name + company" : "email one-time code (Wilma chat)";
}

function actionDate(a: HaloAction): number {
  const t = Date.parse(a.datetime ?? a.actiondatecreated ?? "");
  return Number.isNaN(t) ? 0 : t;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function actionText(a: HaloAction): string {
  if (a.note && a.note.trim()) return htmlToText(a.note);
  if (a.note_html && a.note_html.trim()) return htmlToText(a.note_html);
  return "";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
