export type SourceTool = 'claude' | 'opencode' | 'codex';

export interface ModelInfo {
  provider: string;
  id: string;
  variant?: string;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheWrite?: number;
  cacheRead?: number;
  total?: number;
}

export type PartIR =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | FilePart
  | AgentPart
  | MetaPart;

export interface TextPart {
  kind: 'text';
  text: string;
}

export interface ReasoningPart {
  kind: 'reasoning';
  text: string;
  summary?: string;
}

export interface ToolCallPart {
  kind: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  kind: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
  truncated?: boolean;
}

export interface FilePart {
  kind: 'file';
  path: string;
  content?: string;
}

export interface AgentPart {
  kind: 'agent';
  name: string;
  prompt?: string;
}

export interface MetaPart {
  kind: 'meta';
  raw: unknown;
}

export interface MessageIR {
  id: string;
  parentId?: string;
  role: 'user' | 'assistant' | 'system' | 'developer';
  timestamp: number;
  model?: ModelInfo;
  tokens?: TokenUsage;
  finishReason?: string;
  parts: PartIR[];
}

export interface SessionIR {
  id: string;
  sourceTool: SourceTool;
  sourcePath?: string;
  title: string;
  cwd?: string;
  model?: ModelInfo;
  createdAt: number;
  updatedAt: number;
  messages: MessageIR[];
  metadata?: Record<string, unknown>;
}

export interface CompactOptions {
  reasoningMaxChars?: number;
  includeSystem?: boolean;
  includeToolOutput?: boolean;
  toolOutputTruncate?: number;
}
