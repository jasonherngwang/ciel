import { Agent } from "agents";
import type { Env, RegistryState, AgentConfig, AgentMetadata } from "./types";

// @ts-ignore - callable decorator is available at runtime
const callable = (opts?: { description?: string; stream?: boolean }) => {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    // Mark method as callable for Agents SDK
    if (!target.constructor.__callableMethods) {
      target.constructor.__callableMethods = [];
    }
    target.constructor.__callableMethods.push({ name: propertyKey, ...opts });
    return descriptor;
  };
};

export class AgentRegistry extends Agent<Env, RegistryState> {
  initialState: RegistryState = { agents: [] };

  async onStart() {
    // Enable WAL mode for better concurrency
    this.sql.exec("PRAGMA journal_mode=WAL");

    // Create tables
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        repo_url TEXT,
        branch TEXT,
        status TEXT NOT NULL DEFAULT 'provisioning',
        total_cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Load agents from SQLite into state
    const rows = this.sql.exec<{
      id: string;
      name: string;
      repo_url: string | null;
      branch: string | null;
      status: string;
      total_cost_usd: number;
      created_at: number;
      updated_at: number;
    }>("SELECT * FROM agents ORDER BY created_at DESC").toArray();

    this.setState({
      agents: rows.map((row) => ({
        id: row.id,
        name: row.name,
        repoUrl: row.repo_url,
        branch: row.branch,
        status: row.status,
        totalCostUsd: row.total_cost_usd,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  }

  @callable({ description: "Create a new agent" })
  async createAgent(config: AgentConfig): Promise<AgentMetadata> {
    // Validate agent name
    if (!config.name || typeof config.name !== "string") {
      throw new Error("Agent name is required");
    }

    const name = config.name.trim();
    if (!/^[a-zA-Z0-9-]+$/.test(name)) {
      throw new Error(
        "Agent name must contain only alphanumeric characters and hyphens"
      );
    }

    if (name.length < 1 || name.length > 64) {
      throw new Error("Agent name must be between 1 and 64 characters");
    }

    // Check uniqueness (case-insensitive)
    const existing = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM agents WHERE LOWER(name) = LOWER(?)",
        [name]
      )
      .one();

    if (existing && existing.count > 0) {
      throw new Error(`Agent name "${name}" is already taken`);
    }

    // Create agent metadata
    const id = crypto.randomUUID();
    const now = Date.now();
    const metadata: AgentMetadata = {
      id,
      name,
      repoUrl: config.repoUrl || null,
      branch: config.branch || null,
      status: "provisioning",
      totalCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Insert into SQLite
    this.sql.exec(
      `INSERT INTO agents (id, name, repo_url, branch, status, total_cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        metadata.id,
        metadata.name,
        metadata.repoUrl,
        metadata.branch,
        metadata.status,
        metadata.totalCostUsd,
        metadata.createdAt,
        metadata.updatedAt,
      ]
    );

    // Update state (triggers broadcast to all connected clients)
    this.setState({
      agents: [metadata, ...this.state.agents],
    });

    // Trigger provisioning on CielAgent DO
    const agentStub = this.env.CIEL_AGENT.get(this.env.CIEL_AGENT.idFromName(id));
    // Note: provision() will be called via WebSocket or RPC in CielAgent - for MVP we'll handle this in Phase 3

    return metadata;
  }

  @callable({ description: "Delete an agent" })
  async deleteAgent(id: string): Promise<void> {
    // Remove from SQLite
    this.sql.exec("DELETE FROM agents WHERE id = ?", [id]);

    // Update state
    this.setState({
      agents: this.state.agents.filter((a) => a.id !== id),
    });

    // Best-effort: call destroy() on CielAgent DO
    try {
      const agentStub = this.env.CIEL_AGENT.get(
        this.env.CIEL_AGENT.idFromName(id)
      );
      // @ts-expect-error - destroy is a callable method defined in CielAgent
      await agentStub.destroy();
    } catch (err) {
      // DO may already be evicted or destroyed - ignore
      console.warn(`Failed to destroy CielAgent ${id}:`, err);
    }
  }

  @callable({ description: "Update agent status and metadata" })
  async updateAgentStatus(
    id: string,
    status: string,
    metadata?: Partial<{
      totalCostUsd: number;
      lastError: string | null;
    }>
  ): Promise<void> {
    const now = Date.now();

    // Build update query
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const params: unknown[] = [status, now];

    if (metadata?.totalCostUsd !== undefined) {
      updates.push("total_cost_usd = ?");
      params.push(metadata.totalCostUsd);
    }

    params.push(id);

    this.sql.exec(
      `UPDATE agents SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    // Update state
    const updatedAgents = this.state.agents.map((a) =>
      a.id === id
        ? {
            ...a,
            status,
            updatedAt: now,
            ...(metadata?.totalCostUsd !== undefined && {
              totalCostUsd: metadata.totalCostUsd,
            }),
          }
        : a
    );

    this.setState({ agents: updatedAgents });
  }

  @callable({ description: "List all agents" })
  async listAgents(filter?: { status?: string }): Promise<AgentMetadata[]> {
    if (!filter?.status) {
      return this.state.agents;
    }

    return this.state.agents.filter((a) => a.status === filter.status);
  }

  @callable({ description: "Get decrypted GitHub token (internal use only)" })
  async getGitHubToken(): Promise<string | null> {
    const row = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'github_token'"
      )
      .one();

    if (!row) return null;

    // Decrypt token
    return await this.decryptToken(row.value);
  }

  @callable({ description: "Set encrypted GitHub token" })
  async setGitHubToken(token: string): Promise<void> {
    // Encrypt token
    const encrypted = await this.encryptToken(token);

    // Upsert into settings
    this.sql.exec(
      `INSERT INTO settings (key, value) VALUES ('github_token', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [encrypted]
    );
  }

  @callable({ description: "List GitHub repositories using stored token" })
  async listGitHubRepos(): Promise<
    { error?: string; repos?: Array<{ name: string; full_name: string; private: boolean }> }
  > {
    const token = await this.getGitHubToken();

    if (!token) {
      return { error: "token_missing" };
    }

    try {
      const response = await fetch("https://api.github.com/user/repos?per_page=100", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (response.status === 401 || response.status === 403) {
        // Token is invalid - clear it
        this.sql.exec("DELETE FROM settings WHERE key = 'github_token'");
        return { error: "token_invalid" };
      }

      if (!response.ok) {
        return { error: `github_error_${response.status}` };
      }

      const repos = await response.json() as Array<{ name: string; full_name: string; private: boolean }>;
      return { repos };
    } catch (err) {
      return { error: "network_error" };
    }
  }

  onStateChanged() {
    // Filter sensitive data before syncing to clients
    // (GitHub token is not in state, so nothing to filter for MVP)
  }

  // Encryption helpers using Web Crypto API (AES-GCM)
  private async encryptToken(plaintext: string): Promise<string> {
    const key = await this.getCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );

    // Return as "iv:ciphertext" (both base64)
    const ivB64 = btoa(String.fromCharCode(...iv));
    const ciphertextB64 = btoa(
      String.fromCharCode(...new Uint8Array(ciphertext))
    );
    return `${ivB64}:${ciphertextB64}`;
  }

  private async decryptToken(encrypted: string): Promise<string> {
    const [ivB64, ciphertextB64] = encrypted.split(":");
    if (!ivB64 || !ciphertextB64) {
      throw new Error("Invalid encrypted token format");
    }

    const key = await this.getCryptoKey();
    const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(ciphertextB64), (c) =>
      c.charCodeAt(0)
    );

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(plaintext);
  }

  private async getCryptoKey(): Promise<CryptoKey> {
    const keyHex = this.env.ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== 64) {
      throw new Error(
        "ENCRYPTION_KEY must be 64 hex characters (32 bytes for AES-256)"
      );
    }

    // Convert hex string to Uint8Array
    const keyBytes = new Uint8Array(
      keyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );

    return await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }
}
