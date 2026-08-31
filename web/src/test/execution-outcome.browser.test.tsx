import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ExecutionOutcomeCard } from "@/components/gera/ExecutionOutcomeCard";
import { TID } from "@/lib/testids";
import type { ExecutionOutcome } from "@/lib/types";

const OUTCOME: ExecutionOutcome = {
  version: 1,
  status: "no_change",
  summary: "No material release change was found.",
  artifacts: [
    {
      id: "art_1",
      kind: "check",
      label: "Daily release check",
      url: "https://status.example.com/releases",
    },
  ],
  evidence: [
    {
      id: "ev_1",
      kind: "source",
      label: "Release status",
      status: "verified",
      url: "https://status.example.com/releases",
    },
  ],
  handoff: { kind: "gera", nextStep: "Run the next scheduled check tomorrow." },
  significance: { kind: "none", summary: "Nothing material changed.", notify: false },
  validation: "verified",
  validatedAt: 1,
};

test("autonomous outcome stays compact and expands to artifact, evidence, and handoff", async () => {
  await render(<ExecutionOutcomeCard outcome={OUTCOME} />);

  const card = page.getByTestId(TID.executionOutcome);
  await expect.element(card).toBeVisible();
  await expect.element(card.getByText("No material change", { exact: true })).toBeVisible();
  await expect.element(card.getByText("Daily release check", { exact: true })).not.toBeVisible();

  await card.getByText("No material change", { exact: true }).click();

  await expect.element(card.getByText("Daily release check", { exact: true })).toBeVisible();
  await expect.element(card.getByText("Release status", { exact: true })).toBeVisible();
  await expect.element(card.getByText("Next owner · Gera", { exact: true })).toBeVisible();
  await expect.element(card.getByText("Run the next scheduled check tomorrow.", { exact: true })).toBeVisible();
});
