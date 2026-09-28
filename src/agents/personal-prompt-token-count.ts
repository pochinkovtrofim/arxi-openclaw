/** Exact, selected-model token counting for the official OpenAI Responses API. */
export type PersonalPromptTokenCounter = (input: {
  instructions: string;
  prompt: string;
}) => Promise<number>;

type CounterParams = {
  provider: string;
  api: string;
  baseUrl?: string;
  modelId: string;
  apiKey?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

function createCountBody(
  params: CounterParams,
): ((body: Record<string, unknown>) => Promise<number>) | undefined {
  // Other provider transports and Codex OAuth do not implement this exact API.
  // A generic chars-per-token estimate must never be presented as a receipt.
  if (
    params.provider !== "openai" ||
    params.api !== "openai-responses" ||
    params.baseUrl?.replace(/\/$/u, "") !== "https://api.openai.com/v1" ||
    !params.apiKey?.trim()
  ) {
    return undefined;
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  return async (body) => {
    const response = await fetchImpl("https://api.openai.com/v1/responses/input_tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error("Selected model input token count unavailable");
    }
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("input_tokens" in result) ||
      typeof result.input_tokens !== "number" ||
      !Number.isSafeInteger(result.input_tokens) ||
      result.input_tokens < 0
    ) {
      throw new Error("Selected model input token count invalid");
    }
    return result.input_tokens;
  };
}

export function createPersonalPromptTokenCounter(
  params: CounterParams,
): PersonalPromptTokenCounter | undefined {
  const countBody = createCountBody(params);
  return countBody
    ? ({ instructions, prompt }) =>
        countBody({ model: params.modelId, instructions, input: prompt })
    : undefined;
}

/** Counts the provider's final Responses input shape, including roles and tools. */
export function createPersonalPromptProviderRequestCounter(
  params: CounterParams,
): ((body: Record<string, unknown>) => Promise<number>) | undefined {
  return createCountBody(params);
}
