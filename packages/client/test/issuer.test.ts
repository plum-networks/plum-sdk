import { describe, expect, it } from "vitest";
import { isLoopbackHostname, isLoopbackIP, isPrivateIP, parseIP } from "../src/internal/ip.js";
import { boxLabel, validDevIssuer, wellFormedBoxIssuer } from "../src/issuer.js";
import { vectors } from "./support/vectors.js";

describe("issuer_syntax vectors (box issuers)", () => {
  it.each(vectors.issuer_syntax.accept)("accepts %j", (iss) => {
    expect(wellFormedBoxIssuer(iss, "plumbox.me")).toBe(true);
  });
  it.each(vectors.issuer_syntax.reject)("rejects %j", (iss) => {
    expect(wellFormedBoxIssuer(iss, "plumbox.me")).toBe(false);
  });
  it("checks all 3 + 24 strings", () => {
    expect(vectors.issuer_syntax.accept).toHaveLength(3);
    expect(vectors.issuer_syntax.reject).toHaveLength(24);
  });
});

describe("dev_expectation vectors", () => {
  it.each(vectors.dev_expectation.accept)("accepts %j and never as a box issuer", (iss) => {
    expect(validDevIssuer(iss)).toBe(true);
    expect(wellFormedBoxIssuer(iss, "plumbox.me")).toBe(false);
  });
  it.each(vectors.dev_expectation.reject)("rejects %j", (iss) => {
    expect(validDevIssuer(iss)).toBe(false);
  });
  it("checks all 8 + 9 strings", () => {
    expect(vectors.dev_expectation.accept).toHaveLength(8);
    expect(vectors.dev_expectation.reject).toHaveLength(9);
  });
});

describe("issuer helpers beyond the vectors", () => {
  it("honours another box domain, and refuses a malformed one", () => {
    expect(wellFormedBoxIssuer("https://pb-1.example.net", "example.net")).toBe(true);
    expect(wellFormedBoxIssuer("https://pb-1.plumbox.me", "example.net")).toBe(false);
    expect(wellFormedBoxIssuer("https://pb-1.plumbox.me:8443", "plumbox.me:8443")).toBe(false);
    expect(wellFormedBoxIssuer("https://pb-1.plumbox.me/x", "plumbox.me/x")).toBe(false);
    expect(wellFormedBoxIssuer("https://pb-1.PLUMBOX.ME", "PLUMBOX.ME")).toBe(false);
  });

  it("refuses every infrastructure label and labels longer than 63", () => {
    for (const l of ["relay", "relay-us", "relay-eu", "signal", "turn", "turn-us", "turn-eu", "wildcard", "www",
      "api", "ssh", "portal", "store", "developer", "pbsu", "testbox", "mail"]) {
      expect(wellFormedBoxIssuer(`https://${l}.plumbox.me`), l).toBe(false);
    }
    expect(wellFormedBoxIssuer(`https://${"a".repeat(63)}.plumbox.me`)).toBe(true);
    expect(wellFormedBoxIssuer(`https://${"a".repeat(64)}.plumbox.me`)).toBe(false);
  });

  it("names the box label for the portal hint", () => {
    expect(boxLabel("https://pb-1234.plumbox.me")).toBe("pb-1234");
    expect(boxLabel("https://kkjoo.plumbox.me")).toBe("kkjoo");
  });

  it("classifies IP literals as Go's net package does", () => {
    const loop = ["127.0.0.1", "127.255.0.9", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"];
    const priv = ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "fc00::1", "fd12:3456::1", "::ffff:10.1.2.3"];
    const pub = ["8.8.8.8", "172.32.0.1", "192.169.0.1", "2001:db8::1", "fe80::1"];
    for (const s of loop) expect(isLoopbackIP(parseIP(s)!), s).toBe(true);
    for (const s of priv) expect(isPrivateIP(parseIP(s)!), s).toBe(true);
    for (const s of [...priv, ...pub]) expect(isLoopbackIP(parseIP(s)!), s).toBe(false);
    for (const s of pub) expect(isPrivateIP(parseIP(s)!), s).toBe(false);
    for (const s of ["01.0.0.1", "256.0.0.1", "1.2.3", "1:2:3:4:5:6:7:8:9", "1::2::3", "::g", "localhost", ""]) {
      expect(parseIP(s), s).toBeNull();
    }
  });

  it("recognises loopback URL hostnames", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]"]) expect(isLoopbackHostname(h), h).toBe(true);
    for (const h of ["192.168.1.2", "[fe80::1]", "example.com", "localhost.example.com"]) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });

  it("accepts Dev issuers on private IPv6 and with an empty port, as the reference does", () => {
    expect(validDevIssuer("http://[fd00::5]:8080")).toBe(true);
    expect(validDevIssuer("http://[2001:db8::1]:8080")).toBe(false);
    expect(validDevIssuer("http://10.0.2.2:")).toBe(true);
    expect(validDevIssuer("http://10.0.2.2:80a")).toBe(false);
    expect(validDevIssuer("https://")).toBe(false);
  });
});
