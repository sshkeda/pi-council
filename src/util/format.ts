// Zero-dep terminal formatting
// Respect NO_COLOR (https://no-color.org/) and FORCE_COLOR conventions.
// Check both stdout and stderr since we write to both.
const isColor =
  !("NO_COLOR" in process.env) &&
  (("FORCE_COLOR" in process.env) ||
    (process.stdout.isTTY === true || process.stderr.isTTY === true));

export const bold = (s: string) => (isColor ? `\x1b[1m${s}\x1b[0m` : s);
export const green = (s: string) => (isColor ? `\x1b[32m${s}\x1b[0m` : s);
export const red = (s: string) => (isColor ? `\x1b[31m${s}\x1b[0m` : s);
export const yellow = (s: string) => (isColor ? `\x1b[33m${s}\x1b[0m` : s);
export const dim = (s: string) => (isColor ? `\x1b[2m${s}\x1b[0m` : s);
