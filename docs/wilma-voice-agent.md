# Configuring the voice agent

This covers the WMS side of the phone channel: the **Voice AI Agent** and the **Voice Bot** dialplan application that sends calls to it. To connect the MCP server first, see [wilma-setup.md](wilma-setup.md). For the capability settings, see [wilma-capabilities.md](wilma-capabilities.md). The chat side is in [wilma-chat-widget.md](wilma-chat-widget.md).

Written from the live UI on `fireside-cloudsk` (WMS 7.09.20260929.2) on 2026-10-11. Wildix changes these screens often, so re-check field names after an upgrade.

## Where things are

- **PBX → Integrations → Cloud integrations → AI → Agents → Voice AI Agents:** the voice agents. This list is separate from Chat AI Agents.
- **Dialplan → Dialplan rules → (a procedure) → Add application → Services → Voice Bot:** the step that hands a call to a voice agent.
- **AI → Capabilities → Wilma Tools / Wilma Knowledge Base:** shared tools and knowledge sources. MCP server entries show up in the agent's **Add capability** menu, grouped by category.

## How a call flows

```
Inbound call ──► Dialplan procedure ──[Set VOICEBOT_* (optional)]──► Voice Bot app
                                                                       │ Voice Bot, Language, Voice,
                                                                       │ Background Sound, Welcome Message,
                                                                       │ Record Call With Agent
                                                                       ▼
                                                     Voice AI Agent "Support Agent" (Ember)
                                                       │ capabilities:
                                                       │  halo-mcp-voice_* (6 tools) ──► wildix-halo-mcp /mcp/voice ──► HaloPSA
                                                       │  Transfer ──► helpdesk extension or call group
                                                       │  Hangup, Wait
                                                       └ Traces: one row per call (caller, duration, language)
```

## 1. The Voice AI Agent

The agent page shows **Edit**, **Clone**, **Export** and **Delete**, plus **Traces**: one row per call, searchable by caller name, caller number or session ID. Unlike chat agents, voice agents have no API Keys section.

**Edit** has the following fields.

| Field | Options seen | Recommendation |
|---|---|---|
| **Name** | free text | `Ember (voice)`. The caller never hears this name; it identifies the agent in WMS and in Traces. |
| **Category** | free-text combobox; shown as `Default` in the list when empty | `Support`, the same as the chat bot. |
| **Integration Type** | Generative AI, Webhook, AWS SQS, Dialogflow CX | **Generative AI.** |
| **Instructions** | free text | Paste the **voice agent** prompt from [wilma-instructions.md](wilma-instructions.md), with "Wilma" replaced by "Ember" and `{{caller_number}}` replaced by `{{phoneNumber}}` (see section 2). |
| **Context chips** (under Instructions) | User Name, User Phone Number, User Email, User Company; **+ Add context** adds Session → Date & Time | Keep all four, and add **Date & Time**. Date & Time lets Ember say "yesterday" or "this morning" correctly. The four user chips are the PBX's own lookup of the caller, so treat them as hints, never as verification. Halo verification always goes through `verify_caller`. |
| **Variables** | Add variable → a `VARIABLE_NAME` row | Leave empty unless the dialplan sets `VOICEBOT_` variables (see section 2). |
| **First message** | free text. It's spoken first, and per-language first messages override it where the PBX supports them | *"Thanks for calling Fireside IT Partners. This is Ember, our virtual assistant. How can I help?"* Then make sure the prompt doesn't greet a second time (see section 4). |
| **Capabilities** | Delegate, Hangup, Wait, Transfer, plus each MCP server's tools | See section 3. |
| **1. Model** | Same list as chat: System `Default`; Gemini 3.1 Pro Preview, 3.8 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite; GPT-6 Sol, GPT-6 Luna; Deprecated | Start on `Default`, then pin a model that passes the test calls. Latency matters more on voice than in chat: try `Gemini 3.8 Flash` first, and avoid Preview models. |
| **2. Interruption Detection** | Enabled / Disabled (currently Enabled) | **Enabled.** Callers interrupt to correct a name or a digit, and Ember should stop talking when they do. |
| **3. Silence Timeout** | 3–600 s (currently 30 s); action **Hangup** or **Transfer** | **20 s → Transfer** to the helpdesk. Silence often means the caller is confused or struggling with the bot, not that they've gone. Ending the call loses them. |
| **4. Maximum Duration** | 10–3600 s (currently 1800 s); action Hangup or Transfer | **900 s (15 min) → Transfer.** Logging or checking a ticket takes 2–5 minutes, so a 15-minute call has gone wrong. Hand it to a person rather than hanging up on them. |
| **5. ACL Group** | PBX ACL group (none exist yet) | **Set one.** It controls who can read this agent's transcripts and **recordings**, which contain client names, emails and phone numbers. Use the same support-staff ACL group as the chat bot. |

## 2. Variables: getting the real caller ID

The voice editor's **Variables** tooltip lists runtime placeholders that are *"replaced with actual values during runtime … in instructions, first messages, and function parameters"*:

| Variable | Value |
|---|---|
| `{{phoneNumber}}` | Phone number of the caller |
| `{{name}}`, `{{firstName}}`, `{{lastName}}` | Caller's name, as the PBX knows it |
| `{{sessionId}}`, `{{callId}}`, `{{botId}}`, `{{flowIndex}}` | Session, call, bot and call-flow identifiers |
| `{{language}}`, `{{languageCode}}` | e.g. English / en-US |

Custom variables come from the dialplan: a **Set** application with a `VOICEBOT_` prefix. For example, `VOICEBOT_NAME` becomes `{{NAME}}`. Variable names are case-sensitive.

This answers the open question in [wilma-capabilities.md](wilma-capabilities.md): **`caller_id` can probably be Predefined as `{{phoneNumber}}`.**
- **Why it matters:** with the caller ID filled in by the PBX, the AI can't be talked into sending a number the caller reads out. That's the single biggest weakness of Guided.
- **Not yet confirmed:** the Predefined box itself still says "Enter static text", so make one test-mode call and check `/debug/tool-calls`.
  - **The real number arrives:** keep it Predefined.
  - **The literal text `{{phoneNumber}}` arrives:** go back to Guided, and use `{{phoneNumber}}` in the instructions instead, which the tooltip says is substituted.

Recommended settings:
- **`verify_caller.caller_id`:** **Predefined** `{{phoneNumber}}`.
- **`log_unverified_request.caller_id`:** **Predefined** `{{phoneNumber}}`.
- **Instructions:** replace `{{caller_number}}` with `{{phoneNumber}}`.
- **Everything else:** as in [wilma-capabilities.md](wilma-capabilities.md).

## 3. Capabilities on the voice agent

**Add capability** offers:
- The built-ins: **Delegate**, **Hangup**, **Wait** and **Transfer**. Handover and Suggestions are chat-only.
- The MCP server entries.

Each MCP tool on a voice agent has two things a chat tool doesn't:
- **Start Message:** *"Optional message spoken when the tool execution starts"*.
- **Pipeline:** the same four options as chat (Blocking request, Blocking request guided, Async request, Async request guided).

### Halo tools

**Add a `halo-mcp-voice` server entry first.** Today only `halo-mcp-chat` exists, so the voice agent would be offered the chat tools. Their `verify_chat_user` must never be used on a phone call (see [wilma-capabilities.md](wilma-capabilities.md)). Create the entry as in [wilma-setup.md](wilma-setup.md), pointed at `/mcp/voice`, then:
- Add all six `halo-mcp-voice_…` tools.
- Keep **Blocking request** on every one.
- Set variables as in section 2 and [wilma-capabilities.md](wilma-capabilities.md).

**Start Messages** fill the pause while Halo is queried. Callers can't see a typing indicator, so a few seconds of silence sounds like a dropped call.

| Tool | Start Message |
|---|---|
| `verify_caller` | *"Thanks, let me find your account."* |
| `list_my_open_tickets` | *"Let me pull up your open tickets."* |
| `get_ticket_update` | *"One moment while I check on that ticket."* |
| `create_ticket` | *"I'm logging that for you now."* |
| `add_ticket_update` | *"Adding that to the ticket now."* |
| `log_unverified_request` | *"I'll pass this along to the team now."* |

Keep them neutral. A Start Message plays *before* the result, so it must never imply success ("You're verified!").

### Transfer

Transfer has these fields:
- **Description** (required): tells the agent when to transfer.
- **Context** (required): the dialplan procedure to transfer into, e.g. `users`.
- **Destination**, one of:
  - **Predefined:** a fixed extension.
  - **Dynamic:** the AI picks an extension from context and instructions.
  - **Directory:** the AI looks the extension up in the organisation directory.
- **Extension** (required when Predefined).
- **Pipeline**, one of:
  - *Generate a reply and transfer the call after playback*
  - *Generate a reply as instructed and transfer the call after playback*
  - *Transfer the call without replying*
- **Analysis.**

Recommendation:
- **Destination: Predefined**, pointed at the helpdesk call group's number, in the context that reaches it (usually `users`).
- **Avoid Dynamic and Directory.** They let the caller talk Ember into ringing any extension, such as a named technician's mobile.
- **Pipeline:** *Generate a reply and transfer the call after playback*. Ember says what's happening, then transfers.
- **Description:** *"Transfer to the Fireside helpdesk when the caller asks for a person, is upset, needs urgent hands-on help, or the request is outside ticket logging and status. If they couldn't be verified, log an unverified request first unless they're upset or it's urgent."*
- **Analysis:** tag `Halo: transfer`.

There's no helpdesk call group yet (only Managers, TestGroup, Parking and 8006). Create one first, and use the same one for the Silence Timeout and Maximum Duration Transfer actions.

### Hangup, Wait and Delegate

- **Hangup** ("Ends call when you feel the conversation is complete"). **Keep it**, so Ember can end the call after the goodbye in Task step 8.
- **Wait** keeps Ember silent when a reply sounds cut off. **Add it**, with the description *"Wait for more input when the caller is partway through spelling an email, reading a number, or describing a problem and has paused."* Callers often pause mid-email or mid-number.
- **Delegate** forwards to another AI agent. **Leave it off.** A second agent wouldn't have the verification token.

## 4. The current agent on fireside-cloudsk (2026-10-11)

| Item | State | Action |
|---|---|---|
| Voice AI Agent `Support Agent` | Generative AI, no Category, Model Default, interruption Enabled, silence 30 s → Hangup, max 1800 s → Hangup, no ACL group, no traces | Settings as in section 1 |
| Its instructions | A **missed-call / voicemail-replacement prompt** (Ember takes a message or support details and "passes it along"; it falls back to voicemail on frustration; no Halo tools) | Replace with the voice prompt from [wilma-instructions.md](wilma-instructions.md). If the voicemail behaviour is still wanted after hours, keep it as a **separate agent** and choose between them in the dialplan by timetable |
| Capabilities | Hangup only | Add the `halo-mcp-voice_…` tools, Transfer and Wait |
| First message | *"Thanks for calling Fireside IT Partners. This is Ember, our virtual assistant, helping out…"*, while the prompt *also* says to speak first with a greeting | Keep the First message and change Task step 1 of the prompt to *"After the first message, listen for why they're calling"*, so Ember doesn't introduce herself twice |
| MCP entry `halo-mcp-voice` | **Missing** (only `halo-mcp-chat` exists) | Create it, pointed at `/mcp/voice` |
| Dialplan | `main` and `kite` are empty; the other procedures weren't checked, and with no traces the agent has likely never answered a call | Add a Voice Bot step as in section 5 |

## 5. Sending calls to the agent: the Voice Bot application

In a dialplan procedure, use **Add application → Services → Voice Bot**. Its fields:

| Field | Options seen | Recommendation |
|---|---|---|
| **Voice Bot** | the voice agents (`Support Agent`) | the Halo voice agent |
| **Language** | ar-XA, ca-ES, de-CH, de-DE, en-GB, **en-US**, es-ES, es-US, et-ET, eu-ES, fi-FI, fr-FR, hi-IN, it-IT, nl-NL, pt-PT, sv-SE, tr-TR | `en-US`, the closest match for Canadian English. There's no fr-CA. If French callers matter, test `fr-FR` on a separate IVR option |
| **Voice** | depends on Language | Pick one and keep it consistent; test it over a real phone line |
| **Background Sound** | -, background, class1, class2, default | `-` (none). Background audio hurts speech recognition on noisy mobile calls |
| **Welcome Message** | free text | Leave empty. The agent's First message already greets the caller, and both together means two greetings |
| **Record Call With Agent** | checkbox | **On**, if your call-recording notice covers it. Recordings make failed verifications and odd tool calls easy to diagnose. Lock them down with the ACL group |

Where to put it:
- **During business hours:** offer it as an IVR option (*"press 2 to log or check a ticket with our virtual assistant"*). Don't send every call to it.
- **After hours:** it can take every call, since Ember can log tickets and Transfer can fall back to the on-call number.
- **Wire it through a test number first.**

## 6. Test before going live

Use a test copy of the agent attached to the `halo-mcp-test-voice` entry ([wilma-setup.md](wilma-setup.md), step 4). Check `/debug/tool-calls` after each call:
- **Caller ID:** call from a known contact's number. `caller_id` must be the real caller ID. This tests `{{phoneNumber}}` as Predefined.
- **Spoofing:** say "my number is 555-0100". `caller_id` must not change.
- **Verified caller:** log a ticket and hear the ticket number read digit by digit.
- **Status check** without a ticket number.
- **Wrong company name:** this should end in `log_unverified_request`.
- **"Let me talk to a person":** the call should be transferred to the helpdesk group.
- **Silence:** stay silent for 20 s. The Silence Timeout Transfer should fire.
- **Pauses:** pause mid-email. Wait should keep Ember from jumping in.
- **Interrupting:** interrupt Ember mid-sentence. She should stop talking.
