// Which names hold a secret, word by word, as the Python and Java SDKs read them; and where the SDK masks by them.

import { describe, expect, it } from "vitest";
import { safeUrl } from "../src/calls.js";
import { maskText } from "../src/dumps.js";
import { repr } from "../src/locals.js";
import { counted, sensitive, words } from "../src/masking.js";
import { masked as maskedBody, requestAttrs } from "../src/request.js";

// Names a request, a dump, a local variable and a log record's field mask: the Python SDK's cases.
const SECRET = [
  // Passwords.
  "password",
  "passwd",
  "db_pass",
  "passphrase",
  "passcode",
  "passkey",
  "new_password",
  "password1",
  "password_confirm",
  "passwordConfirm",
  "passwords",
  "password_hash",
  // Secrets.
  "secret",
  "secrets",
  "client_secret",
  "client_secrets",
  "clientSecret",
  "clientsecret",
  "webhook_secret",
  "secret_key",
  "secretKey",
  // Tokens.
  "token",
  "access_token",
  "accessToken",
  "accesstoken",
  "refresh_token",
  "id_token",
  "authToken",
  // Tokens in the plural: credentials after a credential's word, and alone (unless counted()).
  "tokens",
  "refresh_tokens",
  "access_tokens",
  "accessTokens",
  "auth_tokens",
  "api_tokens",
  "bearer_tokens",
  "id_tokens",
  "session_tokens",
  "csrftoken",
  "csrf_token",
  "X-CSRFToken",
  "csrfmiddlewaretoken",
  "X-XSRF-TOKEN",
  "authenticity_token",
  "x-amz-security-token",
  // API keys.
  "api_key",
  "apiKey",
  "APIKey",
  "apikey",
  "x-api-key",
  "api_keys",
  "apiKeys",
  // Auth: the header, its schemes, OAuth's.
  "auth",
  "AUTH_HEADER",
  "x-auth",
  "X-Auth-Token",
  "basic_auth",
  "HTTPBasicAuth",
  "Authorization",
  "Proxy-Authorization",
  "authorization_code",
  "authentication",
  "oauth",
  "oauth2",
  "oauth_token",
  "oauth_secret",
  "OAuthToken",
  "_auth_user_hash",
  // Cookies and sessions.
  "cookie",
  "cookies",
  "Set-Cookie",
  "cookiejar",
  "session",
  "sessions",
  "sessionid",
  "sessionId",
  "session_id",
  "session_key",
  "PHPSESSID",
  "JSESSIONID",
  // CSRF, signatures, private keys.
  "csrf",
  "xsrf",
  "signature",
  "X-Hub-Signature-256",
  "Stripe-Signature",
  "private",
  "private_key",
  "privateKey",
  // Payment cards.
  "card_number",
  "cardNumber",
  "cardnumber",
  "card_no",
  "card_num",
  "card-number",
  "card[number]",
  "credit_card_number",
  "card_number_last4",
  "pan",
  "card_pan",
  "cvc",
  "cvv",
  "cvv2",
  "cvn",
  "card_cvc",
  "card[cvc]",
  "cvc_token",
];

// Names that only look like one: a secret's word inside another word, a name about a secret, a yes or no.
const PLAIN = [
  // Not auth.
  "author",
  "authors",
  "author_id",
  "authorId",
  "authored_by",
  "authorship",
  "authority",
  "authorities",
  "authenticated",
  "is_authenticated",
  "isAuthenticated",
  "authenticator",
  "authorized",
  "WWW-Authenticate",
  // Not a token: a model's tokens are counted.
  "tokenizer",
  "max_tokens",
  "maxTokens",
  "prompt_tokens",
  "total_tokens",
  "completion_tokens",
  "input_tokens",
  "tokenCount",
  // Not a password, a secret or a card.
  "bypass",
  "compass",
  "passenger",
  "passport",
  "secretary",
  "company",
  "span",
  "expand",
  "pane",
  "card_brand",
  "card_last4",
  "discount",
  "number",
  "account",
  "key",
  // About a secret.
  "passwords_count",
  "password_length",
  "token_type",
  "tokenType",
  "token_expires_at",
  "session_timeout",
  "cookie_name",
  // Yes or no.
  "has_password",
  "is_private",
  "isPrivate",
];

describe("a name", () => {
  it.each(SECRET)("with a secret's word is masked: %s", (name) => {
    expect(sensitive(name)).toBe(true);
  });

  it.each(PLAIN)("without one is shown: %s", (name) => {
    expect(sensitive(name)).toBe(false);
  });

  it("is read word by word", () => {
    expect(
      ["X-CSRFToken", "card[number]", "creditCardNumber", "APIKey", "source.exp_month", "oauth2", "__Host-Lang"].map(
        words,
      ),
    ).toEqual([
      ["x", "csrf", "token"],
      ["card", "number"],
      ["credit", "card", "number"],
      ["api", "key"],
      ["source", "exp", "month"],
      ["oauth2"],
      ["host", "lang"],
    ]);
  });
});

describe("tokens alone", () => {
  it("holding counts are a model's", () => {
    expect([
      counted("tokens", 1024),
      counted("tokens", [12, 7]),
      counted("tokens", { prompt: 12, completion: 7 }),
      counted("tokens", 1.5),
      counted("tokens", []),
    ]).toEqual([true, true, true, true, true]);
  });

  it("holding anything else, or another name, are not", () => {
    expect([
      counted("tokens", ["abc", "def"]),
      counted("tokens", "abc"),
      counted("tokens", [1, "abc"]),
      counted("tokens", { github: "abc" }),
      counted("tokens", true),
      counted("refresh_tokens", [1]),
      counted("token", 1),
      counted(7, 1),
    ]).toEqual([false, false, false, false, false, false, false, false]);
  });
});

describe("where the SDK masks", () => {
  it("a request's headers, query, cookies and body, word by word", () => {
    expect(
      requestAttrs(
        {
          "x-api-key": "k-1",
          author: "ann",
          "x-auth-token": "t-1",
          cookie: "sessionid=s-1; theme=dark",
        },
        "?author=ann&authToken=t-2",
      ),
    ).toEqual({
      "http.request.header.x_api_key": "********",
      "http.request.header.author": "ann",
      "http.request.header.x_auth_token": "********",
      "http.request.cookie.sessionid": "********",
      "http.request.cookie.theme": "dark",
      "url.query": "author=ann&authToken=********",
    });

    expect(
      maskedBody({ author: "ann", authToken: "t", tokens: [12, 7], usage: { tokens: 3 }, keys: { tokens: ["a"] } }),
    ).toEqual({
      author: "ann",
      authToken: "********",
      tokens: [12, 7],
      usage: { tokens: 3 },
      keys: { tokens: "********" },
    });
  });

  it("an error's locals and a dump's text, by the name and the keys inside", () => {
    expect([
      repr("author", "ann"),
      repr("authToken", "t"),
      repr("tokens", 5),
      repr("order", { author: "ann", AUTH_HEADER: "Bearer x", tokens: 3 }),
    ]).toEqual(["'ann'", "********", "5", "{ author: 'ann', AUTH_HEADER: '********', tokens: 3 }"]);

    expect(maskText("{ author: 'ann', authToken: 't', tokens: [ 12, 7 ], 'x-api-key': 'k' }")).toBe(
      "{ author: 'ann', authToken: '********', tokens: [ 12, 7 ], 'x-api-key': '********' }",
    );
  });

  it("an outgoing call's URL: the query's secrets by word, an API's key and a signed URL's too", () => {
    expect(
      safeUrl("https://ann:pw@api.example.com/v1?author=ann&authToken=t&key=AIza&sig=s&X-Amz-Credential=c&monkey=1"),
    ).toBe(
      "https://api.example.com/v1?author=ann&authToken=********&key=********&sig=********&X-Amz-Credential=********&monkey=1",
    );
  });
});
