import { Agent } from "agents";
import { getSandbox, parseSSEStream, type ExecEvent } from "@cloudflare/sandbox";
import type { Env, AgentState, AgentConfig, ChatMessage } from "./types";

// @ts-ignore - callable decorator
const callable = (opts?: { description?: string; stream?: boolean }) => {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    if (!target.constructor.__callableMethods) {
      target.constructor.__callableMethods = [];
    }
    target.constructor.__callableMethods.push({ name: propertyKey, ...opts });
    return descriptor;
  };
};

export class CielAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    status: "idle",
    repoUrl: null,
    branch: null,
    messages: [],
    totalCostUsd: 0,
    lastError: null,
  };

  private sequenceCounter = 0;

  async onStart() {
    // Enable WAL mode for better concurrency
    this.sql`PRAGMA journal_mode=WAL`;
    this.sql`PRAGMA busy_timeout=5000`;

    // Create tables
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq)
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        context_json TEXT,
        created_at INTEGER NOT NULL
      )
    `;

    // Restore sequence counter
    const maxSeqRows = this.sql<{ max_seq: number | null }>`
      SELECT MAX(seq) as max_seq FROM messages
    `;
    this.sequenceCounter = (maxSeqRows[0]?.max_seq || 0) + 1;

    // Load last 50 messages into state
    const recent = this.sql<{
      id: string;
      seq: number;
      type: string;
      content: string;
      created_at: number;
    }>`SELECT * FROM messages ORDER BY seq DESC LIMIT 50`.reverse();

    if (recent.length > 0) {
      this.setState({
        ...this.state,
        messages: recent.map((r) => ({
          id: r.id,
          type: r.type as any,
          content: r.content,
          ts: r.created_at,
          seq: r.seq,
        })),
      });
    }
  }

  @callable({ description: "Provision agent sandbox and clone repository" })
  async provision(config: AgentConfig): Promise<void> {
    try {
      this.setState({ ...this.state, status: "provisioning", lastError: null });
      this.log("info", "Starting provisioning", { config });

      // Get or create sandbox
      const sandbox = getSandbox(this.env.SANDBOX, this.id);

      // Wait for sandbox to be ready (basic health check)
      await this.statusMessage("Initializing sandbox...");

      // If repo URL provided, clone it
      if (config.repoUrl) {
        await this.statusMessage("Fetching GitHub token...");

        // Get GitHub token from registry
        const registry = this.env.AGENT_REGISTRY.get(
          this.env.AGENT_REGISTRY.idFromName("default")
        );
        // @ts-expect-error - getGitHubToken is callable
        const token = await registry.getGitHubToken();

        if (!token) {
          throw new Error("GitHub token not configured. Please set up your GitHub token first.");
        }

        // Validate repoUrl format to prevent command injection
        if (!/^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(config.repoUrl)) {
          throw new Error("Invalid repository URL format");
        }

        await this.statusMessage("Cloning repository...");

        // Clone with auth
        const cloneUrl = config.repoUrl.replace(
          "https://github.com/",
          `https://oauth2:${token}@github.com/`
        );

        const cloneResult = await sandbox.exec(
          `git clone ${cloneUrl} /workspace && cd /workspace && git config user.email "ciel@example.com" && git config user.name "Ciel Agent"`,
          { timeout: 300000 } // 5 min timeout
        );

        if (!cloneResult.success) {
          // Check if it's an auth error
          if (cloneResult.stderr.includes("Authentication failed") ||
              cloneResult.stderr.includes("could not read Username")) {
            throw new Error("Authentication failed - check your GitHub token");
          }
          throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
        }

        // Create or checkout branch
        const branchName = `ciel/${config.name}`;
        await this.statusMessage(`Setting up branch ${branchName}...`);

        const branchResult = await sandbox.exec(
          `cd /workspace && (git checkout ${branchName} 2>/dev/null || git checkout -b ${branchName})`
        );

        if (!branchResult.success) {
          throw new Error(`Failed to create branch: ${branchResult.stderr}`);
        }

        this.setState({
          ...this.state,
          repoUrl: config.repoUrl,
          branch: branchName,
        });
      }

      // Verify Python and Claude SDK
      await this.statusMessage("Verifying Python environment...");

      const pyResult = await sandbox.exec(
        `python3 -c 'import claude_agent_sdk; print("ok")'`
      );

      if (!pyResult.success) {
        throw new Error("Claude Agent SDK not available in sandbox");
      }

      // Provisioning complete
      this.setState({ ...this.state, status: "idle" });
      await this.statusMessage("Agent ready");

      // Notify registry
      await this.notifyRegistry("idle");

      this.log("info", "Provisioning complete");
    } catch (err: any) {
      this.log("error", "Provisioning failed", { error: err.message });
      this.setState({
        ...this.state,
        status: "failed",
        lastError: err.message || "Provisioning failed",
      });
      await this.notifyRegistry("failed");
      throw err;
    }
  }

  async onMessage(connection: any, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    try {
      const payload = JSON.parse(message);

      // Handle prompt messages
      if (payload.type === "prompt" && payload.content) {
        await this.executePrompt(payload.content);
      }
    } catch (err: any) {
      this.log("error", "Message handling failed", { error: err.message });
      await this.errorMessage(`Failed to process message: ${err.message}`);
    }
  }

  private async executePrompt(prompt: string): Promise<void> {
    // Validate status
    if (this.state.status !== "idle") {
      await this.errorMessage(
        "Agent is busy. Please wait for the current turn to complete."
      );
      return;
    }

    try {
      // Update status
      this.setState({ ...this.state, status: "running", lastError: null });
      await this.notifyRegistry("running");

      // Persist user message
      await this.persistMessage({
        id: crypto.randomUUID(),
        type: "user",
        content: prompt,
        ts: Date.now(),
        seq: this.sequenceCounter++,
      });

      // Get sandbox
      const sandbox = getSandbox(this.env.SANDBOX, this.id);

      // Check if sandbox needs warming up (check if workspace exists)
      const wsCheck = await sandbox.exec("test -d /workspace/.git || test -f /workspace/.ciel-ready");
      if (!wsCheck.success) {
        await this.statusMessage("Warming up sandbox...");

        // Re-provision: clone repo if needed
        if (this.state.repoUrl) {
          const registry = this.env.AGENT_REGISTRY.get(
            this.env.AGENT_REGISTRY.idFromName("default")
          );
          // @ts-expect-error
          const token = await registry.getGitHubToken();

          if (token) {
            const cloneUrl = this.state.repoUrl.replace(
              "https://github.com/",
              `https://oauth2:${token}@github.com/`
            );
            await sandbox.exec(`git clone ${cloneUrl} /workspace`, { timeout: 300000 });
          }
        } else {
          // Mark as ready for no-repo agents
          await sandbox.exec("touch /workspace/.ciel-ready");
        }
      }

      // Build history context (last ~20 messages)
      const history = await this.buildContextHistory();

      // Prepare stdin payload
      const stdinPayload = JSON.stringify({ prompt, history });

      // Execute via Claude Agent SDK
      await this.statusMessage("Thinking...");

      const stream = await sandbox.execStream("python3 /opt/ciel/run_prompt.py", {
        stdin: stdinPayload,
        env: { ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY },
        timeout: 600000, // 10 min timeout
      });

      // Parse and handle stream events
      for await (const event of parseSSEStream<ExecEvent>(stream)) {
        if (event.type === "stdout") {
          // Parse JSON lines
          const lines = event.data.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);

              // Validate message structure
              if (!msg.type || typeof msg.content !== "string") {
                this.log("warn", "Malformed message from runtime", { line });
                continue;
              }

              // Persist and broadcast
              await this.persistMessage({
                id: crypto.randomUUID(),
                type: msg.type,
                content: msg.content,
                ts: Date.now(),
                seq: this.sequenceCounter++,
              });

              // Handle result message (final message with cost)
              if (msg.type === "result" && msg.total_cost_usd !== undefined) {
                const newCost = this.state.totalCostUsd + msg.total_cost_usd;
                this.setState({ ...this.state, totalCostUsd: newCost });
                await this.notifyRegistry("idle", { totalCostUsd: newCost });
              }
            } catch (parseErr: any) {
              this.log("warn", "Failed to parse JSON line", { line, error: parseErr.message });
            }
          }
        } else if (event.type === "stderr") {
          // Log stderr
          this.log("warn", "Runtime stderr", { data: event.data });
        } else if (event.type === "complete") {
          if (event.exitCode !== 0) {
            throw new Error(`Runtime exited with code ${event.exitCode}`);
          }
        } else if (event.type === "error") {
          throw new Error(`Runtime error: ${event.error}`);
        }
      }

      // Execution complete
      this.setState({ ...this.state, status: "idle" });
      await this.notifyRegistry("idle");

    } catch (err: any) {
      this.log("error", "Prompt execution failed", { error: err.message });
      this.setState({
        ...this.state,
        status: "failed",
        lastError: err.message || "Execution failed",
      });
      await this.notifyRegistry("failed");
      await this.errorMessage(`Execution failed: ${err.message}`);
    }
  }

  private async persistMessage(msg: ChatMessage): Promise<void> {
    // Insert into SQLite
    this.sql`
      INSERT INTO messages (id, seq, type, content, created_at)
      VALUES (${msg.id}, ${msg.seq}, ${msg.type}, ${msg.content}, ${msg.ts})
    `;

    // Append to state (cap at 50)
    const updatedMessages = [...this.state.messages, msg].slice(-50);
    this.setState({ ...this.state, messages: updatedMessages });
  }

  private async buildContextHistory(): Promise<Array<{ type: string; content: string }>> {
    // Fetch last 20 conversational messages (exclude status/error)
    const rows = this.sql<{ type: string; content: string }>`
      SELECT type, content FROM messages
      WHERE type IN ('user', 'assistant_text', 'tool_use', 'tool_result')
      ORDER BY seq DESC LIMIT 20
    `.reverse();

    return rows;
  }

  private async statusMessage(content: string): Promise<void> {
    await this.persistMessage({
      id: crypto.randomUUID(),
      type: "status",
      content,
      ts: Date.now(),
      seq: this.sequenceCounter++,
    });
  }

  private async errorMessage(content: string): Promise<void> {
    await this.persistMessage({
      id: crypto.randomUUID(),
      type: "error",
      content,
      ts: Date.now(),
      seq: this.sequenceCounter++,
    });
  }

  private async notifyRegistry(status: string, metadata?: { totalCostUsd?: number }): Promise<void> {
    try {
      const registry = this.env.AGENT_REGISTRY.get(
        this.env.AGENT_REGISTRY.idFromName("default")
      );
      // @ts-expect-error - updateAgentStatus is callable
      await registry.updateAgentStatus(this.id, status, metadata);
    } catch (err: any) {
      this.log("warn", "Failed to notify registry", { error: err.message });
    }
  }

  private log(level: string, message: string, context?: any): void {
    const contextJson = context ? JSON.stringify(context) : null;
    this.sql`
      INSERT INTO logs (level, message, context_json, created_at)
      VALUES (${level}, ${message}, ${contextJson}, ${Date.now()})
    `;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: this.state.status,
        messageCount: this.state.messages.length,
        totalCostUsd: this.state.totalCostUsd,
      });
    }

    if (url.pathname === "/history") {
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const offset = parseInt(url.searchParams.get("offset") || "0");

      const rows = this.sql<{
        id: string;
        seq: number;
        type: string;
        content: string;
        created_at: number;
      }>`SELECT * FROM messages ORDER BY seq ASC LIMIT ${limit} OFFSET ${offset}`;

      return Response.json({
        messages: rows.map((r) => ({
          id: r.id,
          type: r.type,
          content: r.content,
          ts: r.created_at,
          seq: r.seq,
        })),
      });
    }

    return new Response("Not found", { status: 404 });
  }

  @callable({ description: "Destroy agent and cleanup resources" })
  async destroy(): Promise<void> {
    try {
      // Best-effort: destroy sandbox
      const sandbox = getSandbox(this.env.SANDBOX, this.id);
      // Sandbox SDK may not have explicit destroy - it will be GC'd by Cloudflare

      this.log("info", "Agent destroyed");
    } catch (err: any) {
      this.log("warn", "Destroy cleanup warning", { error: err.message });
    }
  }
}
