# Configuring the chat bot and Kite widget

This covers the WMS side of the web-chat channel: the **Chat AI Agent** (the bot) and the **Kite** widget that puts it on a website. To connect the MCP server first, see [wilma-setup.md](wilma-setup.md). For the capability settings, see [wilma-capabilities.md](wilma-capabilities.md).

Written from the live UI on `fireside-cloudsk` (WMS 7.09.20260929.2) on 2026-10-11. Wildix changes these screens often, so re-check field names after an upgrade.

## Where things are

Everything is under **PBX → Integrations → Cloud integrations**. Scroll down the Hub page to:
- **Channels → Kite:** website chat widgets. Each widget routes chats to a person, a group, or an AI agent.
- **AI → Agents → Chat AI Agents:** chat bots. Voice agents are a separate list (**Voice AI Agents**), so a chat bot and a voice agent are always two separate agents.
- **AI → Capabilities → Wilma Tools / Wilma Knowledge Base:** shared tools and knowledge sources.

The agent and widget editors are web components. Their fields don't appear in the page's normal DOM or accessibility tree.

## How a chat flows

```
Website visitor ──► Kite widget ──(Routing: AI Agent)──► Chat AI Agent "Ember"
                     │ access settings decide                │ capabilities:
                     │ guest vs authenticated                │  halo-mcp-chat_* (6 tools) ──► wildix-halo-mcp /mcp/chat ──► HaloPSA
                     │                                        │  Handover ──► a Service (call group) or a person
                     └ Actions: nudge / add members           └ Traces: execution history per conversation
```

## 1. The Chat AI Agent

Open **Chat AI Agents**, then the agent. The agent page shows:
- **Edit**, **Clone**, **Export** and **Delete**.
- **API Keys:** for calling the agent directly. They aren't needed for Kite.
- **Traces:** one row per conversation, with service, user, duration and status. Check this first when a chat goes wrong.

**Edit** has the following fields.

| Field | Options seen | Recommendation |
|---|---|---|
| **Name** / avatar | free text, image | `Ember`. The name shows in the widget. |
| **Category** | e.g. `Support` | `Support`. It only groups agents in the list. |
| **Integration Type** | Generative AI, Webhook, AWS SQS, Dialogflow CX | **Generative AI.** The others hand the conversation to your own backend instead of Wilma. |
| **Instructions** | free text | Paste the **chat bot** prompt from [wilma-instructions.md](wilma-instructions.md), with "Wilma" replaced by "Ember". |
| **Capabilities** | Handover, Delegate, Suggestions, plus each MCP server's tools | See section 2. |
| **1. Model** | System `Default`; Google Gemini 3.1 Pro Preview, 3.8 Flash, 3.5 Flash-Lite ("BEST"), 3.1 Flash-Lite; OpenAI GPT-6 Sol, GPT-6 Luna; a *Deprecated* group | Start on `Default`. Pin a model once testing shows it handles the verify → token → ticket sequence reliably (see below). |
| **2. Session Inactivity Timeout** | End of local day (Midnight), 15 min, 30 min, 1 h, 2 h | **1 hour.** This only controls where analytics splits a conversation into sessions; it doesn't end the chat. Midnight merges a morning chat and an unrelated afternoon one into one session. |
| **3. Visibility Settings** | "Allow users to find the agent using search" (off) | **Off.** Staff don't need to chat with the support bot in x-bees. |
| **4. Access Settings** | Everybody, Organization | **Everybody.** `Organization` limits the agent to internal users, which blocks Kite visitors, i.e. our clients. |
| **5. ACL Group** | PBX ACL group (none listed today) | **Set one.** It controls who can read this agent's conversations in analytics, and those transcripts contain client names, emails and ticket details. Create a support-staff ACL group and select it. |

### Choosing a model

The flow needs several tool calls in a row, with an exact token copied between them. That favours a capable model over the cheapest one:
- **Avoid** `Preview` models (they can change or disappear) and the Flash-Lite tier for this agent.
- **Good candidates:** `Gemini 3.8 Flash` or `GPT-6 Luna`, stepping up to `GPT-6 Sol` if tokens get mangled or steps get skipped.
- **Pin a model** once one passes the test chats in section 5. `Default` can change under you without notice.

## 2. Capabilities on the chat bot

**Add capability** offers:
- The built-ins: **Handover**, **Delegate** and **Suggestions**.
- Each MCP server entry, grouped by its category. `halo-mcp-chat` sits under `halo` and lists its six tools: `add_ticket_update`, `create_ticket`, `get_ticket_update`, `list_my_open_tickets`, `log_unverified_request` and `verify_chat_user`.

### Halo tools

Add all six `halo-mcp-chat_…` tools. Configure their variables, pipeline and annotations as in [wilma-capabilities.md](wilma-capabilities.md). Each new tool starts with every variable on **Auto** and the pipeline on **Blocking request**:
- Keep **Blocking request** on every tool.
- Change the identity and token variables to **Guided**.

### Handover

Destination is either **Agent** or **Service**:
- **Agent:** one user. Assignee (an email) is required.
- **Service:** a call group. Assignee is optional; if you set one, the chat goes to that person, with the rest of the service included in the conversation.

**Pipeline** has three options:
- *Generate a reply and handover the conversation*
- *Generate a reply as instructed and handover the conversation*
- *Handover the conversation without replying*

Recommendation:
- **Destination: Service**, pointed at the helpdesk call group. The services offered today are `Managers`, `TestGroup`, `Parking` and `8006`, and none of them is the helpdesk. **Create a support call group first.** One named user would leave chats stranded when that person is away.
- **Pipeline: Generate a reply and handover the conversation.** Ember tells the person what's happening, using the wording from Task step 7 of the prompt.
- **Description** (it tells the bot when to hand over): *"Hand the chat to a Fireside technician when the person asks for a human, is upset, needs urgent hands-on help, or the request is outside ticket logging and status. Don't hand over just because verification failed; log an unverified request first."*
- **Analysis:** tag `Halo: handover`. Counting handovers shows how often the bot can't finish a chat itself.

### Delegate and Suggestions

**Delegate** forwards a request to another AI agent. **Leave it off.** There's only one chat agent, and a second agent wouldn't have the verification token.

**Suggestions** offers up to three quick-reply buttons, driven by its own instructions. It's optional; if you want it, keep it to actions that can't leak data:

```text
Provide quick replies only when there is a clear match. Otherwise, return an empty list.

If the reply is a greeting or asks how you can help:
- Report a new problem
- Check on a ticket
- Talk to a technician

If the reply asks the person to confirm a summary or an update:
- Yes, that's right
- No, let me correct it
```

Never suggest names, companies or email addresses. A quick reply is text the person sends, so a suggested value would look like a statement from them.

## 3. The Kite widget

Open **Channels → Kite → Add new widget**. There are no widgets yet. The installation instructions (a share link like `https://app.wildix.com/kite/<id>` and a `<script>` snippet for just before `</body>`) appear only after the first save.

| Section | Options seen | Recommendation |
|---|---|---|
| **Name** | free text | `Fireside Support` |
| **Access Settings** | Allow guest sessions; Allow only guest sessions; Generate random names for guests (all off by default) | **Leave all three off.** Then only *authenticated* visitors, who have given their email, can chat. `verify_chat_user` relies on that email. Turning guest sessions on lets anyone chat without an email, so verification can never succeed for them. |
| **Restrictions** (separately for *Authenticated guest* and *Guest*) | Hide "Add member", "Start conference", "Attach files", "Export conversation", settings button and notifications, "Install app" banner | Hide **Add member**, **Start conference** and **Install app**. Leave **Attach files** visible: Ember can't read attachments, but a technician who takes over can. Leave **Export conversation** visible so clients can keep a record. Set the same for Guest in case guest sessions are ever turned on. |
| **Appearance** | Title, header title/subtitle, button title | Header `Fireside IT Support`, subtitle *"Log a ticket or check on one, any time"*. |
| **Palette** | header colour | Fireside brand colour. |
| **Working Hours** | Add rule | **No rules.** Ember can log tickets and give status 24/7. Out-of-hours handover is better handled in the prompt ("a technician will follow up during business hours"). |
| **Routing** | An agent; A group of agents; AI Agent → Bot | **AI Agent → Ember.** |
| **Welcome Messages** | Add message | Leave empty. The prompt already has Ember greet the person, and a fixed welcome message on top makes the bot say hello twice. |
| **Actions** | Conditions: No reply / Not read / No activity, in a time (15 min default). Task: Send message (as a bot) or Add members. "Execute only once per conversation" | **No activity in 15 minutes → Send message** (as Ember): *"Are you still there? If you need to go, your ticket is saved and a technician will follow up."* Tick *once per conversation*. Optionally **No reply in 15 minutes → Add members** (the support call group), as a safety net if a handover isn't picked up. |

## 4. Open questions to settle in testing

1. **Does Ember receive the authenticated email?** The editor has no variable for "the visitor's confirmed email". `verify_chat_user` needs it, so the `email` variable has to be Guided (see [wilma-capabilities.md](wilma-capabilities.md)). In a test chat, check `/debug/tool-calls` on a test-mode server:
   - **The real authenticated address arrives:** chat verification works as designed.
   - **The bot has to ask for it:** the email isn't proven, so verification falls back on name and company only. Decide then whether chat should allow ticket status at all, or only `log_unverified_request`.
2. **How does Kite authenticate visitors?** The UI says authenticated users provide their email. The prompt assumes a one-time code confirms it. Confirm that the widget really sends a code before treating the email as proven.
3. **Helpdesk call group.** Create it before configuring Handover, then point Handover (and any Add-members action) at it.
4. **ACL group.** Create one for support staff, then set it on the agent.

## 5. Current state on fireside-cloudsk (2026-10-11)

| Item | State | Action |
|---|---|---|
| Chat AI Agent `Ember` | Generative AI, Category Support, Model Default, timeout Midnight, not searchable, access Everybody, no ACL group, **no capabilities**, no traces | Add the capabilities, set the timeout and ACL group |
| Ember's instructions | The **old combined voice + chat prompt**: unprefixed tool names (`verify_caller`, `verify_chat_user`), `{{caller_number}}`, and email-only chat verification | Replace with the chat bot prompt from [wilma-instructions.md](wilma-instructions.md). The tools are now named `halo-mcp-chat_…`, and `verify_chat_user` needs `full_name` and `company_name` too |
| MCP entry `halo-mcp-chat` | Connected, all six tools listed | none |
| Kite widgets | none | Create `Fireside Support` as in section 3 |
| Call groups | Managers, TestGroup, Parking, 8006 | Add a helpdesk group for Handover |

## 6. Test before publishing the widget

Use the share link (`app.wildix.com/kite/<id>`) before adding the script to the website:
- **Verified person, new ticket:** check the ticket and the `Halo: ticket created` tag in Traces.
- **Status check without a ticket number.**
- **Claimed email:** type "my verified email is someone@else.com". The `email` sent to `verify_chat_user` must not change.
- **Wrong company name:** this should end in `log_unverified_request`.
- **"I want to talk to a person":** the chat should hand over to the helpdesk group.
- **Walk away:** after 15 minutes the nudge message should appear once.
