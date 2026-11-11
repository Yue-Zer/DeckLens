import type { ModelChatRequest, ModelMessage, ProviderProfile } from "@decklens/contracts";

export type ProviderRuntime = Pick<ProviderProfile, "protocol" | "baseUrl" | "model" | "timeoutMs" | "supportsStreaming" | "supportsVision">;

type ProviderError = Error & { code: string };

export async function completeWithProvider(profile: ProviderRuntime, apiKey: string | undefined, request: ModelChatRequest): Promise<string> {
  assertRequestCapabilities(profile, request, false);
  const response = await send(profile, apiKey, request, false);
  if (!response.ok) throw responseError(response.status, request);
  const body = await response.json() as Record<string, any>;
  const answer = profile.protocol === "ollama-chat"
    ? body.message?.content
    : body.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) throw providerError("PROVIDER_EMPTY_RESPONSE", "模型服务没有返回回答文本。");
  return answer.trim();
}

export async function* streamWithProvider(profile: ProviderRuntime, apiKey: string | undefined, request: ModelChatRequest): AsyncGenerator<string> {
  assertRequestCapabilities(profile, request, true);
  const response = await send(profile, apiKey, request, true);
  if (!response.ok) throw responseError(response.status, request);
  if (!response.body) throw providerError("PROVIDER_STREAM_UNAVAILABLE", "模型服务没有提供可读取的流式响应。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const token = parseStreamLine(profile.protocol, line);
        if (token) yield token;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const token = parseStreamLine(profile.protocol, buffer);
      if (token) yield token;
    }
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError" || (error as { name?: string })?.name === "TimeoutError") {
      throw providerError("PROVIDER_TIMEOUT", `模型请求超过 ${Math.ceil(profile.timeoutMs / 1000)} 秒，已超时。`);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function testProvider(profile: ProviderRuntime, apiKey: string | undefined): Promise<string> {
  return completeWithProvider(profile, apiKey, {
    messages: [{ role: "user", content: "只回复 OK" }],
    temperature: 0,
    maxTokens: 8,
  });
}

function assertRequestCapabilities(profile: ProviderRuntime, request: ModelChatRequest, streaming: boolean): void {
  if (profile.protocol === "anthropic-messages") {
    throw providerError("PROVIDER_PROTOCOL_RESERVED", "Anthropic Messages 协议适配器已预留，当前版本尚未接入。请先使用 OpenAI 兼容或 Ollama 配置。");
  }
  if (streaming && !profile.supportsStreaming) throw providerError("PROVIDER_STREAM_UNSUPPORTED", "当前模型配置未启用流式输出。请在供应商设置中开启流式能力，或关闭流式请求。");
  const hasImages = request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image"));
  if (hasImages && !profile.supportsVision) throw providerError("MODEL_VISION_UNSUPPORTED", "当前配置未标记视觉能力，无法发送图片。请选择支持视觉的模型并在配置中启用视觉能力。");
}

async function send(profile: ProviderRuntime, apiKey: string | undefined, request: ModelChatRequest, streaming: boolean): Promise<Response> {
  const endpoint = endpointFor(profile.protocol, profile.baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json", accept: streaming ? "text/event-stream, application/x-ndjson" : "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const messages = request.messages.map(message => normalizeMessage(profile.protocol, message));
  let body: Record<string, unknown>;
  if (profile.protocol === "ollama-chat") {
    body = {
      model: profile.model,
      messages,
      stream: streaming,
      ...(request.temperature === undefined ? {} : { options: { temperature: request.temperature } }),
      ...(request.maxTokens === undefined ? {} : { options: { ...(request.temperature === undefined ? {} : { temperature: request.temperature }), num_predict: request.maxTokens } }),
    };
  } else if (profile.protocol === "openai-chat") {
    body = {
      model: profile.model,
      messages,
      stream: streaming,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    };
  } else {
    throw providerError("PROVIDER_PROTOCOL_RESERVED", "当前协议适配器尚未接入。");
  }

  try {
    return await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(profile.timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "AbortError" || name === "TimeoutError") throw providerError("PROVIDER_TIMEOUT", `模型请求超过 ${Math.ceil(profile.timeoutMs / 1000)} 秒，已超时。`);
    throw providerError("PROVIDER_CONNECTION_FAILED", "无法连接模型服务。请检查本机网络、Base URL 和本地服务状态。");
  }
}

function endpointFor(protocol: ProviderProfile["protocol"], baseUrl: string): string {
  const base = new URL(baseUrl);
  const path = base.pathname.replace(/\/+$/, "");
  const suffix = protocol === "ollama-chat" ? "/api/chat" : "/chat/completions";
  base.pathname = `${path}${suffix}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function normalizeMessage(protocol: ProviderProfile["protocol"], message: ModelMessage): Record<string, unknown> {
  if (typeof message.content === "string") return { role: message.role, content: message.content };
  const text = message.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join("\n");
  const images = message.content.filter((part): part is { type: "image"; dataUrl: string } => part.type === "image").map(part => {
    const match = /^data:[^;,]+;base64,(.+)$/s.exec(part.dataUrl);
    if (!match) throw providerError("INVALID_IMAGE_INPUT", "图片输入必须是有效的 Base64 Data URL。");
    return match[1];
  });
  if (protocol === "ollama-chat") return { role: message.role, content: text, ...(images.length ? { images } : {}) };
  return {
    role: message.role,
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...message.content.filter(part => part.type === "image").map(part => ({ type: "image_url", image_url: { url: part.dataUrl } })),
    ],
  };
}

function parseStreamLine(protocol: ProviderProfile["protocol"], line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (protocol === "openai-chat") {
    if (!trimmed.startsWith("data:")) return undefined;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return undefined;
    let body: Record<string, any>;
    try { body = JSON.parse(data); } catch { throw providerError("PROVIDER_STREAM_INVALID", "模型服务返回了无法解析的流式数据。"); }
    const content = body.choices?.[0]?.delta?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
    return undefined;
  }
  let body: Record<string, any>;
  try { body = JSON.parse(trimmed); } catch { throw providerError("PROVIDER_STREAM_INVALID", "本地 Ollama 服务返回了无法解析的流式数据。"); }
  return typeof body.message?.content === "string" ? body.message.content : undefined;
}

function responseError(status: number, request: ModelChatRequest): ProviderError {
  if (status === 401 || status === 403) return providerError("PROVIDER_AUTH_FAILED", "模型服务鉴权失败。请检查 API Key 和供应商配置。");
  if (status === 404) return providerError("PROVIDER_MODEL_NOT_FOUND", "接口或模型不存在。请核对 Base URL、协议类型和模型名称。");
  if (status === 429) return providerError("PROVIDER_RATE_LIMITED", "模型服务请求频率或可用额度受限，请稍后重试或检查账户状态。");
  if (status >= 500) return providerError("PROVIDER_UPSTREAM_FAILED", `模型服务暂时不可用（HTTP ${status}）。`);
  if (status === 400 && request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image"))) {
    return providerError("MODEL_VISION_REJECTED", "模型服务拒绝了图片输入。请确认该具体模型支持视觉，并检查供应商是否接受当前图片格式。");
  }
  if (status === 400 && (request.temperature !== undefined || request.maxTokens !== undefined)) {
    return providerError("PROVIDER_PARAMETER_UNSUPPORTED", "模型服务拒绝了请求参数。该模型可能不支持温度或最大输出长度设置，请检查模型参数能力后重试。");
  }
  return providerError("PROVIDER_REQUEST_FAILED", `模型服务拒绝了请求（HTTP ${status}）。请检查协议、模型参数和配置。`);
}

function providerError(code: string, message: string): ProviderError {
  return Object.assign(new Error(message), { code });
}
