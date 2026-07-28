import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPeerIdRegistry,
  registerPeerId,
  resolveOriginalPeerId,
} from "../../src/peer-id-registry";

describe("peer id registry", () => {
  beforeEach(() => {
    clearPeerIdRegistry();
  });

  it("restores observed case-sensitive IDs without reading session files", () => {
    registerPeerId("cidAbC123==");

    expect(resolveOriginalPeerId("cidabc123==")).toBe("cidAbC123==");
    expect(resolveOriginalPeerId("cidUnknown==")).toBe("cidUnknown==");
  });
});
