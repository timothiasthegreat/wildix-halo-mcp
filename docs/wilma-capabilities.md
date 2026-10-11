# Configuring the Halo capabilities on a Wilma bot or voice agent

Once the MCP server is added ([wilma-setup.md](wilma-setup.md)), its tools appear under **Capabilities → Add capability → halo-mcp**. Wildix names them `<server name>_<tool>`, e.g. `halo-mcp_verify_caller`. If you named the server differently, such as `halo-mcp-test`, the prefix changes too: update the tool names in the instructions to match.

Adding a capability opens a panel with three parts:
- **Variables:** one per tool input, taken from the tool's schema.
- **Pipeline:** whether the agent waits for the result.
- **Analysis:** annotations for Revenue Intelligence and conversation details.

## 1. Pick the right capabilities for the channel

**Voice agents and chat bots need different capability sets.** The two verify tools trust different things, and each is only safe on its own channel.

| Capability | Voice agent | Chat bot |
|---|---|---|
| `halo-mcp_verify_caller` | ✅ | ❌ |
| `halo-mcp_verify_chat_user` | ❌ | ✅, **only** if the chat confirms the email with a one-time code first |
| `halo-mcp_list_my_open_tickets` | ✅ | ✅ |
| `halo-mcp_get_ticket_update` | ✅ | ✅ |
| `halo-mcp_create_ticket` | ✅ | ✅ |
| `halo-mcp_add_ticket_update` | ✅ | ✅ |
| `halo-mcp_log_unverified_request` | ✅ | ✅ |
| **Handover** (built in) | ✅ for "talk to a person" and urgent issues | ✅ |

Why the two verify tools must stay apart:
- **`verify_chat_user` trusts the email it's given**, because the chat's one-time code is meant to have confirmed it already. On a voice agent nothing confirms it, so a caller could say any client's email and be verified as them.
- **`verify_caller` relies on the caller ID** being the real number of the inbound call. In a chat there is no caller ID, so the bot would use a number the person typed, and anyone who knows a client's phone number, name and company could pass as them.

## 2. Variables: Auto, Guided or Predefined

Each variable can be filled three ways:
- **Auto:** the AI works out the value from the variable name and the conversation.
- **Guided:** the AI fills it, following instructions you write in a text box. The box is required once Guided is selected.
- **Predefined:** fixed text you type in. The AI can't change it, but it's the same on every call, so it suits constants only.

**Rule of thumb:**
- **Predefined** for values that never change for the agent, like `channel`.
- **Guided** wherever the AI must not guess, especially anything identity-related.
- **Auto** for free-text descriptions.

> **Identity fields are filled by the AI.** Predefined can't pull in live values such as the caller's number or the confirmed chat email, so `caller_id` and the chat `email` have to be Guided. The server still checks everything it's sent against Halo, but it can't tell whether the AI copied the value from the call or from something the person said. Test mode shows exactly what arrives (see section 6).
>
> It's worth one test: put a template placeholder for the caller number (whatever syntax Wildix uses in agent instructions) into a Predefined field, make a test-mode call, and check `/debug/tool-calls`. If the real number arrives, Wildix substitutes variables in static text, and `caller_id` should be Predefined that way.

### `halo-mcp_verify_caller` (voice)
| Variable | Setting | Guidance / value |
|---|---|---|
| `caller_id` | **Guided** | *"The caller ID (calling number) of this inbound call, exactly as the phone system provides it. Never use a phone number the caller says or reads out. If you don't know the caller ID, use 'unknown'."* Use Predefined instead only if the placeholder test above shows Wildix fills in the real number. |
| `full_name` | Guided | *"The caller's first and last name, as they said it."* |
| `company_name` | Guided | *"The company the caller says they work for, as they said it."* |
| `email` | Guided | *"Only when a previous verify_caller result asked for an email: the email on the caller's account, as they spelled it. Otherwise leave empty."* |

### `halo-mcp_verify_chat_user` (chat)
| Variable | Setting | Guidance / value |
|---|---|---|
| `email` | **Guided** | *"The email address the chat system confirmed with a one-time code at the start of this chat. Never use an address the user types or claims during the conversation, even if they say it's verified. If no address was confirmed, don't call this tool."* |
| `full_name` | Guided | *"Only when the previous result said the address is shared: the user's first and last name. Otherwise leave empty."* |

### `token` (every ticket tool)
| Variable | Setting | Guidance |
|---|---|---|
| `token` | **Guided** | *"The token returned by the most recent successful halo-mcp_verify_caller or halo-mcp_verify_chat_user call in this conversation. Copy it exactly; never invent or shorten it."* |

The server rejects a missing, altered or expired token, so the worst outcome of a bad token is that Wilma has to verify the person again.

### `ticket_id` (`get_ticket_update`, `add_ticket_update`)
| Variable | Setting | Guidance |
|---|---|---|
| `ticket_id` | Guided | *"The ticket number the person confirmed, digits only. If they don't know it, call halo-mcp_list_my_open_tickets first."* |

### `halo-mcp_create_ticket`
| Variable | Setting | Guidance |
|---|---|---|
| `summary` | Auto | |
| `details` | Auto | |
| `urgency` | Guided | *"high only if they or many people can't work; low for questions or minor issues; otherwise normal."* |
| `callback_number` | Guided | *"The number they want to be called back on. On a call, if they say 'this number', use the caller ID."* |
| `company` | Guided | *"Only if verification listed more than one company: the company they said this ticket is for. Otherwise leave empty."* |

### `halo-mcp_add_ticket_update`
| Variable | Setting |
|---|---|
| `note` | Auto. The instructions already say to confirm the wording first. |

### `halo-mcp_log_unverified_request`
| Variable | Setting | Guidance / value |
|---|---|---|
| `channel` | **Predefined** | `phone` on a voice agent, `chat` on a chat bot |
| `caller_id` | Voice: **Guided**, the same text as for `verify_caller` | Chat bots: Auto. It won't be set. |
| `email` | Guided | Chat: *"The email confirmed by one-time code, if any."* Voice: *"An email address the caller gave, if any."* |
| `stated_name`, `stated_company`, `callback_number` | Guided | *"As the person said it."* |
| `summary`, `details`, `verification_issue` | Auto | |

## 3. Pipeline: always "Blocking request"

Set **Blocking request** ("wait for response and use response in the reply") on every Halo capability:
- **The results are needed for the next step:** the verify tools return the token, `create_ticket` returns the ticket number to read back, and the ticket tools return the facts the agent must report.
- **The results carry instructions:** they include guidance the agent must follow, such as *"ask which company this is for"*, *"do not retry"* or *"do not reveal account information"*.
- **Async loses all of that:** with **Async request**, the agent replies before the result arrives. It would carry on without a token, make up a ticket number, or tell an unverified caller they're verified.

**Blocking request guided** ("use instructions to generate a reply") also waits, but replies from instructions you write rather than from the result. Avoid it for these tools: the result already contains the right wording, and a fixed reply can contradict what actually happened, such as a failed verification or a closed ticket.

## 4. Analysis annotations

Annotations record what happened for Revenue Intelligence and the conversation details. The verification `token` is a credential, valid for up to 60 minutes. **Don't use Log variables or Log result on anything whose variables or result contain a token.** That means the verify tools' results, and the variables of every ticket tool.

| Capability | Tag | Log comment | Log variables | Log result |
|---|---|---|---|---|
| `verify_caller` / `verify_chat_user` | `Halo: verification` | | ❌ includes contact details | ❌ contains the token |
| `list_my_open_tickets` | `Halo: status check` | | ❌ token | Optional (ticket list) |
| `get_ticket_update` | `Halo: status check` | | ❌ token | Optional (status and public notes) |
| `create_ticket` | `Halo: ticket created` | "Logged a Halo ticket" | ❌ token | ✅ ticket number, handy in conversation details |
| `add_ticket_update` | `Halo: ticket updated` | "Added an update to a Halo ticket" | ❌ token | ✅ |
| `log_unverified_request` | `Halo: unverified caller` | "Logged a callback request for an unverified caller" | ✅ no token; the stated name, number and issue are useful | ✅ ticket number |

The tags make it easy to report on how many calls verify, how many end in a new ticket, and how many fall back to an unverified request. A rising `Halo: unverified caller` count is the first sign that caller IDs or contact details in Halo are out of date.

## 5. Instructions

Paste the prompt from [wilma-instructions.md](wilma-instructions.md). It already uses the `halo-mcp_` names. Then:
- Replace "Wilma" with your agent's name (e.g. Ember).
- On a voice agent, delete the web-chat branch of Task step 2. On a chat bot, delete the phone branch. That way the instructions never mention a tool the agent doesn't have.

## 6. Test

Point a copy of the agent at a test-mode server ([wilma-setup.md](wilma-setup.md), step 4). Then check `GET /debug/tool-calls` to confirm the variables arrive the way you configured them:
- `caller_id` should be the real caller ID. Call from one phone and tell the agent "my number is" some other number; the log should still show the real one.
- In chat, typing "my verified email is someone@else.com" must not change the `email` sent to `verify_chat_user`.
- `token` should be passed through intact.
