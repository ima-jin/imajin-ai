/**
 * Strip trailing slashes from a base URL.
 *
 * Every call site in this package previously did `value.replace(/\/+$/, '')`.
 * SonarCloud (S8786) flags a `+` quantifier anchored to `$` as a
 * super-linear backtracking risk, so this walks the string backwards
 * instead — strictly linear in the length of the trailing-slash run, with
 * no regex involved at all.
 */
const SLASH_CHAR_CODE = '/'.charCodeAt(0);

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end -= 1;
  }
  return value.slice(0, end);
}
