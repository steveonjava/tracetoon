/**
 * The Porter (1980) stemmer, as Relate's `english` analyzer and SQLite's FTS5
 * `porter` tokenizer apply it. Relate's FULLTEXT index stores tokens as given
 * (only the query side is analyzed), so graph search stems both the indexed
 * hunk text and the query words here, and "pinned" meets "pins".
 *
 * Like FTS5, tokens shorter than 3 or longer than 64 characters, and tokens
 * that are not all ASCII lowercase letters, pass through unchanged.
 */

const STEP_2: [string, string][] = [
  ['ational', 'ate'],
  ['tional', 'tion'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['izer', 'ize'],
  ['bli', 'ble'],
  ['alli', 'al'],
  ['entli', 'ent'],
  ['eli', 'e'],
  ['ousli', 'ous'],
  ['ization', 'ize'],
  ['ation', 'ate'],
  ['ator', 'ate'],
  ['alism', 'al'],
  ['iveness', 'ive'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['aliti', 'al'],
  ['iviti', 'ive'],
  ['biliti', 'ble'],
  ['logi', 'log'],
];
const STEP_3: [string, string][] = [
  ['icate', 'ic'],
  ['ative', ''],
  ['alize', 'al'],
  ['iciti', 'ic'],
  ['ical', 'ic'],
  ['ful', ''],
  ['ness', ''],
];
const STEP_4 = [
  'al',
  'ance',
  'ence',
  'er',
  'ic',
  'able',
  'ible',
  'ant',
  'ement',
  'ment',
  'ent',
  'ion',
  'ou',
  'ism',
  'ate',
  'iti',
  'ous',
  'ive',
  'ize',
];

/** Per letter: is it a consonant (y after a consonant is a vowel). */
function consonants(w: string): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    out.push('aeiou'.includes(c) ? false : c === 'y' ? i > 0 && !out[i - 1] : true);
  }
  return out;
}

/** Porter's m: the number of vowel-consonant sequences. */
function measure(w: string): number {
  const p = consonants(w);
  let m = 0;
  for (let i = 1; i < p.length; i++) if (!p[i - 1] && p[i]) m++;
  return m;
}

const hasVowel = (w: string) => consonants(w).includes(false);
const doubleConsonant = (w: string) =>
  w.length >= 2 && w.at(-1) === w.at(-2) && consonants(w).at(-1)!;
function cvc(w: string): boolean {
  if (w.length < 3 || 'wxy'.includes(w.at(-1)!)) return false;
  const p = consonants(w);
  const n = w.length - 1;
  return p[n - 2]! && !p[n - 1] && p[n]!;
}

function replaceFirst(w: string, table: [string, string][]): string {
  const hit = table.find(([s]) => w.endsWith(s));
  if (!hit) return w;
  const stem = w.slice(0, w.length - hit[0].length);
  return measure(stem) >= 1 ? stem + hit[1] : w;
}

export function porterStem(token: string): string {
  if (token.length < 3 || token.length > 64 || !/^[a-z]+$/.test(token)) return token;
  let w = token;
  // 1a
  if (w.endsWith('sses') || w.endsWith('ies')) w = w.slice(0, -2);
  else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);
  // 1b
  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else {
    const cut = w.endsWith('ed') ? 2 : w.endsWith('ing') ? 3 : 0;
    if (cut && hasVowel(w.slice(0, -cut))) {
      w = w.slice(0, -cut);
      if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
      else if (doubleConsonant(w) && !'lsz'.includes(w.at(-1)!)) w = w.slice(0, -1);
      else if (measure(w) === 1 && cvc(w)) w += 'e';
    }
  }
  // 1c
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + 'i';
  w = replaceFirst(w, STEP_2);
  w = replaceFirst(w, STEP_3);
  // 4
  const s4 = STEP_4.find((s) => w.endsWith(s));
  if (s4) {
    const stem = w.slice(0, w.length - s4.length);
    if (s4 === 'ion') {
      if (stem.length && 'st'.includes(stem.at(-1)!) && measure(stem) > 1) w = stem;
    } else if (measure(stem) > 1) w = stem;
  }
  // 5a
  if (w.endsWith('e')) {
    const stem = w.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !cvc(stem))) w = stem;
  }
  // 5b
  if (measure(w) > 1 && doubleConsonant(w) && w.endsWith('l')) w = w.slice(0, -1);
  return w;
}
