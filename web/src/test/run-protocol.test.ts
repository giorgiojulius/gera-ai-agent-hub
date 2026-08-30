// Cloud media refs (`gera-cloud:v1:<runId>:<idx>`) are persisted inside chat
// payloads — a parse regression would strand every previously generated
// image/video. Pin the round trip and the reject paths.
import { describe, expect, it } from "vitest";

import { CLOUD_MEDIA_PREFIX, cloudMediaRef, parseCloudMediaRef } from "../../../functions/run-protocol";

describe("cloud media refs (functions/run-protocol)", () => {
  it("round-trips a ref, including run ids that contain colons", () => {
    expect(cloudMediaRef("run-1", 3)).toBe(`${CLOUD_MEDIA_PREFIX}run-1:3`);
    expect(parseCloudMediaRef(cloudMediaRef("run-1", 0))).toEqual({ runId: "run-1", index: 0 });
    expect(parseCloudMediaRef(cloudMediaRef("run:with:colons", 12))).toEqual({
      runId: "run:with:colons",
      index: 12,
    });
  });

  it("rejects refs from other schemes or with a broken tail", () => {
    expect(parseCloudMediaRef("other:v1:run:1")).toBeNull();
    expect(parseCloudMediaRef(`${CLOUD_MEDIA_PREFIX}norunindex`)).toBeNull();
    expect(parseCloudMediaRef(`${CLOUD_MEDIA_PREFIX}:4`)).toBeNull();
    expect(parseCloudMediaRef(`${CLOUD_MEDIA_PREFIX}run:`)).toBeNull();
    expect(parseCloudMediaRef(`${CLOUD_MEDIA_PREFIX}run:x`)).toBeNull();
    expect(parseCloudMediaRef(`${CLOUD_MEDIA_PREFIX}run:1.5`)).toBeNull();
    expect(parseCloudMediaRef(`${CLOUD_MEDIA_PREFIX}run:-1`)).toBeNull();
  });
});
