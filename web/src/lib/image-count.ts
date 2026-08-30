// Detects an explicit image count inside a prompt — "сделай 4 картинки",
// "three variants", "постер x4" — so one prompt fans out into several
// parallel generations, but only when the user actually asked for that.

/** Hard ceiling per prompt — parallel runs each bill separately. */
export const MAX_IMAGE_COUNT = 4;

/** Clamps any requested count into the honest 1..MAX_IMAGE_COUNT range. */
export function clampImageCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(Math.round(value), 1), MAX_IMAGE_COUNT);
}

/** Number words (RU + EN) that can precede a media noun. */
const NUMBER_WORDS: Record<string, number> = {
  один: 1,
  одну: 1,
  одна: 1,
  одно: 1,
  два: 2,
  две: 2,
  пара: 2,
  пару: 2,
  три: 3,
  трех: 3,
  трёх: 3,
  четыре: 4,
  четырех: 4,
  четырёх: 4,
  пять: 5,
  шесть: 6,
  несколько: 3,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  couple: 2,
  few: 3,
  several: 3,
};

/** Media-noun prefix stems a count can attach to (RU + EN). */
const NOUN_STEMS =
  "(?:картин|изображ|фот|вариант|верси|штук|обложк|постер|логотип|аватар|" +
  "image|picture|pic|photo|shot|variant|variation|version|option|render|poster|logo|cover|wallpaper|avatar)";

// One optional word between the count and the noun covers "4 разных картинки"
// and "a couple of pictures". JS \b is ASCII-only, so Cyrillic boundaries use
// \p{L}/\p{N} lookarounds instead.
const DIGIT_BEFORE_NOUN = new RegExp(
  `(?<![\\p{L}\\p{N}])(\\d{1,2})\\s*(?:\\p{L}+\\s+)?${NOUN_STEMS}`,
  "u",
);
const WORD_BEFORE_NOUN = new RegExp(
  `(?<![\\p{L}\\p{N}])(${Object.keys(NUMBER_WORDS).join("|")})\\s+(?:\\p{L}+\\s+)?${NOUN_STEMS}`,
  "u",
);
// Gen-AI shorthand: "x4" / "4x" / "×4" (Latin x, ×, Cyrillic х). The digit
// lookarounds keep sizes ("1024x1536") and "4x4" from matching.
const TIMES_AFTER = /(?<![\p{N}\p{L}])(\d)\s?[x×х](?![\p{N}\p{L}])/u;
const TIMES_BEFORE = /(?<![\p{N}\p{L}])[x×х]\s?(\d)(?![\p{N}\p{L}])/u;

/**
 * Returns the raw count the prompt asks for (may exceed MAX_IMAGE_COUNT —
 * callers clamp and disclose), or null when no count is specified.
 */
export function parseImageCount(prompt: string): number | null {
  const text = prompt.toLowerCase();

  const digit = DIGIT_BEFORE_NOUN.exec(text);
  if (digit) {
    const value = Number(digit[1]);
    return value >= 1 ? value : null;
  }

  const word = WORD_BEFORE_NOUN.exec(text);
  if (word) {
    return NUMBER_WORDS[word[1]] ?? null;
  }

  const times = TIMES_AFTER.exec(text) ?? TIMES_BEFORE.exec(text);
  if (times) {
    const value = Number(times[1]);
    return value >= 1 ? value : null;
  }

  return null;
}
