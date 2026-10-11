import { z } from "zod";

const intList = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n)),
    );

const optInt = z.coerce.number().int().positive().optional();
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : /^(1|true|yes|on)$/i.test(v)));

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Auth between Wilma and this server
  MCP_API_KEY: z.string().min(24, "MCP_API_KEY must be at least 24 characters"),
  // Secret used to sign verification tokens handed to Wilma
  TOKEN_SECRET: z.string().min(32, "TOKEN_SECRET must be at least 32 characters"),
  TOKEN_TTL_MIN: z.coerce.number().int().positive().default(60),

  // Halo connection
  HALO_BASE_URL: z.string().url(), // e.g. https://yourco.halopsa.com/api
  HALO_AUTH_URL: z.string().url(), // e.g. https://yourco.halopsa.com/auth
  HALO_TENANT: z.string().optional(),
  HALO_CLIENT_ID: z.string().min(1),
  HALO_CLIENT_SECRET: z.string().min(1),
  HALO_SCOPE: z.string().default("read:tickets edit:tickets read:customers"),

  // Ticket defaults
  HALO_TICKETTYPE_ID: optInt,
  HALO_TEAM_ID: optInt,
  HALO_PRIORITY_LOW: optInt,
  HALO_PRIORITY_NORMAL: optInt,
  HALO_PRIORITY_HIGH: optInt,
  HALO_TICKET_SOURCE_ID: optInt,
  HALO_UPDATE_OUTCOME_ID: optInt,
  HALO_UPDATE_NEW_STATUS_ID: optInt, // optional: move ticket to this status when the user adds an update
  HALO_CLOSED_STATUS_IDS: intList("9"),

  // Unverified requests: filed under Halo's Unknown client / General User. Set
  // HALO_UNVERIFIED_USER_ID to an empty string to disable the tool.
  HALO_UNVERIFIED_USER_ID: z
    .string()
    .default("19")
    .transform((v) => (v.trim() === "" ? undefined : Number(v)))
    .pipe(z.number().int().positive().optional()),
  HALO_UNVERIFIED_CLIENT_ID: z.coerce.number().int().positive().default(1),
  HALO_UNVERIFIED_SITE_ID: z.coerce.number().int().positive().default(1),
  UNVERIFIED_REQUESTS_PER_HOUR: z.coerce.number().int().min(1).default(3), // per caller ID / email / IP
  UNVERIFIED_REQUESTS_GLOBAL_PER_HOUR: z.coerce.number().int().min(1).default(30),

  // Test mode: everything is confined to one Halo test client, and every tool call is
  // logged verbatim (arguments + results) to TOOL_LOG_FILE for prompt development.
  TEST_MODE: bool(false),
  TEST_CLIENT_ID: z.coerce.number().int().positive().default(273), // Fireside "Test Co."
  TEST_USER_ID: z.coerce.number().int().positive().default(338), // Tester McTesterson
  TEST_UNVERIFIED_USER_ID: z.coerce.number().int().positive().default(311), // Test Co. General User
  TEST_SITE_ID: z.coerce.number().int().positive().default(290), // Test Co. Main Office
  // always = anything that doesn't match a test contact verifies as TEST_USER_ID
  // match  = real matching, but only against the test client's contacts
  TEST_VERIFY_MODE: z.enum(["always", "match"]).default("always"),
  TOOL_LOG_FILE: z.string().default("/data/tool-calls.jsonl"),
  TOOL_LOG_MAX_MB: z.coerce.number().positive().default(20),

  // Behaviour
  DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/).default("1"),
  ALLOW_CLIENT_WIDE_TICKETS: bool(false),
  MAX_PUBLIC_NOTES: z.coerce.number().int().min(1).max(20).default(3),
  NOTE_CHAR_LIMIT: z.coerce.number().int().min(100).default(600),
  VERIFY_ATTEMPTS_PER_15MIN: z.coerce.number().int().min(1).default(5),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  // Test mode always logs verbosely.
  return parsed.data.TEST_MODE ? { ...parsed.data, LOG_LEVEL: "debug" } : parsed.data;
}
