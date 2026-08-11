// 検索窓での「その場で計算」機能用の、安全な四則演算パーサー。
// eval()や外部ライブラリ(expr-eval等)は使わず、数値の四則演算・括弧・べき乗のみを
// 自前の再帰下降パーサーで評価するので、プロトタイプ汚染や任意コード実行のリスクがない。

type Token =
  | { type: "num"; value: number }
  | { type: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" }
  | { type: "lparen" }
  | { type: "rparen" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      const start = i;
      let seenDot = false;
      while (i < input.length && (/[0-9]/.test(input[i]) || (input[i] === "." && !seenDot))) {
        if (input[i] === ".") seenDot = true;
        i++;
      }
      const value = Number(input.slice(start, i));
      if (Number.isNaN(value)) throw new Error("Invalid number");
      tokens.push({ type: "num", value });
      continue;
    }

    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%" || ch === "^") {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }

    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }

    throw new Error(`Unexpected character: ${ch}`);
  }

  return tokens;
}

// expression := term (('+' | '-') term)*
// term       := unary (('*' | '/' | '%') unary)*
// unary      := ('+' | '-') unary | power
// power      := primary ('^' unary)?   // 右結合
// primary    := NUMBER | '(' expression ')'
class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      const tok = this.peek();
      if (tok?.type === "op" && (tok.value === "+" || tok.value === "-")) {
        this.next();
        const rhs = this.parseTerm();
        value = tok.value === "+" ? value + rhs : value - rhs;
      } else {
        break;
      }
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok?.type === "op" && (tok.value === "*" || tok.value === "/" || tok.value === "%")) {
        this.next();
        const rhs = this.parseUnary();
        if (tok.value === "*") value *= rhs;
        else if (tok.value === "/") value /= rhs;
        else value %= rhs;
      } else {
        break;
      }
    }
    return value;
  }

  private parseUnary(): number {
    const tok = this.peek();
    if (tok?.type === "op" && (tok.value === "+" || tok.value === "-")) {
      this.next();
      const value = this.parseUnary();
      return tok.value === "-" ? -value : value;
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    const tok = this.peek();
    if (tok?.type === "op" && tok.value === "^") {
      this.next();
      const exponent = this.parseUnary(); // 右結合、単項マイナスも許可 (例: 2^-1)
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parsePrimary(): number {
    const tok = this.next();
    if (!tok) throw new Error("Unexpected end of expression");
    if (tok.type === "num") return tok.value;
    if (tok.type === "lparen") {
      const value = this.parseExpression();
      if (this.next()?.type !== "rparen") throw new Error("Missing closing parenthesis");
      return value;
    }
    throw new Error("Unexpected token");
  }

  isAtEnd(): boolean {
    return this.pos >= this.tokens.length;
  }
}

// 数字と演算子・括弧だけで構成され、かつ演算子を1つ以上含む場合だけ数式とみなす
// （"2"だけ、"chrome"のような単語をアプリ検索と誤解しないようにするための足切り）
export function looksLikeMathExpression(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (!/^[0-9+\-*/^%().\s]+$/.test(trimmed)) return false;
  if (!/[0-9]/.test(trimmed)) return false;
  return /[+\-*/^%]/.test(trimmed);
}

export function evaluateMathExpression(input: string): number | null {
  try {
    const tokens = tokenize(input);
    if (tokens.length === 0) return null;
    const parser = new Parser(tokens);
    const result = parser.parseExpression();
    if (!parser.isAtEnd()) return null; // 式の途中に余計なトークンが残っている
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// 浮動小数点の誤差(0.1+0.2 = 0.30000000000000004 等)を丸めて見た目を整える
export function formatMathResult(value: number): string {
  return Number(value.toPrecision(12)).toString();
}
