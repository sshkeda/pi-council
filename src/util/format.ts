// Zero-dep terminal formatting
const isColor = process.stdout.isTTY !== false;

export const bold = (s: string) => (isColor ? `\x1b[1m${s}\x1b[0m` : s);
export const green = (s: string) => (isColor ? `\x1b[32m${s}\x1b[0m` : s);
export const red = (s: string) => (isColor ? `\x1b[31m${s}\x1b[0m` : s);
export const yellow = (s: string) => (isColor ? `\x1b[33m${s}\x1b[0m` : s);
export const dim = (s: string) => (isColor ? `\x1b[2m${s}\x1b[0m` : s);
