# Ciel

Background agents running on the Cloudflare stack. Code runs in Sandboxes orchestrated by Durable Objects via the Agents SDK. Send prompts from the UI; agents clone repos, run Claude Code CLI, and stream results back over WebSockets.

- **[Containers / Sandboxes](https://sandbox.cloudflare.com/)** - Each agent gets an isolated Linux microVM controlled by Durable Objects.
- **[Agents SDK](https://agents.cloudflare.com/)** — Provides WebSocket management, state broadcasting, and `@callable` RPC. Two DO classes: a singleton AgentRegistry and per-agent CielAgents (state machine, chat history, sandbox orchestration).
- **[Worker Assets](https://developers.cloudflare.com/workers/static-assets/)** — Serves Vite/React SPA.
- **[Zero Trust Access](https://www.cloudflare.com/zero-trust/products/access/)** for Edge auth.

<p align="center">
  <img src="docs/architecture.svg" alt="Ciel Architecture" />
</p>
