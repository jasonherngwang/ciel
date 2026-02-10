import { useState } from "react";
import { useAgent } from "agents/react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Loader2 } from "lucide-react";
import { CreateAgentDialog } from "@/components/CreateAgentDialog";
import { StatusBadge } from "@/components/StatusBadge";

interface AgentMetadata {
  id: string;
  name: string;
  repoUrl: string | null;
  branch: string | null;
  status: string;
  totalCostUsd: number;
  createdAt: number;
  updatedAt: number;
}

interface RegistryState {
  agents: AgentMetadata[];
}

export function DashboardPage() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [registryState, setRegistryState] = useState<RegistryState | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);

  useAgent<RegistryState>({
    agent: "AgentRegistry",
    name: "default",
    onStateUpdate: (state) => {
      setRegistryState(state);
      setIsConnecting(false);
    },
  });

  if (isConnecting) {
    return (
      <div className="container mx-auto px-4 py-16 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const agents = registryState?.agents || [];

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Agents</h1>
          <p className="text-muted-foreground mt-1">
            Manage your AI coding agents
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Agent
        </Button>
      </div>

      {agents.length === 0 ? (
        <Card className="py-16">
          <CardContent className="text-center space-y-4">
            <div className="text-6xl">🤖</div>
            <div>
              <h3 className="text-lg font-semibold">No agents yet</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Create your first agent to get started
              </p>
            </div>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              to="/agent/$id"
              params={{ id: agent.id }}
              className="block"
            >
              <Card className="hover:border-primary transition-colors cursor-pointer h-full p-4">
                <div className="space-y-3">
                  <div className="flex items-start justify-between">
                    <h3 className="font-semibold text-lg">{agent.name}</h3>
                    <StatusBadge status={agent.status} />
                  </div>
                  <div className="text-xs text-muted-foreground line-clamp-1">
                    {agent.repoUrl ? (
                      <span className="font-mono">
                        {agent.repoUrl.replace("https://github.com/", "")}
                      </span>
                    ) : (
                      <span>No repository</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-sm pt-2 border-t">
                    <span className="text-muted-foreground">Cost</span>
                    <span className="font-mono">
                      ${agent.totalCostUsd.toFixed(4)}
                    </span>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <CreateAgentDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </div>
  );
}
