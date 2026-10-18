// Word-level diff for the Monitor: what changed in Master's output since the previous version. No imports, so tests load it directly.
/** word-level LCS diff of b against a: [{op: "=" | "+" | "-", t}] */
export function wdiff(a: string, b: string) {
  const A = a.match(/\S+\s*/g) ?? [], B = b.match(/\S+\s*/g) ?? [], n = A.length, m = B.length, w = (x: string) => x.trim();
  if (n * m > 250_000) return [{ op: "=", t: b }]; // ponytail: ~500x500 words max (a 250k-cell table); longer outputs show without highlights
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = w(A[i]) === w(B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { op: string; t: string }[] = [], gone: string[] = [];
  const flush = () => { if (gone.length) out.push({ op: "-", t: gone.join(" ") }, { op: "=", t: " " }); gone.length = 0; }; // deleted words keep no line breaks: the layout follows the new text
  const push = (op: string, t: string) => { flush(); const l = out.at(-1); if (l?.op === op) l.t += t; else out.push({ op, t }); };
  let i = 0, j = 0;
  while (i < n && j < m) { if (w(A[i]) === w(B[j])) { push("=", B[j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) gone.push(w(A[i++])); else push("+", B[j++]); }
  while (i < n) gone.push(w(A[i++]));
  while (j < m) push("+", B[j++]);
  flush();
  return out;
}
