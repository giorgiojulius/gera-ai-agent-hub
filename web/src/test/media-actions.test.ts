import { describe, expect, it } from "vitest";

import { downloadFileName, extensionForMime, safeFileName } from "@/lib/media-actions";

describe("extensionForMime", () => {
  it("maps common image / video / audio types", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("video/mp4")).toBe(".mp4");
    expect(extensionForMime("audio/mpeg")).toBe(".mp3");
  });

  it("ignores codec suffixes and unknown types", () => {
    expect(extensionForMime("audio/webm;codecs=opus")).toBe(".weba");
    expect(extensionForMime("application/x-unknown")).toBe("");
  });
});

describe("safeFileName", () => {
  it("keeps letters, digits and dots; collapses junk to single dashes", () => {
    expect(safeFileName("My cool image (1).png")).toBe("My-cool-image-1.png");
  });

  it("keeps unicode names", () => {
    expect(safeFileName("отчёт май.png")).toBe("отчёт-май.png");
  });

  it("falls back for empty input", () => {
    expect(safeFileName("   ")).toBe("gera-media");
  });
});

describe("downloadFileName", () => {
  it("appends an extension inferred from the mime when missing", () => {
    expect(downloadFileName("gera-image-1", "image/webp")).toBe("gera-image-1.webp");
  });

  it("keeps an existing extension", () => {
    expect(downloadFileName("report.pdf", "application/pdf")).toBe("report.pdf");
  });

  it("leaves the name alone for unknown mimes", () => {
    expect(downloadFileName("blob", "application/octet-stream")).toBe("blob");
  });
});
