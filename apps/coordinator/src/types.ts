import type { Sandbox } from "@cloudflare/sandbox";

export type MessageType =
  | "user"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "result"
  | "error"
  | "status";

export interface ChatMessage {
  id: string;
  type: MessageType;
  content: string;
  ts: number;
  seq: number;
  metadata?: Record<string, any>;  // For tool_use: name, input, tool_use_id
}

export interface AgentState {
  agentId: string;
  name: string;
  status: "provisioning" | "idle" | "running" | "failed";
  repoUrl: string | null;
  branch: string | null;
  messages: ChatMessage[];
  totalCostUsd: number;
  lastError: string | null;
}

export interface AgentMetadata {
  id: string;
  name: string;
  repoUrl: string | null;
  branch: string | null;
  status: string;
  totalCostUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface RegistryState {
  agents: AgentMetadata[];
}

export interface AgentConfig {
  agentId: string;
  name: string;
  repoUrl?: string;
  branch?: string;
}

export interface Env {
  AGENT_REGISTRY: DurableObjectNamespace;
  CIEL_AGENT: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  ANTHROPIC_API_KEY?: string;
  ENCRYPTION_KEY: string;

  // Optional: Override for GLM/z.ai or other Anthropic-compatible APIs
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  API_TIMEOUT_MS?: string;

  // Assets binding for serving frontend
  ASSETS: Fetcher;
}
