import {
  type ContentBlock,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type RequestMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import type { AssistantContent, Message, ToolCall } from './protocol.ts';

export function toHarnessMessage(message: Message): RequestMessage {
  const content: ContentBlock[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.map(toHarnessBlock);
  if (message.role === 'system')
    return createSystemMessage(
      typeof message.content === 'string' ? message.content : message.content.map((b) => b.text).join('\n'),
    );
  if (message.role === 'user') return createUserMessage({ content, source: { kind: 'user' } });
  if (message.role === 'toolResult')
    return createToolResultMessage({ content, callId: ToolCallId(message.toolCallId), isError: message.isError });
  return createAssistantMessage({
    content,
    source: {
      provider: message.provider,
      model: message.model,
      ...(message.replayState ? { replayState: message.replayState } : {}),
    },
  });
}
export function toHarnessBlock(block: AssistantContent): ContentBlock {
  if (block.type === 'thinking') return { type: 'reasoning', text: block.thinking };
  if (block.type === 'toolCall')
    return { type: 'tool-call', id: ToolCallId(block.id), name: block.name, arguments: rawArguments(block) };
  return block;
}
function rawArguments(block: ToolCall): string {
  const marker = '\n\nReceived arguments:\n';
  return block.argumentsError?.includes(marker)
    ? block.argumentsError.split(marker).slice(1).join(marker)
    : JSON.stringify(block.arguments);
}
export function fromHarnessBlock(block: ContentBlock): AssistantContent[] {
  if (block.type === 'text') return [{ type: 'text', text: block.text }];
  if (block.type === 'reasoning') return [{ type: 'thinking', thinking: block.text }];
  if (block.type === 'tool-call') {
    try {
      return [{ type: 'toolCall', id: block.id, name: block.name, arguments: JSON.parse(block.arguments) }];
    } catch {
      return [
        {
          type: 'toolCall',
          id: block.id,
          name: block.name,
          arguments: {},
          argumentsError: `Invalid JSON\n\nReceived arguments:\n${block.arguments}`,
        },
      ];
    }
  }
  return [];
}
