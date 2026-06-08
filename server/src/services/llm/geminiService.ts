import { config } from '../../config';
import { logger } from '../../utils/logger';

import { Readable } from 'stream';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Stream response from Gemini API using fetch with SSE.
 */
export async function* streamResponse(
  systemPrompt: string,
  history: Message[],
  abortSignal?: AbortSignal
): AsyncGenerator<string> {
  const apiKey = config.gemini.apiKey;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const model = config.gemini.model || 'gemini-2.5-flash';
  logger.info(`[GeminiService] streamResponse attempting call using model: ${model}`);

  // Format conversation history for Gemini:
  // - Merge consecutive messages of the same role to prevent Gemini API 400 Bad Request
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const m of history) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts[0].text += '\n' + m.content;
    } else {
      contents.push({
        role,
        parts: [{ text: m.content }],
      });
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const payload = {
    contents,
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {
      maxOutputTokens: 400,
    },
  };

  const controller = new AbortController();
  const onExternalAbort = () => {
    logger.info('[GeminiService] Client abort event received');
    controller.abort();
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  // 15-second connection timeout to prevent hanging models
  const timeoutId = setTimeout(() => {
    logger.warn(`[GeminiService] Connection timeout (15s) exceeded for model: ${model}`);
    controller.abort();
  }, 15000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    logger.info(`[GeminiService] fetch resolved with status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      logger.info('[GeminiService] response is not ok, reading error text...');
      const errText = await response.text();
      logger.error(`[GeminiService] Gemini error response text: "${errText}"`);
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    if (!response.body) {
      throw new Error('Response body is not readable');
    }

    logger.info('[GeminiService] response.body exists, converting to Node.js Readable stream');
    const nodeStream = Readable.fromWeb(response.body as any);
    const decoder = new TextDecoder();
    let buffer = '';

    let streamTimeoutId: NodeJS.Timeout | null = null;
    const resetStreamTimeout = () => {
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      streamTimeoutId = setTimeout(() => {
        logger.warn(`[GeminiService] Stream read timeout (15s) exceeded for model: ${model}`);
        nodeStream.destroy();
        controller.abort();
      }, 15000);
    };

    // Start stream read timeout before reading the body
    resetStreamTimeout();

    try {
      for await (const chunk of nodeStream) {
        if (abortSignal?.aborted || controller.signal.aborted) {
          logger.info('[GeminiService] Stream read aborted by client or controller');
          nodeStream.destroy();
          break;
        }

        // Reset the timeout on every chunk received
        resetStreamTimeout();

        const decodedChunk = decoder.decode(chunk, { stream: true });
        logger.debug(`[GeminiService] chunk ${chunk.length}B: "${decodedChunk.substring(0, 60).replace(/\r?\n/g, '\\n')}"`);
        
        buffer += decodedChunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (abortSignal?.aborted || controller.signal.aborted) {
            nodeStream.destroy();
            break;
          }

          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6).trim();
            if (jsonStr) {
              try {
                const data = JSON.parse(jsonStr);
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  yield text;
                }
              } catch (e) {
                // Ignore parse errors on incomplete chunk boundaries
              }
            }
          }
        }
      }
    } finally {
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      logger.info('[GeminiService] Stream reading loop ended');
    }
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (abortSignal?.aborted) {
      return;
    }
    logger.error(`[GeminiService] Model ${model} failed or timed out:`, err);
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Make a one-shot call to Gemini API.
 * Enforces a 30-second timeout to prevent indefinitely hanging analysis.
 */
export async function analyzeCall(prompt: string): Promise<string> {
  const apiKey = config.gemini.apiKey;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const model = config.gemini.model || 'gemini-2.5-flash';
  logger.info(`[GeminiService] analyzeCall attempting call using model: ${model}`);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Unexpected response format from Gemini');
    }
    clearTimeout(timeoutId);
    return text;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      logger.error(`[GeminiService] analyzeCall timed out on model ${model} after 30 seconds`);
    } else {
      logger.error(`[GeminiService] analyzeCall failed on model ${model}:`, err);
    }
    throw err;
  }
}

