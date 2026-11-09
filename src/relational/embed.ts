/**
 * Local, deterministic text embeddings for the relational/vector arm.
 *
 * The model is minishlab/potion-code-16M-v2 (MIT), a Model2Vec static embedding
 * model distilled from nomic-ai/CodeRankEmbed and fine-tuned on natural-language
 * query / code pairs: 63,457 WordPiece tokens × 256 dimensions, stored as float16
 * (32 MB). A static model is a lookup table, so inference is pure TypeScript:
 *
 *   BERT normalization → BERT pre-tokenization → WordPiece → drop [UNK]
 *   → mean of the token rows → L2 normalization
 *
 * which is exactly Model2Vec's `StaticModel.encode` (tested against it). There is
 * no runtime, no wasm, no network and no threads, and the same text gives the same
 * vector in Bun, the Node bundle and the compiled binary.
 *
 * The files ship unchanged from the pinned Hugging Face revision (see
 * build-dependencies.json) in the skill's `assets/potion-code-16M-v2/`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetsDir } from '../util/assets.ts';

export const MODEL_DIR = 'potion-code-16M-v2';
export const MODEL_NAME = 'minishlab/potion-code-16M-v2';
const MODEL_FILE = `${MODEL_DIR}/model.safetensors`;
/** Model2Vec's default `max_length`. */
const MAX_TOKENS = 512;

export interface EmbeddingModel {
  name: string;
  dim: number;
  vocabSize: number;
  /** WordPiece ids of a text, [UNK] removed, at most 512 (Model2Vec's `tokenize`). */
  tokenize(text: string): number[];
  /** Unit-length embedding (all zeros for a text with no known tokens). */
  embed(text: string): Float32Array;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const key = Symbol.for('tracetoon.relational-embedding/v1');
const state = ((globalThis as any)[key] ??= {}) as {
  model?: EmbeddingModel;
  error?: string;
};

/** float16 bits → float32, for all 65,536 patterns. */
function halfTable(): Float32Array {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    t[h] =
      e === 0
        ? s * 2 ** -14 * (f / 1024)
        : e === 31
          ? f
            ? NaN
            : s * Infinity
          : s * 2 ** (e - 15) * (1 + f / 1024);
  }
  return t;
}

/** Unicode punctuation, plus every ASCII punctuation character (BERT's rule). */
const PUNCT = /[\p{P}!-/:-@[-`{-~]/u;
const CJK =
  /[\u{4E00}-\u{9FFF}\u{3400}-\u{4DBF}\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{F900}-\u{FAFF}\u{2F800}-\u{2FA1F}]/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const MARK = /\p{Mn}/u;
const WHITE = /\s/u;

/**
 * The HF `tokenizers` BertNormalizer (clean_text, handle_chinese_chars,
 * strip_accents = lowercase, lowercase) and BertPreTokenizer (split on
 * whitespace, every punctuation character its own word).
 */
export function bertWords(text: string): string[] {
  let clean = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd) continue;
    if (ch === '\t' || ch === '\n' || ch === '\r' || WHITE.test(ch)) {
      clean += ' ';
      continue;
    }
    if (CONTROL.test(ch)) continue;
    clean += CJK.test(ch) ? ` ${ch} ` : ch;
  }
  // strip_accents (implied by lowercase): NFD, drop non-spacing marks.
  let folded = '';
  for (const ch of clean.normalize('NFD')) if (!MARK.test(ch)) folded += ch;
  folded = folded.toLowerCase();
  const words: string[] = [];
  let cur = '';
  for (const ch of folded) {
    if (ch === ' ' || WHITE.test(ch)) {
      if (cur) words.push(cur);
      cur = '';
    } else if (PUNCT.test(ch)) {
      if (cur) words.push(cur);
      words.push(ch);
      cur = '';
    } else cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

/** Build a model from the parsed files (exported for tests). */
export function makeModel(
  safetensors: Uint8Array,
  tokenizerJson: string,
): EmbeddingModel {
  const tok = JSON.parse(tokenizerJson) as {
    model: {
      type: string;
      vocab: Record<string, number>;
      unk_token: string;
      continuing_subword_prefix: string;
      max_input_chars_per_word: number;
    };
  };
  if (tok.model.type !== 'WordPiece') throw new Error('Expected a WordPiece tokenizer.');
  const vocab = new Map(Object.entries(tok.model.vocab));
  const unk = vocab.get(tok.model.unk_token);
  const prefix = tok.model.continuing_subword_prefix;
  const maxChars = tok.model.max_input_chars_per_word;
  // Model2Vec truncates by characters first: max_length × the median token length.
  const lengths = [...vocab.keys()].map((t) => t.length).sort((a, b) => a - b);
  const medianLen = Math.trunc(
    lengths.length % 2
      ? lengths[(lengths.length - 1) / 2]!
      : (lengths[lengths.length / 2 - 1]! + lengths[lengths.length / 2]!) / 2,
  );

  const view = new DataView(safetensors.buffer, safetensors.byteOffset);
  const headerLen = Number(view.getBigUint64(0, true));
  const header = JSON.parse(
    new TextDecoder().decode(safetensors.subarray(8, 8 + headerLen)),
  ) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const t = header.embeddings;
  if (!t || t.dtype !== 'F16' || t.shape.length !== 2)
    throw new Error('Expected a float16 "embeddings" tensor.');
  const [rows, dim] = t.shape as [number, number];
  const start = 8 + headerLen + t.data_offsets[0];
  const bytes = safetensors.subarray(start, 8 + headerLen + t.data_offsets[1]);
  const half =
    (bytes.byteOffset & 1) === 0
      ? new Uint16Array(bytes.buffer, bytes.byteOffset, rows * dim)
      : new Uint16Array(bytes.slice().buffer, 0, rows * dim);
  const f16 = halfTable();

  const wordCache = new Map<string, number[]>();
  const wordPiece = (word: string): number[] => {
    const hit = wordCache.get(word);
    if (hit) return hit;
    const chars = [...word];
    let out: number[];
    if (chars.length > maxChars) out = unk === undefined ? [] : [unk];
    else {
      out = [];
      let i = 0;
      while (i < chars.length) {
        let end = chars.length;
        let id: number | undefined;
        while (end > i) {
          const piece = (i > 0 ? prefix : '') + chars.slice(i, end).join('');
          id = vocab.get(piece);
          if (id !== undefined) break;
          end--;
        }
        if (id === undefined) {
          out = unk === undefined ? [] : [unk];
          break;
        }
        out.push(id);
        i = end;
      }
    }
    if (wordCache.size < 200_000) wordCache.set(word, out);
    return out;
  };

  const tokenize = (text: string): number[] => {
    const ids: number[] = [];
    for (const w of bertWords(text.slice(0, MAX_TOKENS * medianLen))) {
      for (const id of wordPiece(w)) if (id !== unk) ids.push(id);
      if (ids.length >= MAX_TOKENS) break;
    }
    return ids.slice(0, MAX_TOKENS);
  };

  const embed = (text: string): Float32Array => {
    const v = new Float32Array(dim);
    const ids = tokenize(text);
    if (!ids.length) return v;
    // Sum in float64 for stability, then mean and normalize.
    const acc = new Float64Array(dim);
    for (const id of ids) {
      const base = id * dim;
      for (let j = 0; j < dim; j++) acc[j]! += f16[half[base + j]!]!;
    }
    let norm = 0;
    for (let j = 0; j < dim; j++) {
      acc[j]! /= ids.length;
      norm += acc[j]! * acc[j]!;
    }
    norm = Math.sqrt(norm) + 1e-32;
    for (let j = 0; j < dim; j++) v[j] = acc[j]! / norm;
    return v;
  };

  return { name: MODEL_NAME, dim, vocabSize: rows, tokenize, embed };
}

/** Load the bundled model once (about 40 ms). Never throws: `embeddingModel()` says why it's missing. */
export function initEmbeddings(): void {
  if (state.model) return;
  try {
    const dir = process.env.TRACETOON_EMBEDDING_DIR ?? assetsDir(MODEL_FILE);
    const base = process.env.TRACETOON_EMBEDDING_DIR ? dir! : dir && join(dir, MODEL_DIR);
    if (!base)
      throw new Error(
        `${MODEL_FILE} was not found; set TRACETOON_ASSETS to the skill's assets folder.`,
      );
    state.model = makeModel(
      readFileSync(join(base, 'model.safetensors')),
      readFileSync(join(base, 'tokenizer.json'), 'utf8'),
    );
    state.error = undefined;
  } catch (e) {
    state.error = (e as Error).message;
  }
}

/** The loaded model, or undefined (retrieval then runs on BM25 and exact mentions only). */
export function embeddingModel(): EmbeddingModel | undefined {
  return state.model;
}

export function embeddingError(): string | undefined {
  return state.error;
}

/** Dot product of two unit vectors: their cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
