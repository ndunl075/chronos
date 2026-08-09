import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_SCHEMA_VERSION,
  canonicalEnvelope,
  isCanonicalEnvelope,
  isJsonValue,
  isLogicalSequence,
  logicalSequence,
} from "../dist/index.js";

test("logical sequences are finite safe integers starting at one", () => {
  assert.equal(isLogicalSequence(1), true);
  assert.equal(isLogicalSequence(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isLogicalSequence(0), false);
  assert.equal(isLogicalSequence(1.5), false);
  assert.equal(isLogicalSequence(Number.POSITIVE_INFINITY), false);
  assert.equal(logicalSequence(1), 1);
  assert.throws(() => logicalSequence(0), RangeError);
});

test("JSON validation accepts canonical data and rejects unsafe values", () => {
  assert.equal(isJsonValue({ nested: [null, true, 3, "value"] }), true);
  assert.equal(isJsonValue({ missing: undefined }), false);
  assert.equal(isJsonValue(new Date()), false);

  const sparse = [];
  sparse.length = 1;
  assert.equal(isJsonValue(sparse), false);

  const spoofedSparse = [];
  spoofedSparse.length = 1;
  spoofedSparse.extra = "not an index";
  assert.equal(isJsonValue(spoofedSparse), false);

  const symbolProperty = { visible: true };
  symbolProperty[Symbol("hidden")] = true;
  assert.equal(isJsonValue(symbolProperty), false);

  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, "hidden", { value: true });
  assert.equal(isJsonValue(nonEnumerable), false);

  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.equal(isJsonValue(accessor), false);

  const hostileProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile trap");
      },
    },
  );
  assert.equal(isJsonValue(hostileProxy), false);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(isJsonValue(cyclic), false);
});

test("canonical envelopes carry the current schema and JSON data", () => {
  const envelope = canonicalEnvelope({ redacted: "[REDACTED]" });
  assert.deepEqual(envelope, {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    data: { redacted: "[REDACTED]" },
  });
  assert.equal(isCanonicalEnvelope(envelope), true);
  assert.equal(isCanonicalEnvelope({ schemaVersion: 2, data: null }), false);
  assert.equal(isCanonicalEnvelope({ schemaVersion: 1 }), false);
  assert.equal(
    isCanonicalEnvelope({ schemaVersion: 1, data: Number.NaN }),
    false,
  );
  assert.throws(
    () => canonicalEnvelope(/** @type {*} */ (Number.NaN)),
    TypeError,
  );
});

test("canonical envelope guard is total for hostile and inherited input", () => {
  const versionGetter = { data: null };
  Object.defineProperty(versionGetter, "schemaVersion", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.equal(isCanonicalEnvelope(versionGetter), false);

  const dataGetter = { schemaVersion: 1 };
  Object.defineProperty(dataGetter, "data", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.equal(isCanonicalEnvelope(dataGetter), false);

  const hostileProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile trap");
      },
    },
  );
  assert.equal(isCanonicalEnvelope(hostileProxy), false);

  const inheritedVersion = Object.create({ schemaVersion: 1 });
  inheritedVersion.data = null;
  assert.equal(isCanonicalEnvelope(inheritedVersion), false);

  const symbolKey = canonicalEnvelope(null);
  symbolKey[Symbol("extra")] = true;
  assert.equal(isCanonicalEnvelope(symbolKey), false);

  const nonEnumerable = {};
  Object.defineProperties(nonEnumerable, {
    schemaVersion: { value: 1, enumerable: true },
    data: { value: null },
  });
  assert.equal(isCanonicalEnvelope(nonEnumerable), false);
});
