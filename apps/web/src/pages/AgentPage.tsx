import { useState, useRef, useEffect } from "react";
import { useParams, Link } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { ChatMessageList } from "@/components/ChatMessageList";
import { ArrowLeft, Send, Loader2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ChatMessage {
  id: string;
  type: string;
  content: string;
  ts: number;
  seq: number;
}

interface AgentState {
  status: "provisioning" | "idle" | "running" | "failed";
  repoUrl: string | null;
  branch: string | null;
  messages: ChatMessage[];
  totalCostUsd: number;
  lastError: string | null;
}

export function AgentPage() {
  const { id } = useParams({ from: "/agent/$id" });
  const [prompt, setPrompt] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const connection = useAgent<AgentState>({
    agent: "CielAgent",
    name: id,
    onStateUpdate: (state) => {
      setAgentState(state);
      setIsConnecting(false);
    },
  });

  const registry = useAgent({
    agent: "AgentRegistry",
    name: "default",
  }) as any;

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [agentState?.messages]);

  const handleSend = () => {
    if (!prompt.trim()) return;
    if (agentState?.status !== "idle") return;

    // Send prompt via WebSocket
    connection.send(
      JSON.stringify({
        type: "prompt",
        content: prompt.trim(),
      })
    );

    setPrompt("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDelete = async () => {
    try {
      await registry.call("deleteAgent", [id]);
      window.location.href = "/";
    } catch (err) {
      console.error("Failed to delete agent:", err);
    }
  };

  if (isConnecting) {
    return (
      <div className="container mx-auto px-4 py-16">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!agentState) {
    return (
      <div className="container mx-auto px-4 py-16">
        <Card className="p-8 text-center">
          <h2 className="text-lg font-semibold">Agent not found</h2>
          <p className="text-sm text-muted-foreground mt-2">
            The agent may have been deleted.
          </p>
          <Link to="/">
            <Button className="mt-4">Back to Dashboard</Button>
          </Link>
        </Card>
      </div>
    );
  }

  const isIdle = agentState.status === "idle";
  const placeholderText = isIdle
    ? "Type your prompt here..."
    : agentState.status === "running"
    ? "Agent is running..."
    : agentState.status === "provisioning"
    ? "Agent is provisioning..."
    : "Agent has failed";

  return (
    <div className="h-[calc(100vh-73px)] flex flex-col">
      {/* Header */}
      <div className="border-b border-border">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/">
                <Button variant="ghost" size="icon">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold">{id}</h1>
                  <StatusBadge status={agentState.status} />
                </div>
                {agentState.repoUrl && (
                  <p className="text-sm text-muted-foreground font-mono">
                    {agentState.repoUrl.replace("https://github.com/", "")}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-sm text-muted-foreground">
                Cost: <span className="font-mono">${agentState.totalCostUsd.toFixed(4)}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {agentState.lastError && (
            <div className="mt-2 text-sm text-destructive">
              Error: {agentState.lastError}
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <ScrollArea ref={scrollRef} className="flex-1">
        <div className="container mx-auto px-4 py-4">
          {agentState.messages.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <div className="text-6xl mb-4">💬</div>
              <p>No messages yet. Send a prompt to get started.</p>
            </div>
          ) : (
            <ChatMessageList messages={agentState.messages} />
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t border-border">
        <div className="container mx-auto px-4 py-4">
          <div className="flex gap-2">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholderText}
              rows={3}
              className="resize-none"
            />
            <Button
              onClick={handleSend}
              disabled={!isIdle || !prompt.trim()}
              size="icon"
              className="h-full"
            >
              {agentState.status === "running" ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Delete Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this agent? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
