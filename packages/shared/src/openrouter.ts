/**
 * OpenRouter API client for free model access.
 * Handles authentication, model selection, and API requests.
 */

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface OpenRouterResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Check if a model ID is an OpenRouter model.
 */
export function isOpenRouterModel(model: string): boolean {
  return model.startsWith("openrouter/");
}

/**
 * Extract the actual OpenRouter model ID from our prefixed format.
 * "openrouter/cohere/north-mini-code:free" -> "cohere/north-mini-code:free"
 */
export function extractOpenRouterModelId(model: string): string {
  if (!isOpenRouterModel(model)) {
    throw new Error(`Model ${model} is not an OpenRouter model`);
  }
  return model.slice("openrouter/".length);
}

/**
 * Create a chat completion request to OpenRouter.
 */
export async function createOpenRouterCompletion(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
  options: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stream?: boolean;
  } = {}
): Promise<OpenRouterResponse> {
  const modelId = isOpenRouterModel(model) ? extractOpenRouterModelId(model) : model;

  const requestBody: OpenRouterRequest = {
    model: modelId,
    messages,
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.7,
    top_p: options.topP ?? 0.9,
    stream: options.stream ?? false,
  };

  const referer = (typeof process !== "undefined" && (process.env.AUREX_PUBLIC_BASE_URL || process.env.VITE_PUBLIC_BASE_URL)) || "https://example.com";
  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": referer,
      "X-Title": "Aurex AI Agent Platform",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<OpenRouterResponse>;
}

/**
 * Stream a chat completion from OpenRouter.
 */
export async function* streamOpenRouterCompletion(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
  options: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  } = {}
): AsyncGenerator<string, void, unknown> {
  const modelId = isOpenRouterModel(model) ? extractOpenRouterModelId(model) : model;

  const requestBody: OpenRouterRequest = {
    model: modelId,
    messages,
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.7,
    top_p: options.topP ?? 0.9,
    stream: true,
  };

  const referer2 = (typeof process !== "undefined" && (process.env.AUREX_PUBLIC_BASE_URL || process.env.VITE_PUBLIC_BASE_URL)) || "https://example.com";
  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": referer2,
      "X-Title": "Aurex AI Agent Platform",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }
}

/**
 * Get available free models from OpenRouter API.
 */
export async function fetchOpenRouterFreeModels(apiKey: string): Promise<Array<{
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
  };
}>> {
  const response = await fetch(`${OPENROUTER_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch OpenRouter models: ${response.status}`);
  }

  const data = await response.json() as { data: Array<{
    id: string;
    name: string;
    context_length: number;
    pricing: { prompt: string; completion: string };
    architecture: {
      modality: string;
      input_modalities: string[];
      output_modalities: string[];
    };
  }> };

  return data.data.filter(
    (model) => model.pricing.prompt === "0" && model.pricing.completion === "0"
  );
}
