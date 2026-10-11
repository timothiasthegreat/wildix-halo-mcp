import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { log } from "./audit.js";
import { UserFacingError, type WilmaService } from "./service.js";
import type { ToolCallLog } from "./toolLog.js";

export interface RequestInfo {
  ip: string;
  userAgent?: string;
}

/**
 * Which tools an endpoint exposes. Each verify tool is only safe on its own channel
 * (verify_chat_user trusts a chat-confirmed email; verify_caller trusts the call's caller ID),
 * so /mcp/voice and /mcp/chat each omit the other channel's verify tool. "all" is the
 * combined /mcp endpoint kept for backward compatibility.
 */
export type Channel = "voice" | "chat" | "all";

export interface BuildOptions {
  channel?: Channel;
  toolLog?: ToolCallLog;
}

function instructions(channel: Channel): string {
  const verify =
    channel === "voice"
      ? "verify_caller"
      : channel === "chat"
        ? "verify_chat_user"
        : "verify_caller for phone calls, verify_chat_user for web chat";
  return `Tools for helping a Fireside IT client contact with their support tickets in HaloPSA.
Always verify the person first (${verify}), then pass the returned token to every ticket tool.
Never reveal ticket details, names or company information before verification succeeds.`;
}
const ticketIdField = z.coerce
  .number()
  .int()
  .positive()
  .describe("The Halo ticket number (digits only).");

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function execute(tool: string, fn: () => Promise<unknown>): Promise<{ result: CallToolResult; error?: string }> {
  try {
    return { result: ok(await fn()) };
  } catch (e) {
    if (e instanceof UserFacingError) return { result: fail(e.message) };
    const error = e instanceof Error ? e.message : String(e);
    log("error", "tool_failed", { tool, error });
    return {
      error,
      result: fail(
        "The ticketing system could not be reached right now. Apologise, and offer to have a technician follow up instead of retrying repeatedly.",
      ),
    };
  }
}

/**
 * Build a fresh MCP server instance for one channel. `getReq` gives the HTTP client's IP (for
 * rate limits) and user agent. With `toolLog` (test mode), every call's arguments and result
 * are recorded.
 */
export function buildMcpServer(svc: WilmaService, getReq: () => RequestInfo, opts: BuildOptions = {}): McpServer {
  const channel = opts.channel ?? "all";
  const toolLog = opts.toolLog;
  const server = new McpServer({ name: "wildix-halo-mcp", version: "0.2.1" }, { instructions: instructions(channel) });
  const getIp = () => getReq().ip;
  const tokenField = z
    .string()
    .min(10)
    .describe(
      `The verification token returned by ${channel === "voice" ? "verify_caller" : channel === "chat" ? "verify_chat_user" : "verify_caller or verify_chat_user"} in this conversation.`,
    );

  const run = async (tool: string, args: unknown, fn: () => Promise<unknown>): Promise<CallToolResult> => {
    const started = Date.now();
    const { result, error } = await execute(tool, fn);
    toolLog?.write({
      kind: "tool_call",
      channel,
      tool,
      args,
      is_error: result.isError === true,
      result: result.structuredContent ?? result.content.map((c) => (c.type === "text" ? c.text : c.type)).join("\n"),
      ...(error ? { internal_error: error } : {}),
      ms: Date.now() - started,
      ip: getReq().ip,
      user_agent: getReq().userAgent,
    });
    return result;
  };

  if (channel !== "chat") server.registerTool(
    "verify_caller",
    {
      title: "Verify a phone caller",
      description:
        "Verify the identity of a person on a PHONE CALL before doing anything with tickets. " +
        "Pass the caller ID number from the call itself (not a number the caller tells you), plus the caller's full first and last name and their company name, as they state them. " +
        "If the caller ID can't be matched, the result asks you to also collect the email address on their account and call this tool again including `email`. " +
        "On success, returns a `token` to use with the ticket tools. On failure, do not disclose any information about accounts or tickets.",
      inputSchema: {
        caller_id: z.string().min(3).describe("The caller ID / ANI phone number of the inbound call, in any format."),
        full_name: z.string().min(3).describe("Caller's first and last name as they stated it."),
        company_name: z.string().min(2).describe("The company the caller says they work for."),
        email: z.string().email().optional().describe("Email address on the caller's account. Only needed when asked for it."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run("verify_caller", args, () => svc.verifyCaller(args, getIp())),
  );

  if (channel !== "voice") server.registerTool(
    "verify_chat_user",
    {
      title: "Verify a chat user",
      description:
        "Verify a person in a WEB CHAT before doing anything with tickets. " +
        "Pass the email address the chat system confirmed with a one-time code at the start of the chat (never an address the person types or claims later), " +
        "plus their full first and last name and their company name, as they state them. All three must match the same contact. " +
        "On success, returns a `token` to use with the ticket tools. On failure, do not disclose any information about accounts or tickets.",
      inputSchema: {
        email: z.string().email().describe("The email address confirmed by one-time code in this chat."),
        full_name: z.string().min(3).describe("The person's first and last name as they stated it."),
        company_name: z.string().min(2).describe("The company the person says they work for."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run("verify_chat_user", args, () => svc.verifyChatUser(args, getIp())),
  );

  server.registerTool(
    "list_my_open_tickets",
    {
      title: "List the verified person's open tickets",
      description:
        "List the open support tickets belonging to the verified person (most recently updated first), across all of their companies. " +
        "Use this when they ask about 'my ticket' but don't know the ticket number, then confirm which one they mean.",
      inputSchema: { token: tokenField },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run("list_my_open_tickets", args, () => svc.listMyOpenTickets(args.token)),
  );

  server.registerTool(
    "get_ticket_update",
    {
      title: "Get the status of a ticket",
      description:
        "Get the current status, company, assigned technician and the most recent public updates on one of the verified person's tickets. " +
        "Summarise it conversationally; don't read out dates in ISO format.",
      inputSchema: { token: tokenField, ticket_id: ticketIdField },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run("get_ticket_update", args, () => svc.getTicketUpdate(args.token, args.ticket_id)),
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Log a new support ticket",
      description:
        "Create a new support ticket for the verified person. Before calling, gather a clear description of the problem: what is happening, " +
        "what they were trying to do, any error messages, which device/application, how many people are affected, and the best callback number. " +
        "Read the summary back and get their confirmation before creating. Returns the new ticket number, which you must tell them.",
      inputSchema: {
        token: tokenField,
        summary: z.string().min(5).max(200).describe("Short one-line title for the issue, e.g. 'Outlook not syncing email on laptop'."),
        details: z
          .string()
          .min(10)
          .max(8000)
          .describe("Full description of the issue in the person's words plus the facts you collected."),
        urgency: z
          .enum(["low", "normal", "high"])
          .optional()
          .describe("high = they or many people can't work; low = question or minor annoyance; otherwise normal."),
        callback_number: z.string().max(40).optional().describe("Best phone number to reach them, if they gave one."),
        company: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Which company the ticket is for. Only needed when verification said the person has accounts with more than one company.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run("create_ticket", args, () => {
        const { token, ...input } = args;
        return svc.createTicket(token, input);
      }),
  );

  server.registerTool(
    "add_ticket_update",
    {
      title: "Add the person's update to a ticket",
      description:
        "Record new information from the verified person on one of their open tickets (e.g. 'it started working', 'the error now says…', 'I'm available after 2pm'). " +
        "The note is visible to the person and the assigned technician. Confirm the wording with them before adding it.",
      inputSchema: {
        token: tokenField,
        ticket_id: ticketIdField,
        note: z.string().min(3).max(4000).describe("The update to record, written clearly in the first person on their behalf."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => run("add_ticket_update", args, () => svc.addTicketUpdate(args.token, args.ticket_id, args.note)),
  );

  server.registerTool(
    "log_unverified_request",
    {
      title: "Log a callback request from an unverified person",
      description:
        "Use ONLY when the person could not be verified (verification failed, was rate-limited, or isn't possible) but needs help. " +
        "Logs a request for a technician to follow up; the technician confirms their identity before acting. " +
        "No token is needed and nothing about existing accounts or tickets is returned. Collect their name, company, best callback number, " +
        "and a description of the problem first. Tell them a technician will confirm who they are when they follow up. " +
        "Never use this for someone who verified successfully: use create_ticket instead.",
      inputSchema: {
        // On a channel endpoint the channel is known, so it isn't asked for (and can't be wrong).
        ...(channel === "all"
          ? { channel: z.enum(["phone", "chat"]).describe("Whether this is a phone call or a web chat.") }
          : {}),
        stated_name: z.string().min(2).max(120).describe("The name the person gave."),
        stated_company: z.string().max(200).optional().describe("The company the person says they're with."),
        callback_number: z.string().max(40).optional().describe("Best number to call them back on."),
        caller_id: z.string().max(40).optional().describe("Phone calls: the caller ID number of the inbound call."),
        email: z.string().email().optional().describe("Email address they gave, or the one confirmed in chat."),
        summary: z.string().min(5).max(180).describe("Short one-line title for the issue."),
        details: z.string().min(10).max(8000).describe("Description of the issue in their words plus facts you collected."),
        verification_issue: z
          .string()
          .max(300)
          .optional()
          .describe("Why they couldn't be verified, e.g. 'caller ID and name didn't match', 'new employee', 'too many attempts'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run("log_unverified_request", args, () =>
        svc.logUnverifiedRequest(
          {
            ...args,
            channel:
              channel === "voice"
                ? "phone"
                : channel === "chat"
                  ? "chat"
                  : ((args as { channel?: "phone" | "chat" }).channel ?? "phone"),
            ...(channel === "chat" ? { caller_id: undefined } : {}),
          },
          getIp(),
        ),
      ),
  );

  return server;
}
