# Adding the MCP server to Wilma

This connects a deployed `wildix-halo-mcp` container to Wilma. Before you start, you need:
- **The public HTTPS address** of the container, through your reverse proxy, e.g. `https://wilma-halo.example.com`. Check it with `curl https://wilma-halo.example.com/healthz`, which should return `{"ok":true}`.
- **The `MCP_API_KEY`** the container runs with, from your `portainer.env` or stack variables.

## Endpoints

The server has a separate endpoint for each channel. Each one lists only the tools that are safe on that channel:

| Endpoint | For | Verify tool |
|---|---|---|
| `/mcp/voice` | Voice agents | `verify_caller` only |
| `/mcp/chat` | Chat bots | `verify_chat_user` only |
| `/mcp` (and `/`) | Older setups | Both, so it relies on configuring each agent correctly |

**Add one MCP server entry per channel you use**, and give each agent only its own channel's entry. Then a voice agent can't be given the chat verify tool by mistake, or the other way round. Once nothing uses `/mcp`, set `MCP_ALLOW_COMBINED=false` on the container to switch it off.

## 1. Add the server entries

In Wildix, open the **Add new MCP Server** form once for each channel:

| Field | Voice entry | Chat entry |
|---|---|---|
| **Name** | `halo-mcp-voice` | `halo-mcp-chat` |
| **Category** | `Default`, or whichever category you use for support tools | same |
| **Description** | Paste the voice text below | Paste the chat text below |
| **Server URL** | `https://wilma-halo.example.com/mcp/voice` | `https://wilma-halo.example.com/mcp/chat` |
| **Authorization** | Bearer token with the `MCP_API_KEY` value (see below) | same |

The instructions in [wilma-instructions.md](wilma-instructions.md) assume these names. Wildix uses the name as the prefix for each tool (`halo-mcp-voice_verify_caller`), so if you name the entries differently, change the prefix in the instructions too. For a test-mode deployment, use names like `halo-mcp-test-voice`.

### Description: voice entry (paste this)

```text
Fireside IT Partners' HaloPSA ticketing system, for phone calls. Use it whenever a caller wants to report an IT problem, check the status of a support ticket, or add information to an existing ticket. Always verify the caller first with verify_caller (the call's caller ID plus their stated name and company). Then pass the returned token to the ticket tools: list_my_open_tickets, get_ticket_update, create_ticket and add_ticket_update. If the caller can't be verified, use log_unverified_request so a technician can confirm their identity and call them back. Never share account or ticket details with an unverified caller.
```

### Description: chat entry (paste this)

```text
Fireside IT Partners' HaloPSA ticketing system, for web chat. Use it whenever someone wants to report an IT problem, check the status of a support ticket, or add information to an existing ticket. Always verify the person first with verify_chat_user (the email confirmed by one-time code at the start of the chat, plus their stated name and company). Then pass the returned token to the ticket tools: list_my_open_tickets, get_ticket_update, create_ticket and add_ticket_update. If the person can't be verified, use log_unverified_request so a technician can confirm their identity and follow up. Never share account or ticket details with an unverified person.
```

### Authorization

The server accepts the key either way:
- **Bearer token** (preferred): choose the bearer or token option and paste the `MCP_API_KEY` value on its own, without the word "Bearer". Wildix sends `Authorization: Bearer <key>`.
- **Custom header**: if the dropdown only offers a header name and value, use one of these:
  - `Authorization` with the value `Bearer <MCP_API_KEY>`
  - `X-API-Key` with the value `<MCP_API_KEY>`

Choosing **None** won't work: the server returns `401 unauthorized` and Wildix can't discover the tools.

## 2. Enable the tools

Click **Next**. Wildix connects and lists the tools it found. Enable all six. Each entry has its own verify tool plus the same five ticket tools:

| Tool | Voice entry | Chat entry | Used for |
|---|---|---|---|
| `verify_caller` | ✅ | | Verifying phone callers |
| `verify_chat_user` | | ✅ | Verifying web-chat users |
| `list_my_open_tickets` | ✅ | ✅ | Finding the person's open tickets |
| `get_ticket_update` | ✅ | ✅ | Reading a ticket's status and latest public updates |
| `create_ticket` | ✅ | ✅ | Logging a new ticket |
| `add_ticket_update` | ✅ | ✅ | Adding the person's information to an open ticket |
| `log_unverified_request` | ✅ | ✅ | Callback requests from people who couldn't be verified |

If no tools appear:
- **`Cannot POST /`** means the request reached the container at `/` and the image is 0.1.0. Update to 0.2.0 or later and use the `/mcp/voice` or `/mcp/chat` URL.
- **`/mcp/voice` or `/mcp/chat` not found** means the image is older than 0.2.0. Update it.
- Check that the key matches `MCP_API_KEY` exactly.
- Check the container logs in Portainer. A `mcp_auth_failed` entry means the key or header is wrong; no entry at all means the request isn't reaching the container (proxy or DNS).

## 3. Attach it to the agent and add the instructions

1. Add the tools to your agent as **capabilities**: the voice entry's tools to the voice agent, the chat entry's tools to the chat bot. [wilma-capabilities.md](wilma-capabilities.md) covers:
   - the Auto/Guided/Predefined setting for each variable;
   - the pipeline (always **Blocking request**);
   - safe analysis annotations.
2. Paste the matching prompt from [wilma-instructions.md](wilma-instructions.md) into the agent's Instructions. Before saving:
   - Replace "Wilma" with your agent's name.
   - On the voice prompt, replace `{{caller_number}}` with Wilma's variable for the inbound caller ID.
   - Adjust the handover wording in Task step 7.

## 4. Test before going live

Run a second stack with `TEST_MODE=true` and add it as `halo-mcp-test-voice` and `halo-mcp-test-chat` (steps 1–2). Attach those to test copies of the agents:
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
