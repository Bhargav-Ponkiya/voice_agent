import { logger } from './logger';

/**
 * Clean and repair a JSON string that might be truncated or malformed.
 */
export function repairJson(str: string): string {
  let cleaned = str
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!cleaned) return '{}';

  let inString = false;
  let isEscaped = false;
  const stack: string[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}' || char === ']') {
        const lastIndex = stack.lastIndexOf(char);
        if (lastIndex !== -1) {
          stack.splice(lastIndex, 1);
        }
      }
    }
  }

  if (inString) {
    if (isEscaped) {
      cleaned = cleaned.slice(0, -1);
    }
    cleaned += '"';
  }

  cleaned = cleaned.trim();

  // If stack top is '}', we are inside an object. Check for trailing key without value.
  if (stack[stack.length - 1] === '}') {
    const lastColon = cleaned.lastIndexOf(':');
    const lastComma = cleaned.lastIndexOf(',');
    const lastBrace = cleaned.lastIndexOf('{');
    const maxSeparator = Math.max(lastComma, lastBrace);

    if (maxSeparator > lastColon) {
      // We have a key after a comma or brace, but no colon.
      // Remove the incomplete key.
      if (maxSeparator === lastBrace) {
        cleaned = cleaned.slice(0, lastBrace + 1); // Keep the open brace
      } else {
        cleaned = cleaned.slice(0, lastComma); // Remove the comma and anything after
      }
      cleaned = cleaned.trim();
    } else if (lastColon !== -1) {
      // We have a colon. Check if the value after the colon is complete.
      const valuePart = cleaned.substring(lastColon + 1).trim();
      const validEndings = ['"', 'true', 'false', 'null', '}', ']'];
      const endsWithValid = validEndings.some(ending => valuePart.endsWith(ending)) || /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(valuePart) || /\d$/.test(valuePart);
      
      if (!valuePart || !endsWithValid) {
        // Replace incomplete value with null
        cleaned = cleaned.substring(0, lastColon + 1) + ' null';
      }
    }
  }

  // Remove any trailing commas right before closing the braces
  while (cleaned.endsWith(',')) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  // Close open brackets/braces
  while (stack.length > 0) {
    const closeChar = stack.pop();
    cleaned += closeChar;
  }

  // Clean up any trailing commas inside objects or arrays (e.g. [1, 2,])
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');

  return cleaned;
}

/**
 * Attempt to parse JSON cleanly, with robust error recovery for malformed/truncated output.
 */
export function parseRobustJson(str: string): any {
  const cleaned = str
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    // Standard try with trailing comma cleanup
    const withoutTrailingCommas = cleaned.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(withoutTrailingCommas);
  } catch (err: any) {
    logger.warn(`Standard JSON parse failed (Error: ${err?.message || String(err)}). Attempting robust repair...`);
    try {
      const repaired = repairJson(str);
      const withoutTrailingCommas = repaired.replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(withoutTrailingCommas);
    } catch (repairErr: any) {
      logger.error(`JSON repair failed as well (Error: ${repairErr?.message || String(repairErr)}). Raw input:\n` + str);
      throw err; // throw original parse error for context
    }
  }
}
