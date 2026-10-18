/**
 * OllamaClient — zero-dependency HTTP client for the local Ollama runtime.
 * Works against http://localhost:11434 by default and supports LM Studio's
 * Ollama-compatible endpoint via a custom baseUrl.
 */

import type {
  GenerateOptions,
  GenerateResult,
  OllamaModel,
} from '../types';

const DEFAULT_TIMEOUT_MS = 120_000;

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'OllamaError';
  }
}

export class OllamaClient {
  constructor(
    private readonly baseUrl: string = 'http://127.0.0.1:11434',
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  /** Returns true when the Ollama server is reachable. */
  async isAlive(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        const res = await fetch(this.url('/api/version'), {
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /** Server version string, or throws when unreachable. */
  async version(): Promise<string> {
    const res = await this.rawFetch('/api/version');
    const body = (await res.json()) as { version?: string };
    return body.version ?? 'unknown';
  }

  /** List locally available models. */
  async listModels(): Promise<OllamaModel[]> {
    const res = await this.rawFetch('/api/tags');
    const body = (await res.json()) as { models?: Array<Record<string, unknown>> };
    const models = body.models ?? [];
    return models.map((m) => ({
      name: String(m.name ?? m.model ?? ''),
      size: typeof m.size === 'number' ? m.size : 0,
      parameter_size: (m.details as { parameter_size?: string } | undefined)
        ?.parameter_size,
      quantization_level: (m.details as { quantization_level?: string } | undefined)
        ?.quantization_level,
    }));
  }

  /** True if a model (exact or prefix match) is present locally. */
  async hasModel(modelName: string): Promise<boolean> {
    const models = await this.listModels();
    const needle = modelName.replace(/:latest$/, '');
    return models.some((m) => {
      const name = m.name.replace(/:latest$/, '');
      return name === needle || name.startsWith(`${needle}:`);
    });
  }

  /**
   * Pick the first configured model that exists locally; otherwise throw
   * with a helpful message.
   */
  async resolveModel(candidates: string[]): Promise<string> {
    const models = await this.listModels();
    const names = models.map((m) => m.name);
    for (const candidate of candidates) {
      const needle = candidate.replace(/:latest$/, '');
      const hit = names.find((n) => {
        const name = n.replace(/:latest$/, '');
        return name === needle || name.startsWith(`${needle}:`);
      });
      if (hit) return hit;
    }
    throw new OllamaError(
      `None of the preferred models are installed locally.\n` +
        `  Wanted: ${candidates.join(', ')}\n` +
        `  Installed: ${names.length ? names.join(', ') : '(none)'}\n` +
        `  Install one with: ollama pull ${candidates[0]}`,
    );
  }

  /** Blocking (non-streamed) generation. */
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const payload = {
      model: opts.model,
      prompt: opts.prompt,
      system: opts.system,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.2,
        top_p: opts.topP ?? 0.9,
        num_ctx: opts.numCtx ?? 8192,
        num_predict: opts.maxTokens ?? 512,
      },
    };

    const res = await this.rawFetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: opts.abortSignal,
    });

    const body = (await res.json()) as {
      response?: string;
      eval_count?: number;
      eval_duration?: number;
      done?: boolean;
    };

    const evalCount = body.eval_count ?? 0;
    const evalDurationMs = (body.eval_duration ?? 0) / 1e6;
    return {
      text: body.response ?? '',
      evalCount,
      evalDurationMs,
      tokensPerSecond:
        evalDurationMs > 0 ? evalCount / (evalDurationMs / 1000) : 0,
      done: body.done ?? true,
    };
  }

  /**
   * Streamed generation. Calls `onToken` for each decoded fragment.
   * Returns the concatenated text once [DONE] is reached.
   */
  async generateStream(
    opts: GenerateOptions,
    onToken: (fragment: string) => void,
  ): Promise<GenerateResult> {
    const payload = {
      model: opts.model,
      prompt: opts.prompt,
      system: opts.system,
      stream: true,
      options: {
        temperature: opts.temperature ?? 0.2,
        top_p: opts.topP ?? 0.9,
        num_ctx: opts.numCtx ?? 8192,
        num_predict: opts.maxTokens ?? 512,
      },
    };

    const res = await this.rawFetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: opts.abortSignal,
    });

    if (!res.body) {
      throw new OllamaError('Streaming response has no body.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let evalCount = 0;
    let evalDurationNs = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        let chunk: {
          response?: string;
          done?: boolean;
          eval_count?: number;
          eval_duration?: number;
        };
        try {
          chunk = JSON.parse(line);
        } catch {
          continue; // tolerate partial/keepalive lines
        }

        if (chunk.response) {
          full += chunk.response;
          onToken(chunk.response);
        }
        if (typeof chunk.eval_count === 'number') evalCount = chunk.eval_count;
        if (typeof chunk.eval_duration === 'number')
          evalDurationNs = chunk.eval_duration;
        if (chunk.done) {
          const evalDurationMs = evalDurationNs / 1e6;
          return {
            text: full,
            evalCount,
            evalDurationMs,
            tokensPerSecond:
              evalDurationMs > 0 ? evalCount / (evalDurationMs / 1000) : 0,
            done: true,
          };
        }
      }
    }

    return {
      text: full,
      evalCount,
      evalDurationMs: evalDurationNs / 1e6,
      tokensPerSecond: 0,
      done: true,
    };
  }

  private async rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Chain an upstream abort signal if provided.
    const upstream = init.signal;
    if (upstream) {
      if (upstream.aborted) controller.abort();
      else
        upstream.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
    }

    try {
      const res = await fetch(this.url(path), { ...init, signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new OllamaError(
          `Ollama request failed (${res.status} ${res.statusText}) on ${path}\n${text}`,
          res.status,
        );
      }
      return res;
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `Ollama request timed out after ${this.timeoutMs}ms`
          : `Cannot reach Ollama at ${this.baseUrl}. Is it running? Try: ollama serve`;
      throw new OllamaError(message, undefined, err);
    } finally {
      clearTimeout(timer);
    }
  }
}
