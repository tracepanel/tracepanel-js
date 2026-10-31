// Which names hold a secret, as the Python and Java SDKs read them: word by word.
//
// A name is split at `_ - . [ ]` and the like and where camelCase turns: x-api-key, card[number], cardNumber, APIKey
// and X-CSRFToken are (x, api, key), (card, number), (card, number), (api, key), (x, csrf, token). A secret's word
// must be a whole word, so `author`, `authority` and `isAuthenticated` aren't `auth`, and `tokenizer` isn't `token`.
// Words written together are read too: csrftoken and accesstoken end in a token, sessionid starts with a session,
// PHPSESSID ends in one.
//
// `tokens` counts a model's tokens (maxTokens, prompt_tokens) as often as it holds credentials: it is a secret after
// a credential's word (refresh_tokens, accessTokens) and alone, unless what it holds is counts (counted()).
//
// Two kinds of names hold no secret though a secret's word is in them: one that says something about the secret
// (password_length, tokenType, session_timeout, cookie_name, token_expires_at) and a yes or no (isPrivate,
// has_password).

export const MASK = "********";

const WORD_BREAKS = /[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

// A card's number and its security code (CVC, CVV, CVN).
const CARD_WORDS = ["pan", "cvc", "cvv", "cvn", "cvc2", "cvv2", "cardnumber", "cardnum", "cardno"];
const CARD_PAIRS = ["card number", "card num", "card no"];
// The words of a secret.
const WORDS = new Set([
  ...CARD_WORDS,
  "pass",
  "passwd",
  "password",
  "passwords",
  "passphrase",
  "passcode",
  "passkey",
  "secret",
  "secrets",
  "secretkey",
  "token",
  "apikey",
  "apikeys",
  "auth",
  "oauth",
  "oauth2",
  "authorization",
  "authentication",
  "cookie",
  "cookies",
  "session",
  "sessions",
  "csrf",
  "xsrf",
  "signature",
  "signatures",
  "private",
]);
// A credential's word before `tokens`: refresh_tokens, accessTokens, api_tokens.
const TOKENS_OF = [
  "refresh",
  "access",
  "auth",
  "api",
  "bearer",
  "id",
  "session",
  "oauth",
  "csrf",
  "xsrf",
  "jwt",
  "client",
];
const PAIRS = new Set([...CARD_PAIRS, "api key", "api keys", ...TOKENS_OF.map((word) => `${word} tokens`)]);
// Words written together: accesstoken, csrftoken, clientsecret, newpassword, xapikey, jsessionid, PHPSESSID...
const ENDS = ["token", "secret", "password", "passwd", "apikey", "sessionid", "sessid"];
// ...and csrfmiddlewaretoken, sessionkey, cookiejar. Not `secret` (secretary), `token` (tokenizer) nor `auth` (author).
const STARTS = ["password", "apikey", "csrf", "xsrf", "session", "cookie"];
// The last word of a name about a secret, not the secret: password_length, token_type, cookie_name.
const ABOUT = new Set([
  "count",
  "total",
  "length",
  "len",
  "min",
  "max",
  "size",
  "age",
  "timeout",
  "ttl",
  "expiry",
  "expires",
  "expiration",
  "at",
  "type",
  "name",
  "field",
  "label",
  "required",
  "enabled",
]);
// The first word of a yes or no: is_private, has_password.
const YES_OR_NO = new Set(["is", "has"]);

/** A name's words, lowercase: `X-CSRFToken` -> [x, csrf, token], `card[number]` -> [card, number]. */
export function words(name: string): string[] {
  return name
    .split(WORD_BREAKS)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

const known = new Map<string, boolean>();
const MAX_KNOWN = 4096;

/**
 * Whether a secret goes under the name: password, x-api-key, Authorization, authToken, AUTH_HEADER, csrftoken,
 * sessionid, card[cvc]; not author, tokenizer, max_tokens, password_length or is_private. The rule of a request
 * (headers, cookies, query, bodies), a dump, an error's local variables and a log record's fields.
 */
export function sensitive(name: string): boolean {
  const cached = known.get(name);
  if (cached !== undefined) return cached;
  const found = secret(words(name));
  if (known.size >= MAX_KNOWN) known.clear();
  known.set(name, found);
  return found;
}

function secret(found: string[]): boolean {
  if (found.length === 1 && found[0] === "tokens") return true;
  if (found.length > 1 && (YES_OR_NO.has(found[0] ?? "") || ABOUT.has(found.at(-1) ?? ""))) return false;
  return (
    found.some(
      (word) =>
        WORDS.has(word) || ENDS.some((end) => word.endsWith(end)) || STARTS.some((start) => word.startsWith(start)),
    ) || found.some((word, index) => index > 0 && PAIRS.has(`${found[index - 1]} ${word}`))
  );
}

/**
 * Whether `tokens` holds a model's counts, not credentials: a number, or numbers only (an array, an object's values).
 * A name alone (a header, a query's parameter, a cookie) holds a string: it stays masked.
 */
export function counted(name: unknown, value: unknown): boolean {
  if (typeof name !== "string") return false;
  const found = words(name);
  if (found.length !== 1 || found[0] !== "tokens") return false;
  const items = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object"
      ? Object.values(value)
      : [value];
  return items.every((item) => typeof item === "number");
}

/** Whether the value under a name is masked: the name holds a secret, and it isn't a model's counts. */
export function masks(name: string, value: unknown): boolean {
  return sensitive(name) && !counted(name, value);
}
