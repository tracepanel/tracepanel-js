// The proxy's answer when the console doesn't: why and what to do, a page that reloads itself for a browser.
import { expect, test } from "vitest";
import { unavailablePage } from "../src/proxy.js";

test("the page needs nothing from elsewhere, and what it says can't make markup", () => {
  const page = unavailablePage({ title: "A <b>title</b>", detail: `Store: /tmp/"x" & 'y'.` });

  expect(page).toContain("<title>Tracepanel: A &#60;b&#62;title&#60;/b&#62;</title>");
  expect(page).toContain("<p>Store: /tmp/&#34;x&#34; &#38; &#39;y&#39;.</p>");

  expect(page).not.toMatch(/<(script|link|img)\b|https?:/);
});
