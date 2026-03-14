export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  model: string;
  cost: number; // USD, calculated from token rates
}

export interface LLMProvider {
  name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  estimateCost(model: string, promptTokens: number, completionTokens: number): number;
}
