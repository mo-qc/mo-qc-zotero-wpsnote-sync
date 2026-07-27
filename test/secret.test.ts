import { expect } from "chai";
import { encryptString, decryptString } from "../src/utils/secret";

describe("secret", function () {
  it("encrypts and decrypts API keys / tokens", function () {
    const original = "note_4fb41f44b4f0a0e782647fef87a452b3";
    const encrypted = encryptString(original);
    expect(encrypted).to.not.equal(original);
    expect(decryptString(encrypted)).to.equal(original);
  });

  it("returns null for invalid base64", function () {
    expect(decryptString("not-valid-base64!!!")).to.be.null;
  });
});
