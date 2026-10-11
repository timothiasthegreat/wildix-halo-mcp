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

## Deploy on Portainer
1. Build the image on the Docker host (`docker build -t wildix-halo-mcp:latest .`), or push it to your registry.
2. **Stacks → Add stack**, paste `docker-compose.yml`, and set the environment variables (see `.env.example`).
3. Publish it through your reverse proxy with TLS, e.g. `https://wilma-halo.example.com` → `wildix-halo-mcp:3000`. Only `/mcp` and `/healthz` are served.
4. Check it: `curl https://wilma-halo.example.com/healthz` should return `{"ok":true}`.

## Wilma configuration
- MCP server URL: `https://wilma-halo.example.com/mcp`
- Header: `Authorization: Bearer <MCP_API_KEY>` (`X-API-Key: <MCP_API_KEY>` also works)
- Instructions: start from [docs/wilma-instructions.md](docs/wilma-instructions.md). Wilma must pass the call's caller ID to `verify_caller`.

## Configuration reference
See [.env.example](.env.example). Notable settings:
- `HALO_CLOSED_STATUS_IDS`: statuses treated as closed (no updates allowed; hidden from the open list). Default `9`.
- `HALO_UPDATE_NEW_STATUS_ID`: optionally move a ticket to a status like "Customer Replied" when the user adds an update.
- `DEFAULT_COUNTRY_CODE`: used to normalise national-format numbers. Default `1` (NANP).
