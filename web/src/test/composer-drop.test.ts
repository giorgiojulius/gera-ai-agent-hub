import { describe, expect, it } from "vitest";

import { composerAccept, filterDroppedFiles, matchesAccept } from "@/lib/composer-drop";

describe("composerAccept", () => {
  it("chat takes images and knowledge documents", () => {
    const accept = composerAccept("chat", false);
    expect(accept).toContain("image/*");
    expect(accept).toContain(".pdf");
    expect(accept).toContain(".docx");
  });

  it("image mode takes only images", () => {
    expect(composerAccept("image", false)).toBe("image/*");
  });

  it("video mode follows the picked model's local-file support", () => {
    expect(composerAccept("video", true)).toBe("image/*");
    expect(composerAccept("video", false)).toBeNull();
  });

  it("audio mode takes no files", () => {
    expect(composerAccept("audio", true)).toBeNull();
  });
});

describe("matchesAccept", () => {
  it("matches MIME families, exact types and extensions", () => {
    expect(matchesAccept("photo.png", "image/png", "image/*")).toBe(true);
    expect(matchesAccept("doc.pdf", "application/pdf", "application/pdf")).toBe(true);
    expect(matchesAccept("notes.TXT", "text/plain", ".txt")).toBe(true);
    expect(matchesAccept("archive.zip", "application/zip", "image/*,.pdf")).toBe(false);
  });

  it("is case-insensitive and ignores blank entries", () => {
    expect(matchesAccept("Photo.JPG", "IMAGE/JPEG", " image/* , ")).toBe(true);
    expect(matchesAccept("song.mp3", "audio/mpeg", "")).toBe(false);
  });
});

describe("filterDroppedFiles", () => {
  const files = [
    { name: "shot.png", type: "image/png" },
    { name: "report.pdf", type: "application/pdf" },
    { name: "movie.mp4", type: "video/mp4" },
  ];

  it("chat keeps images and documents, drops unsupported", () => {
    const kept = filterDroppedFiles(files, composerAccept("chat", false));
    expect(kept.map((file) => file.name)).toEqual(["shot.png", "report.pdf"]);
  });

  it("image mode keeps only images", () => {
    const kept = filterDroppedFiles(files, composerAccept("image", false));
    expect(kept.map((file) => file.name)).toEqual(["shot.png"]);
  });

  it("a null accept keeps nothing", () => {
    expect(filterDroppedFiles(files, null)).toEqual([]);
  });
});
