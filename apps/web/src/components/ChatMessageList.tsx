import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ChevronDown, ChevronRight } from "lucide-react";

interface ChatMessage {
  id: string;
  type: string;
  content: string;
  ts: number;
  seq: number;
  metadata?: Record<string, any>;
}

interface ChatMessageListProps {
  messages: ChatMessage[];
}

export function ChatMessageList({ messages }: ChatMessageListProps) {
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Group consecutive assistant_text messages into single bubbles
  const groupedMessages: Array<ChatMessage | { id: string; type: 'assistant_text_group'; content: string; ts: number; seq: number; messages: ChatMessage[] }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // If this is an assistant_text message, check if we should merge it
    if (msg.type === 'assistant_text') {
      const lastGrouped = groupedMessages[groupedMessages.length - 1];

      // If the last grouped item is also an assistant_text_group, merge into it
      if (lastGrouped && lastGrouped.type === 'assistant_text_group' && 'messages' in lastGrouped) {
        lastGrouped.content += msg.content;
        lastGrouped.messages.push(msg);
      } else {
        // Start a new group
        groupedMessages.push({
          id: msg.id,
          type: 'assistant_text_group',
          content: msg.content,
          ts: msg.ts,
          seq: msg.seq,
          messages: [msg]
        });
      }
    } else {
      // Not an assistant_text message, just add it as-is
      groupedMessages.push(msg);
    }
  }

  return (
    <div className="space-y-4">
      {groupedMessages.map((msg) => {
        const isExpanded = expandedMessages.has(msg.id);

        if (msg.type === "user") {
          return (
            <div key={msg.id} className="flex justify-end">
              <Card className="max-w-[80%] p-4 bg-primary text-primary-foreground">
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </Card>
            </div>
          );
        }

        if (msg.type === "assistant_text" || msg.type === "assistant_text_group") {
          return (
            <div key={msg.id} className="flex justify-start">
              <Card className="max-w-[80%] p-4">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </Card>
            </div>
          );
        }

        if (msg.type === "tool_use") {
          const toolName = msg.metadata?.name || "Unknown";
          const toolInput = msg.metadata?.input;

          return (
            <div key={msg.id} className="flex justify-start">
              <Card className="max-w-[80%] p-3 bg-muted">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleExpanded(msg.id)}
                  className="w-full justify-start p-0 h-auto font-normal"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 mr-2" />
                  ) : (
                    <ChevronRight className="h-4 w-4 mr-2" />
                  )}
                  <Badge variant="outline" className="mr-2">
                    Tool
                  </Badge>
                  <span className="text-sm font-mono">{toolName}</span>
                </Button>
                {isExpanded && toolInput && (
                  <pre className="mt-2 text-xs bg-background p-2 rounded overflow-x-auto">
                    {JSON.stringify(toolInput, null, 2)}
                  </pre>
                )}
              </Card>
            </div>
          );
        }

        if (msg.type === "tool_result") {
          const truncated = msg.content.length > 200;
          const displayContent = isExpanded
            ? msg.content
            : msg.content.slice(0, 200) + (truncated ? "..." : "");

          return (
            <div key={msg.id} className="flex justify-start">
              <Card className="max-w-[80%] p-3 bg-muted/50">
                <div className="flex items-start gap-2">
                  <Badge variant="secondary" className="shrink-0">
                    Result
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <pre className="text-xs whitespace-pre-wrap overflow-x-auto">
                      {displayContent}
                    </pre>
                    {truncated && (
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => toggleExpanded(msg.id)}
                        className="h-auto p-0 mt-1"
                      >
                        {isExpanded ? "Show less" : "Show more"}
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            </div>
          );
        }

        if (msg.type === "thinking") {
          return (
            <div key={msg.id} className="flex justify-start">
              <Card className="max-w-[80%] p-3 bg-muted/30">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleExpanded(msg.id)}
                  className="w-full justify-start p-0 h-auto font-normal"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 mr-2" />
                  ) : (
                    <ChevronRight className="h-4 w-4 mr-2" />
                  )}
                  <Badge variant="outline" className="mr-2">
                    Thinking
                  </Badge>
                  <span className="text-sm text-muted-foreground italic">
                    {isExpanded ? "" : "Claude's reasoning process"}
                  </span>
                </Button>
                {isExpanded && (
                  <div className="mt-2 text-sm text-muted-foreground italic whitespace-pre-wrap">
                    {msg.content}
                  </div>
                )}
              </Card>
            </div>
          );
        }

        if (msg.type === "result") {
          return (
            <div key={msg.id} className="flex justify-center">
              <div className="text-xs text-muted-foreground">
                {msg.content}
              </div>
            </div>
          );
        }

        if (msg.type === "error") {
          return (
            <div key={msg.id} className="flex justify-start">
              <Card className="max-w-[80%] p-4 bg-destructive/10 border-destructive">
                <div className="text-sm text-destructive">{msg.content}</div>
              </Card>
            </div>
          );
        }

        if (msg.type === "status") {
          return (
            <div key={msg.id} className="flex justify-center">
              <div className="text-xs text-muted-foreground italic">
                {msg.content}
              </div>
            </div>
          );
        }

        // Unknown message type
        return (
          <div key={msg.id} className="flex justify-start">
            <Card className="max-w-[80%] p-3">
              <Badge variant="outline">{msg.type}</Badge>
              <div className="mt-2 text-sm">{msg.content}</div>
            </Card>
          </div>
        );
      })}
    </div>
  );
}
