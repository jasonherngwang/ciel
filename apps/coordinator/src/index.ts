import { routeAgentRequest } from "agents";
import type { Env } from "./types";

export { AgentRegistry } from "./agent-registry";
export { CielAgent } from "./ciel-agent";
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // Agent WebSocket and API routes
    if (url.pathname.startsWith("/agents")) {
      return (
        (await routeAgentRequest(request, env)) ??
        new Response("Not found", { status: 404 })
      );
    }

    // Serve frontend assets (SPA)
    // @ts-expect-error - ASSETS binding added via wrangler.jsonc
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
