import {
  createCapabilityHost,
  type CapabilityHost
} from "@openclaw/capabilities";
import {
  createAgentRepository,
  createAuditEventRepository,
  createExecutionEventRepository,
  createExecutionRepository,
  createMessageRepository,
  createThreadRepository,
  type DatabaseConnection,
  type ExecutionEventRecord,
  type MessageRecord,
  type ThreadRecord
} from "@openclaw/db";
import { redactError, serializeSafeError, type ChatMessage, type LlmProvider } from "@openclaw/llm";
import { formatCitations, retrieveContext } from "@openclaw/memory";
import { redactSensitiveText, type AppConfig } from "@openclaw/shared";

export type ChatRunInput = {
  message: string;
  threadId?: string;
  agentId?: string;
};

export type ChatRuntimeEvent =
  | {
      type: "meta";
      data: {
        threadId: string;
        executionId: string;
        userMessageId: string;
        agentId: string;
      };
    }
  | {
      type: "delta";
      data: {
        content: string;
      };
    }
  | {
      type: "done";
      data: {
        threadId: string;
        executionId: string;
        assistantMessageId: string;
        citations: string[];
        retrievedChunkIds: string[];
      };
    }
  | {
      type: "error";
      data: ReturnType<typeof redactError>;
    };

export type ChatRuntime = {
  run(input: ChatRunInput): AsyncIterable<ChatRuntimeEvent>;
  listThreads(): ThreadRecord[];
  listThreadMessages(threadId: string): MessageRecord[];
  listExecutionEvents(executionId: string): ExecutionEventRecord[];
};

export function createChatRuntime(input: {
  config: AppConfig;
  database: DatabaseConnection;
  llmProvider: LlmProvider;
  capabilityHost?: CapabilityHost;
}): ChatRuntime {
  const agents = createAgentRepository(input.database);
  const threads = createThreadRepository(input.database);
  const messages = createMessageRepository(input.database);
  const executions = createExecutionRepository(input.database);
  const executionEvents = createExecutionEventRepository(input.database);
  const auditEvents = createAuditEventRepository(input.database);
  const capabilityHost = input.capabilityHost ?? createCapabilityHost({ database: input.database });

  return {
    async *run(request): AsyncIterable<ChatRuntimeEvent> {
      const agent =
        (request.agentId ? agents.getById(request.agentId) : null) ??
        agents.ensureDefault({ model: input.config.llm.chatModel });
      const thread =
        request.threadId !== undefined
          ? threads.getById(request.threadId)
          : threads.create({
              agentId: agent.id,
              title: createThreadTitle(request.message)
            });

      if (!thread) {
        throw new Error("Thread not found.");
      }

      const userMessage = messages.create({
        threadId: thread.id,
        role: "user",
        content: request.message
      });
      const execution = executions.create({
        threadId: thread.id,
        agentId: agent.id
      });

      auditEvents.record({
        action: "chat.run.started",
        targetType: "execution",
        targetId: execution.id,
        payloadJson: JSON.stringify({
          threadId: thread.id,
          agentId: agent.id,
          userMessageId: userMessage.id
        })
      });
      executionEvents.record({
        executionId: execution.id,
        type: "chat.started",
        payloadJson: JSON.stringify({
          threadId: thread.id,
          userMessageId: userMessage.id
        })
      });

      yield {
        type: "meta",
        data: {
          threadId: thread.id,
          executionId: execution.id,
          userMessageId: userMessage.id,
          agentId: agent.id
        }
      };

      try {
        const retrieval = await capabilityHost.execute({
          capabilityId: "memory.search",
          input: {
            query: request.message,
            limit: 6
          },
          subject: {
            agentId: agent.id
          },
          executionId: execution.id,
          metadata: {
            threadId: thread.id,
            userMessageId: userMessage.id
          },
          run(capabilityInput) {
            const searchInput = capabilityInput as { query: string; limit?: number };

            return retrieveContext({
              query: searchInput.query,
              limit: searchInput.limit,
              config: input.config,
              database: input.database,
              embeddingProvider: input.llmProvider
            });
          }
        });

        executionEvents.record({
          executionId: execution.id,
          type: "retrieval.completed",
          payloadJson: JSON.stringify({
            citations: retrieval.citations,
            retrievedChunkIds: retrieval.retrievedChunkIds
          })
        });

        const history = messages.listByThread(thread.id);
        const systemPrompt = buildSystemPrompt(agent.systemPrompt, retrieval.context);
        const chatMessages: ChatMessage[] = [
          ...(systemPrompt
            ? [
                {
                  role: "system" as const,
                  content: systemPrompt
                }
              ]
            : []),
          ...history.map((message) => ({
            role: message.role,
            content: redactSensitiveText(message.content)
          }))
        ];
        let assistantContent = "";

        for await (const delta of input.llmProvider.streamChat({
          messages: chatMessages,
          model: agent.model ?? input.config.llm.chatModel
        })) {
          if (delta.content) {
            assistantContent += delta.content;
            executionEvents.record({
              executionId: execution.id,
              type: "assistant.delta",
              payloadJson: JSON.stringify({ content: delta.content })
            });

            yield {
              type: "delta",
              data: {
                content: delta.content
              }
            };
          }
        }

        const citationBlock = formatCitations(retrieval.citations);

        if (citationBlock) {
          const citationDelta = `\n\n${citationBlock}`;
          assistantContent += citationDelta;
          executionEvents.record({
            executionId: execution.id,
            type: "assistant.citations",
            payloadJson: JSON.stringify({
              citations: retrieval.citations,
              retrievedChunkIds: retrieval.retrievedChunkIds
            })
          });

          yield {
            type: "delta",
            data: {
              content: citationDelta
            }
          };
        }

        const assistantMessage = messages.create({
          threadId: thread.id,
          role: "assistant",
          content: assistantContent,
          metadataJson: JSON.stringify({
            executionId: execution.id,
            agentId: agent.id,
            citations: retrieval.citations,
            retrievedChunkIds: retrieval.retrievedChunkIds
          })
        });

        threads.touch(thread.id);
        executions.complete(execution.id);
        executionEvents.record({
          executionId: execution.id,
          type: "chat.completed",
          payloadJson: JSON.stringify({
            assistantMessageId: assistantMessage.id,
            citations: retrieval.citations,
            retrievedChunkIds: retrieval.retrievedChunkIds
          })
        });
        auditEvents.record({
          action: "chat.run.completed",
          targetType: "execution",
          targetId: execution.id,
          payloadJson: JSON.stringify({
            threadId: thread.id,
            assistantMessageId: assistantMessage.id,
            citations: retrieval.citations,
            retrievedChunkIds: retrieval.retrievedChunkIds
          })
        });

        yield {
          type: "done",
          data: {
            threadId: thread.id,
            executionId: execution.id,
            assistantMessageId: assistantMessage.id,
            citations: retrieval.citations,
            retrievedChunkIds: retrieval.retrievedChunkIds
          }
        };
      } catch (error) {
        const safeError = redactError(error);

        executions.fail(execution.id);
        executionEvents.record({
          executionId: execution.id,
          type: "chat.error",
          payloadJson: serializeSafeError(error)
        });
        auditEvents.record({
          action: "chat.run.failed",
          targetType: "execution",
          targetId: execution.id,
          payloadJson: JSON.stringify(safeError)
        });

        yield {
          type: "error",
          data: safeError
        };
      }
    },
    listThreads() {
      return threads.list();
    },
    listThreadMessages(threadId) {
      return messages.listByThread(threadId);
    },
    listExecutionEvents(executionId) {
      return executionEvents.listByExecution(executionId);
    }
  };
}

function createThreadTitle(message: string): string {
  const title = message.trim().replace(/\s+/g, " ").slice(0, 80);

  return title.length > 0 ? title : "New chat";
}

function buildSystemPrompt(agentSystemPrompt: string | null, retrievalContext: string): string | null {
  const parts = [
    agentSystemPrompt ? redactSensitiveText(agentSystemPrompt) : null,
    retrievalContext
      ? [
          "Use the following validated local workspace context when it is relevant.",
          "The runtime will append the final Sources list; do not cite files that are not listed here.",
          redactSensitiveText(retrievalContext)
        ].join("\n\n")
      : null
  ].filter((part): part is string => typeof part === "string" && part.trim() !== "");

  return parts.length > 0 ? parts.join("\n\n") : null;
}
