// Detects a pasted image link in a create-mode prompt. Video models that
// accept URL input (Seedance 2.5, Kling i2v, Veo, Grok Imagine) fetch the
// link server-side, so pasted links bypass browser CORS and the 4.5 MB
// request-body cap that local attachments must squeeze under.

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

export type PromptImageUrl = {
  url: string;
  /** Prompt text with the link removed and whitespace collapsed. */
  text: string;
};

/** Strips sentence punctuation that trails a pasted link ("...jpg)." etc). */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?…»)\]]+$/u, "");
}

/**
 * Pulls the first http(s) link out of a prompt. In image/video create modes a
 * pasted link is treated as the source image — if it turns out not to be an
 * image, the provider rejects it with a clear error rather than us guessing
 * by file extension (many image CDNs serve extension-less URLs).
 */
export function extractImageUrl(prompt: string): PromptImageUrl | null {
  const match = URL_PATTERN.exec(prompt);
  if (!match) {
    return null;
  }
  const url = trimTrailingPunctuation(match[0]);
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes(".")) {
      return null;
    }
  } catch {
    return null;
  }
  const text = `${prompt.slice(0, match.index)} ${prompt.slice(match.index + match[0].length)}`
    .replace(/\s+/g, " ")
    .trim();
  return { url, text };
}
