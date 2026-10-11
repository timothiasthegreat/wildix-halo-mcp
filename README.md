# wildix-halo-mcp

A small MCP server that gives the Wildix AI agent **Wilma** a few tightly scoped tools for HaloPSA. Wilma can verify a caller or chat user, list and read their open tickets, log a new ticket, and add an update to an open ticket. Nothing else is exposed.

```
Wilma ──(Streamable HTTP + Bearer key)──► wildix-halo-mcp ──(OAuth client credentials)──► HaloPSA API
```

## Tools

| Tool | Purpose |
|---|---|
| `verify_caller` | Phone: caller ID → Halo user, confirmed with the stated full name + company. Fallback when caller ID doesn't match: email on file + name + company. |
| `verify_chat_user` | Chat: email already confirmed by Wilma's one-time code → Halo user (plus the person's name when the address is a shared mailbox). |
| `list_my_open_tickets` | The verified person's open tickets. |
| `get_ticket_update` | Status, assigned tech and the latest **public** notes for one of their tickets. |
| `create_ticket` | New ticket for the verified person, using the configured type, team and priority. Takes a `company` when the person belongs to several. |
| `add_ticket_update` | Public note on one of their open tickets. |
| `log_unverified_request` | Callback request from someone who couldn't be verified. Filed under the Unknown client / General User, never the client they claim. Possible Halo matches go in a private note for the tech; the caller gets only a ticket number. |

### Security model
- **Verification tokens.** The verify tools return a short-lived (default 60 min) HMAC-signed token holding the Halo user, client and site IDs. Every ticket tool requires it. The LLM can't forge a token or skip verification, and the client/user IDs on tickets always come from the token, never from the model.
- **Shared contact details.** The server sorts every match into "same person" or "different people":
  - **Same person under several clients** (same name, same phone or email): one token covers all their records. Ticket lists span every company, and `create_ticket` asks which company. If the caller names a company that matches exactly one client, the token covers only that one.
  - **Different people on one office line:** the stated name picks the person. Two same-named people under the same client on that line count as ambiguous, and Wilma asks for the email.
  - **Shared mailbox in chat** (several people on one address): Wilma is asked for the person's name, and only the matching contact is verified.
  - Halo service accounts (alerting, PBX and firewall mailboxes) are excluded from every search and can never be verified or suggested as a match. This relies on the contact being flagged **Service Account** in Halo.
  - Phone searches page through results (up to 1,000 contacts on one number), and names are filtered before any record is fetched in full.
- **Unverified callers can leave a message, nothing more.** `log_unverified_request` needs no token, always files under the Unknown client / General User at normal priority, and carries an "UNVERIFIED CALLER" banner. It returns only the new ticket number. It is rate-limited per caller ID, email and IP (3 per hour) and capped at 30 per hour overall.
- **Ownership checks happen server-side.** A ticket must belong to the verified user, or to their client if `ALLOW_CLIENT_WIDE_TICKETS=true`. "Not yours" and "doesn't exist" return the same message.
- **Read filtering.** Reads use `excludeprivate` / `excludesys`, plus a client-side `hiddenfromuser` filter, so private notes never reach Wilma.
- **No enumeration.** A failed verification doesn't reveal who a number or email belongs to.
- **Rate limits.** Verification attempts are limited per IP, phone and email. Repeated bad API keys are throttled.
- **Clean logs.** JSON audit logs go to stdout with IDs and outcomes only, never note contents or secrets.

## Halo setup
1. **Agent:** create an agent such as "Wilma AI" with a role that can view/edit tickets and view users/clients. Tickets and notes are attributed to this agent.
2. **API application:** in *Configuration → Integrations → HaloPSA API → View Applications → New*:
   - Authentication method: **Client ID and Secret (Services)**
   - Login type: **Agent** → select the Wilma AI agent
   - Permissions: `read:tickets`, `edit:tickets`, `read:customers`
3. **IDs for `.env`:** collect the ticket type, team, priorities (low/normal/high), the action outcome for user updates, and optionally a ticket source and an "updated by user" status.

## Run locally
```bash
cp .env.example .env   # fill in values
npm install
npm test
npm run dev            # http://localhost:3000/mcp
npx @modelcontextprotocol/inspector   # Streamable HTTP, URL above, header Authorization: Bearer <MCP_API_KEY>
```

## Docker image
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) builds the image for linux/amd64 and linux/arm64 after the tests pass.
- **Where it pushes:** to Docker Hub on pushes to `main` (tags `latest` and `sha-<commit>`) and on version tags like `v1.2.3` (tags `1.2.3` and `1.2`).
- **Pull requests** are built but not pushed.
- **Setup:** in the repo's *Settings → Secrets and variables → Actions*, add:
  - `DOCKERHUB_USERNAME` (secret)
  - `DOCKERHUB_TOKEN` (secret): a Docker Hub access token with Read & Write scope
  - optionally `DOCKERHUB_IMAGE` (variable), to override the default `<DOCKERHUB_USERNAME>/wildix-halo-mcp`

  Until the secrets exist, the workflow builds without pushing.

## Deploy on Portainer
1. Use the published image: set `WILDIX_HALO_MCP_IMAGE=<dockerhub-user>/wildix-halo-mcp:latest`. Or build it on the host with `docker build -t wildix-halo-mcp:latest .`.
2. **Stacks → Add stack**, paste `docker-compose.yml`, and set the environment variables. Under *Environment variables*, choose **Load variables from .env file** and import a `portainer.env` file, which is git-ignored so secrets stay local. Make one by copying `.env.example` and removing the comment lines. Blank values fall back to the defaults in `docker-compose.yml`.
3. The stack publishes no host ports. It joins an existing external Docker network named by `PROXY_NETWORK` (default `proxy`), which your reverse proxy must also be on. Create it first if needed with `docker network create proxy`. Then point the proxy, with TLS, at `http://wildix-halo-mcp:3000`, e.g. `https://wilma-halo.example.com` → `wildix-halo-mcp:3000`. Only `/mcp` and `/healthz` are served (plus `/debug/tool-calls` in test mode).
4. Check it: `curl https://wilma-halo.example.com/healthz` should return `{"ok":true}`.

## Wilma configuration
- **Adding the server:** step by step, with a description to paste, in [docs/wilma-setup.md](docs/wilma-setup.md).
- **MCP server URL:** `https://wilma-halo.example.com/mcp`
- **Auth:** Bearer token `<MCP_API_KEY>`. A custom `X-API-Key` header also works.
- **Instructions:** start from [docs/wilma-instructions.md](docs/wilma-instructions.md). Wilma must pass the call's caller ID to `verify_caller`.

## Test mode (prompt development)
Set `TEST_MODE=true` to rehearse calls and chats with Wilma without touching real clients:
- **Confined to one test client.** Every user search, ticket read and write, and unverified request is restricted to `TEST_CLIENT_ID` (Fireside's "Test Co.", client 273). Ticket summaries are prefixed `[TEST]`. Tickets outside the test client are refused, even by ID.
- **Verification:**
  - `TEST_VERIFY_MODE=always` (default): callers who match a Test Co. contact verify as that contact. Anyone else, whatever name, number or email they give, verifies as `TEST_USER_ID` (Tester McTesterson, 338).
  - `TEST_VERIFY_MODE=match`: real matching against Test Co. contacts only, so you can rehearse failed verifications and the unverified-request flow.
- **Unverified requests** go to Test Co.'s General User (311) instead of the Unknown client.
- **Separate tokens.** Tokens issued in test mode are rejected in live mode and vice versa.
- **Verbose logging.**
  - `LOG_LEVEL` is forced to `debug`.
  - Every request from Wilma is appended to `TOOL_LOG_FILE` (default `/data/tool-calls.jsonl`, on the `wildix-halo-mcp-data` volume): `initialize`, `tools/list`, and each tool call with its exact arguments, result, errors and timing. Tokens are shortened in the log.
  - The file rotates to `.1` past `TOOL_LOG_MAX_MB`.
- **View the log:**
  - `GET /debug/tool-calls?limit=50` with the same Bearer key returns the latest entries. This endpoint exists only in test mode.
  - Or open a shell on the container in Portainer and `cat /data/tool-calls.jsonl`.

```bash
curl -s -H "Authorization: Bearer $MCP_API_KEY" "https://wilma-halo.example.com/debug/tool-calls?limit=20"
```

`/healthz` reports `"test_mode": true` while it's on. Prefer a separate test stack or Wilma agent rather than flipping a live one.

## Configuration reference
See [.env.example](.env.example). Notable settings:
- `HALO_CLOSED_STATUS_IDS`: statuses treated as closed (no updates allowed; hidden from the open list). Default `9`.
- `HALO_UPDATE_NEW_STATUS_ID`: optionally move a ticket to a status like "Customer Replied" when the user adds an update.
- `DEFAULT_COUNTRY_CODE`: used to normalise national-format numbers. Default `1` (NANP).

## License
[MIT](LICENSE)
