import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import {
  classifyAddress,
  networkPermissionTarget,
  networkTargetReason,
  resolveNetworkTarget,
  setLookupForTests,
} from "./network-target.js";

describe("classifyAddress", () => {
  const cases: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["169.254.169.254", "link-local"],
    ["169.254.0.1", "link-local"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local"],
    ["febf::1", "link-local"],
    ["fd00:ec2::254", "private"],
    ["fc00::1", "private"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["100.127.255.255", "private"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["::", "unspecified"],
    ["224.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["ff02::1", "reserved"],
    // IPv4 inside IPv6
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:a9fe:a9fe", "link-local"],
    ["::ffff:10.1.2.3", "private"],
    ["::127.0.0.1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["2002:7f00:1::", "loopback"],
    ["::ffff:8.8.8.8", "public"],
    // public
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
    ["172.15.255.255", "public"],
    ["172.32.0.1", "public"],
    ["100.63.255.255", "public"],
    ["100.128.0.1", "public"],
    ["169.253.1.1", "public"],
    ["2606:4700:4700::1111", "public"],
    ["2001:db8::1", "public"],
    // unparseable is never public
    ["not-an-ip", "reserved"],
  ];
  for (const [ip, want] of cases) {
    it(`${ip} is ${want}`, () => assert.strictEqual(classifyAddress(ip), want));
  }
});

describe("resolveNetworkTarget", () => {
  afterEach(() => setLookupForTests(null));

  it("classifies IP literals the WHATWG URL parser normalizes, without DNS", async () => {
    setLookupForTests(async () => {
      throw new Error("DNS must not be used for IP literals");
    });
    for (const url of [
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0177.0.0.1/",
      "http://017700000001/",
      "http://127.1:8080/",
      "http://[::1]:3000/",
      "http://[::ffff:127.0.0.1]/",
      "http://[0:0:0:0:0:0:0:1]/",
    ]) {
      const target = await resolveNetworkTarget(url);
      assert.strictEqual(target.nonPublic?.class, "loopback", url);
    }
    assert.strictEqual((await resolveNetworkTarget("http://0/")).nonPublic?.class, "unspecified");
    assert.strictEqual((await resolveNetworkTarget("http://[::]/")).nonPublic?.class, "unspecified");
    assert.strictEqual((await resolveNetworkTarget("http://169.254.169.254/latest/meta-data/")).nonPublic?.class, "link-local");
    assert.strictEqual((await resolveNetworkTarget("http://[fd00:ec2::254]/")).nonPublic?.class, "private");
    assert.strictEqual((await resolveNetworkTarget("https://8.8.8.8/")).nonPublic, null);
  });

  it("treats localhost names as loopback", async () => {
    setLookupForTests(async () => ["93.184.216.34"]);
    assert.strictEqual((await resolveNetworkTarget("http://localhost:3000/")).nonPublic?.class, "loopback");
    assert.strictEqual((await resolveNetworkTarget("http://LOCALHOST./")).nonPublic?.class, "loopback");
    assert.strictEqual((await resolveNetworkTarget("http://app.localhost/")).nonPublic?.class, "loopback");
  });

  it("resolves names and flags any non-public address", async () => {
    const answers: Record<string, string[]> = {
      "rebind.attacker.test": ["127.0.0.1"],
      "metadata.google.internal": ["169.254.169.254"],
      "mixed.test": ["93.184.216.34", "10.0.0.5"],
      "example.test": ["93.184.216.34", "2606:2800:220:1::1"],
    };
    setLookupForTests(async (name) => answers[name] ?? []);
    assert.strictEqual((await resolveNetworkTarget("http://rebind.attacker.test/")).nonPublic?.class, "loopback");
    assert.strictEqual((await resolveNetworkTarget("http://metadata.google.internal/")).nonPublic?.class, "link-local");
    assert.strictEqual((await resolveNetworkTarget("http://mixed.test/")).nonPublic?.address, "10.0.0.5");
    assert.strictEqual((await resolveNetworkTarget("https://example.test/")).nonPublic, null);
  });

  it("rejects non-http(s) schemes", async () => {
    for (const url of ["file:///etc/passwd", "data:text/plain,hi", "ftp://example.com/", "gopher://127.0.0.1/"]) {
      await assert.rejects(resolveNetworkTarget(url), /only opens http\(s\) URLs/, url);
    }
    await assert.rejects(resolveNetworkTarget("not a url"), /absolute http\(s\) URL/);
  });
});

describe("networkTargetReason", () => {
  afterEach(() => setLookupForTests(null));

  it("names the address for a non-public target and is null for a public one", async () => {
    setLookupForTests(async (name) => (name === "public.test" ? ["93.184.216.34"] : ["127.0.0.1"]));
    assert.strictEqual(
      await networkTargetReason("http://127.0.0.1:4000/", "web_fetch"),
      "fetches a local or private network address (127.0.0.1, loopback)",
    );
    assert.strictEqual(
      await networkTargetReason("http://dev.test/", "web_fetch"),
      "fetches a local or private network address (dev.test → 127.0.0.1, loopback)",
    );
    assert.strictEqual(await networkTargetReason("https://public.test/", "web_fetch"), null);
    // Invalid URLs are left to the tool, which rejects them.
    assert.strictEqual(await networkTargetReason("file:///etc/passwd", "web_fetch"), null);
  });

  it("approvals are per origin", () => {
    assert.strictEqual(networkPermissionTarget("http://localhost:3000/a?b=1"), "http://localhost:3000");
    assert.notStrictEqual(networkPermissionTarget("http://localhost:3000/"), networkPermissionTarget("http://localhost:4000/"));
    assert.strictEqual(networkPermissionTarget("http://[::1]:80/"), "http://[::1]");
  });
});
