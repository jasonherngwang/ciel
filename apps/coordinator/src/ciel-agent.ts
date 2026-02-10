import { Agent } from "agents";
import type { Env, AgentState } from "./types";

export class CielAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    status: "idle",
    repoUrl: null,
    branch: null,
    messages: [],
    totalCostUsd: 0,
    lastError: null,
  };
}
