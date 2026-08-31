/**
 * Browser regression for the composer auto-grow behavior: the box tracks its
 * content height line by line, clamps at the cap (scrolling past it), and
 * shrinks back when the text is cleared — with heights written as explicit
 * pixels so the CSS height transition can animate every change.
 */
import { useState } from "react";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useAutoGrow } from "@/hooks/use-autogrow";

const MAX_HEIGHT = 120;

function Harness() {
  const [value, setValue] = useState<string>("");
  const ref = useAutoGrow(value, MAX_HEIGHT);
  return (
    <textarea
      ref={ref}
      data-testid="autogrow-input"
      value={value}
      rows={1}
      onChange={(event) => setValue(event.target.value)}
      style={{
        width: "240px",
        boxSizing: "border-box",
        fontSize: "15px",
        lineHeight: "24px",
        padding: "0px",
        border: "none",
        resize: "none",
        transition: "height 80ms ease-out",
      }}
    />
  );
}

function textareaNode(): HTMLTextAreaElement {
  const element = document.querySelector('[data-testid="autogrow-input"]');
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("autogrow harness textarea is not mounted");
  }
  return element;
}

function measuredHeight(): number {
  return textareaNode().getBoundingClientRect().height;
}

test("the textarea grows with content, clamps at the cap, and shrinks back", async () => {
  render(<Harness />);
  const input = page.getByTestId("autogrow-input");
  await expect.element(input).toBeVisible();

  const singleLine = measuredHeight();
  expect(singleLine).toBeGreaterThan(0);
  expect(singleLine).toBeLessThan(60);

  // Four lines fit under the cap — the box grows and keeps scrolling off.
  await input.fill("one\ntwo\nthree\nfour");
  await expect.poll(measuredHeight).toBeGreaterThan(singleLine + 40);
  expect(measuredHeight()).toBeLessThanOrEqual(MAX_HEIGHT);
  expect(textareaNode().style.overflowY).toBe("hidden");

  // Twenty lines overflow the cap — height clamps and the box scrolls inside.
  await input.fill(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"));
  await expect.poll(measuredHeight).toBe(MAX_HEIGHT);
  expect(textareaNode().style.overflowY).toBe("auto");

  // Clearing back to one line shrinks the box to its original height.
  await input.fill("one");
  await expect.poll(measuredHeight).toBe(singleLine);
  expect(textareaNode().style.overflowY).toBe("hidden");
});
