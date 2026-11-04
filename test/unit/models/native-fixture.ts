export function messagesSse(
  input: {
    text?: string;
    tool?: { name: string } & ({ args: unknown } | { rawArgs: string });
    reasoning?: boolean;
  } = {},
): string {
  const event = (type: string, fields: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  let body = event('message_start', {
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 0 },
    },
  });
  let index = 0;
  if (input.reasoning) {
    body += event('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
    body += event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: 'internal reasoning' } });
    body += event('content_block_delta', {
      index,
      delta: { type: 'signature_delta', signature: 'native-signature-123' },
    });
    body += event('content_block_stop', { index });
    index++;
  }
  body += event('content_block_start', {
    index,
    content_block: input.tool
      ? { type: 'tool_use', id: 'call_test', name: input.tool.name, input: {} }
      : { type: 'text', text: '' },
  });
  body += event('content_block_delta', {
    index,
    delta: input.tool
      ? {
          type: 'input_json_delta',
          partial_json: 'rawArgs' in input.tool ? input.tool.rawArgs : JSON.stringify(input.tool.args),
        }
      : { type: 'text_delta', text: input.text ?? 'OK' },
  });
  body += event('content_block_stop', { index });
  body += event('message_delta', {
    delta: { stop_reason: input.tool ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: 20 },
  });
  return body + event('message_stop', {});
}
