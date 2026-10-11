import type { Config } from "./config.js";
import { log, RateLimiter } from "./audit.js";
import { HaloError, type HaloApi } from "./halo/client.js";
import type { ActionList, HaloAction, HaloTicket, HaloUser, TicketList, UserList } from "./halo/types.js";
import {
  companyMatches,
  hasPhoneFields,
  nameMatches,
  normalizePhone,
  signToken,
  TokenError,
  userPhoneNumbers,
  verifyToken,
  type VerifiedIdentity,
} from "./identity.js";

/** An error whose message is safe to show to Wilma / the end user. */
export class UserFacingError extends Error {}

export interface VerifyResult {
  verified: boolean;
  token?: string;
  first_name?: string;
  company?: string;
  expires_in_minutes?: number;
  message: string;
  next_step?: string;
}

const NOT_VERIFIED =
  "I wasn't able to verify the caller with the details provided. Do not reveal any account or ticket information.";
const TICKET_NOT_FOUND =
  "No ticket with that number was found on this person's account. Ask them to double-check the number, or offer to list their open tickets.";
const MAX_CANDIDATES = 25;

export class WilmaService {
  private readonly verifyLimiter: RateLimiter;
  private readonly recentCreates = new Map<string, { id: number; at: number }>();

  constructor(
    private readonly halo: HaloApi,
    private readonly cfg: Config,
  ) {
    this.verifyLimiter = new RateLimiter(cfg.VERIFY_ATTEMPTS_PER_15MIN, 15 * 60_000);
  }

  // ---------------- Identity ----------------

  private issue(user: HaloUser, method: VerifiedIdentity["m"]): VerifyResult {
    const firstName = user.firstname || (user.name ?? "").split(" ")[0] || "there";
    const token = signToken(
      { uid: user.id, cid: user.client_id ?? 0, sid: user.site_id, m: method, fn: firstName, cn: user.client_name ?? "" },
      this.cfg.TOKEN_SECRET,
      this.cfg.TOKEN_TTL_MIN,
    );
    log("info", "verify_success", { method, user_id: user.id, client_id: user.client_id });
    return {
      verified: true,
      token,
      first_name: firstName,
      company: user.client_name,
      expires_in_minutes: this.cfg.TOKEN_TTL_MIN,
      message: `Verified ${firstName} at ${user.client_name ?? "their company"}. Pass this token to the ticket tools for the rest of the conversation.`,
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

  private async getUser(id: number): Promise<HaloUser> {
    return this.halo.get<HaloUser>(`/Users/${id}`);
  }

  private async searchUsers(query: Record<string, string | number | boolean>): Promise<HaloUser[]> {
    const res = await this.halo.get<UserList>("/Users", {
      includeactive: true,
      includeinactive: false,
      count: 100,
      ...query,
    });
    return (res?.users ?? []).filter((u) => !u.inactive).slice(0, MAX_CANDIDATES);
  }

  private matchesCompany(company: string, u: HaloUser): boolean {
    return companyMatches(company, u.client_name) || companyMatches(company, u.site_name);
  }

  private async usersByEmail(email: string): Promise<HaloUser[]> {
    const wanted = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(wanted)) return [];
    const hits = await this.searchUsers({ search: wanted });
    const out: HaloUser[] = [];
    for (const hit of hits) {
      const u = hit.emailaddress === undefined ? await this.getUser(hit.id) : hit;
      const emails = [u.emailaddress, u.email2, u.email3].map((e) => (e ?? "").trim().toLowerCase());
      if (!u.inactive && emails.includes(wanted)) out.push(u);
    }
    return out;
  }

  async verifyCaller(
    input: { caller_id: string; full_name: string; company_name: string; email?: string },
    ip = "unknown",
  ): Promise<VerifyResult> {
    const cc = this.cfg.DEFAULT_COUNTRY_CODE;
    const phone = normalizePhone(input.caller_id, cc);
    this.rateLimit([`ip:${ip}`, `phone:${phone || input.caller_id}`, ...(input.email ? [`email:${input.email.toLowerCase()}`] : [])]);

    // 1) Caller ID → Halo user(s) with that number, then confirm name + company.
    if (phone) {
      const hits = await this.searchUsers({ search: phone.slice(-4), search_phonenumbers: true });
      const matched: HaloUser[] = [];
      for (const hit of hits) {
        const u = hasPhoneFields(hit) && hit.client_name !== undefined ? hit : await this.getUser(hit.id);
        if (u.inactive || !userPhoneNumbers(u, cc).includes(phone)) continue;
        if (nameMatches(input.full_name, u) && this.matchesCompany(input.company_name, u)) matched.push(u);
      }
      if (matched.length === 1) return this.issue(matched[0]!, "phone");
      log("info", "verify_phone_no_unique_match", { candidates: hits.length, matched: matched.length });
    }

    // 2) Fallback: email on file + name + company must all agree.
    if (input.email) {
      const matched = (await this.usersByEmail(input.email)).filter(
        (u) => nameMatches(input.full_name, u) && this.matchesCompany(input.company_name, u),
      );
      if (matched.length === 1) return this.issue(matched[0]!, "email");
      log("info", "verify_email_no_unique_match", { matched: matched.length });
      return { verified: false, message: NOT_VERIFIED, next_step: "Offer to have a technician call them back." };
    }

    return {
      verified: false,
      message: NOT_VERIFIED,
      next_step:
        "Ask the caller to confirm their full first and last name, company name, and the email address on their account, then call verify_caller again including the email.",
    };
  }

  async verifyChatUser(input: { email: string }, ip = "unknown"): Promise<VerifyResult> {
    this.rateLimit([`ip:${ip}`, `email:${input.email.toLowerCase()}`]);
    const matched = await this.usersByEmail(input.email);
    if (matched.length === 1) return this.issue(matched[0]!, "chat");
    log("info", "verify_chat_no_unique_match", { matched: matched.length });
    return {
      verified: false,
      message:
        matched.length > 1
          ? "That email is shared by more than one contact, so it can't be used to verify. Offer to have a technician follow up."
          : "That email address isn't registered with us. Do not reveal any account or ticket information; offer to have a technician follow up.",
    };
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
    if (t.user_id === id.uid) return true;
    return this.cfg.ALLOW_CLIENT_WIDE_TICKETS && !!id.cid && t.client_id === id.cid;
  }

  private isClosed(t: HaloTicket): boolean {
    return t.status_id !== undefined && this.cfg.HALO_CLOSED_STATUS_IDS.includes(t.status_id);
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
      log("warn", "ticket_ownership_denied", { user_id: id.uid, ticket_id: ticketId });
      throw new UserFacingError(TICKET_NOT_FOUND);
    }
    return t;
  }

  async listMyOpenTickets(token: string) {
    const id = this.identityFromToken(token);
    const res = await this.halo.get<TicketList>("/Tickets", {
      ...(this.cfg.ALLOW_CLIENT_WIDE_TICKETS ? { client_id: id.cid } : { user_id: id.uid }),
      open_only: true,
      count: 10,
      order: "lastactiondate",
      orderdesc: true,
    });
    // Defence in depth: never trust the filter alone.
    const tickets = (res?.tickets ?? []).filter((t) => this.owns(id, t) && !this.isClosed(t));
    log("info", "list_open_tickets", { user_id: id.uid, count: tickets.length });
    return {
      count: tickets.length,
      tickets: tickets.map((t) => ({
        ticket_id: t.id,
        summary: t.summary,
        status: t.status_name,
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
    log("info", "get_ticket_update", { user_id: id.uid, ticket_id: ticketId, notes: notes.length });
    return {
      ticket_id: t.id,
      summary: t.summary,
      status: t.status_name,
      is_closed: this.isClosed(t),
      assigned_to: firstName(t.agent_name) ?? "not yet assigned",
      opened: t.dateoccurred,
      last_updated: t.lastactiondate,
      recent_public_updates: notes,
    };
  }

  async createTicket(
    token: string,
    input: { summary: string; details: string; urgency?: "low" | "normal" | "high"; callback_number?: string },
  ) {
    const id = this.identityFromToken(token);
    const summary = input.summary.trim().slice(0, 200);

    // Guard against the LLM double-submitting the same request.
    const dedupeKey = `${id.uid}:${summary.toLowerCase()}`;
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
        user_id: id.uid,
        client_id: id.cid || undefined,
        site_id: id.sid,
        tickettype_id: this.cfg.HALO_TICKETTYPE_ID,
        team_id: this.cfg.HALO_TEAM_ID,
        priority_id: priority,
        source: this.cfg.HALO_TICKET_SOURCE_ID,
      },
    ];
    const created = first(await this.halo.post<HaloTicket | HaloTicket[]>("/Tickets", body));
    if (!created?.id) throw new Error("Halo did not return a ticket id");
    this.recentCreates.set(dedupeKey, { id: created.id, at: Date.now() });
    log("info", "ticket_created", { user_id: id.uid, client_id: id.cid, ticket_id: created.id, urgency: input.urgency });
    return {
      ticket_id: created.id,
      message: `Ticket ${created.id} has been logged for ${id.fn}. Read the ticket number back to them.`,
    };
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
    log("info", "ticket_update_added", { user_id: id.uid, ticket_id: ticketId, action_id: created?.id });
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
