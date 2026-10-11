# Adding the MCP server to Wilma

This connects a deployed `wildix-halo-mcp` container to Wilma. Before you start, you need:
- **The public HTTPS address** of the container, through your reverse proxy, e.g. `https://wilma-halo.example.com`. Check it with `curl https://wilma-halo.example.com/healthz`, which should return `{"ok":true}`.
- **The `MCP_API_KEY`** the container runs with, from your `portainer.env` or stack variables.

## 1. Add the server

In Wildix, open the **Add new MCP Server** form and fill it in:

| Field | Value |
|---|---|
| **Name** | `halo-mcp`. For a test-mode deployment, use a separate entry such as `halo-mcp-test`. |
| **Category** | `Default`, or whichever category you use for support tools |
| **Description** | Paste the text below |
| **Server URL** | `https://wilma-halo.example.com/mcp`. Version 0.1.1 and later also accept the bare domain, but `/mcp` is preferred. |
| **Authorization** | Bearer token with the `MCP_API_KEY` value (see below) |

### Description (paste this)

```text
Fireside IT Partners' HaloPSA ticketing system. Use it whenever someone wants to report an IT problem, check the status of a support ticket, or add information to an existing ticket. Always verify the person first: use verify_caller for phone calls (caller ID plus their stated name and company) or verify_chat_user for web chats (the email already confirmed by one-time code). Then pass the returned token to the ticket tools: list_my_open_tickets, get_ticket_update, create_ticket and add_ticket_update. If the person can't be verified, use log_unverified_request so a technician can confirm their identity and call them back. Never share account or ticket details with an unverified person.
```

### Authorization

The server accepts the key either way:
- **Bearer token** (preferred): choose the bearer or token option and paste the `MCP_API_KEY` value on its own, without the word "Bearer". Wildix sends `Authorization: Bearer <key>`.
- **Custom header**: if the dropdown only offers a header name and value, use one of these:
  - `Authorization` with the value `Bearer <MCP_API_KEY>`
  - `X-API-Key` with the value `<MCP_API_KEY>`

Choosing **None** won't work: the server returns `401 unauthorized` and Wildix can't discover the tools.

## 2. Enable the tools

Click **Next**. Wildix connects and lists the tools it found. Enable all seven:

| Tool | Used for |
|---|---|
| `verify_caller` | Verifying phone callers |
| `verify_chat_user` | Verifying web-chat users |
| `list_my_open_tickets` | Finding the person's open tickets |
| `get_ticket_update` | Reading a ticket's status and latest public updates |
| `create_ticket` | Logging a new ticket |
| `add_ticket_update` | Adding the person's information to an open ticket |
| `log_unverified_request` | Callback requests from people who couldn't be verified |

If no tools appear:
- **`Cannot POST /`** means the request reached the container without the `/mcp` path, and the image is 0.1.0. Add `/mcp` to the Server URL, or update to 0.1.1 or later, which answers at `/` too.
- Check that the key matches `MCP_API_KEY` exactly.
- Check the container logs in Portainer. A `mcp_auth_failed` entry means the key or header is wrong; no entry at all means the request isn't reaching the container (proxy or DNS).

## 3. Attach it to the agent and add the instructions

1. Add the `halo-mcp` server to the Wilma agent that answers your support calls and chats.
2. Paste the prompt from [wilma-instructions.md](wilma-instructions.md) into the agent's Instructions. Before saving:
   - Replace `{{caller_number}}` with Wilma's variable for the inbound caller ID.
   - Adjust the handover wording in Task step 7.

## 4. Test before going live

Run a second stack with `TEST_MODE=true`, add it as `halo-mcp-test` (steps 1–2), and attach it to a test copy of the agent:
- Every call and chat then works against Halo's "Test Co." only. Tickets are prefixed `[TEST]`.
- You can see exactly what Wilma sends to each tool:
  ```bash
  curl -s -H "Authorization: Bearer <MCP_API_KEY>" "https://<test-host>/debug/tool-calls?limit=20"
  ```

Try at least:
- A verified caller logging a ticket.
- A status check without a ticket number.
- Adding an update.
- A failed verification that ends in `log_unverified_request`.

See the README's *Test mode* section for details.
