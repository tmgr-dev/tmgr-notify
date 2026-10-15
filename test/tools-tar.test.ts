import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFiles } from "../tools/tar.js";
import { makeTar, tarHeader } from "./tools-tar-helper.js";

const NAME = "tmgr-1.0.1-x/tmgr";
const body = Buffer.from("binary-bytes");

test("extracts wanted regular files and ignores the rest", () => {
  const tar = makeTar([
    { name: "tmgr-1.0.1-x/", type: "5" },
    { name: "../x", data: Buffer.from("nope") },
    { name: NAME, data: body },
    { name: "tmgr-1.0.1-x/LICENSE", data: Buffer.from("lic") },
    { name: "tmgr-1.0.1-x/README.txt", data: Buffer.from("readme") },
  ]);
  const files = extractFiles(tar, [NAME, "tmgr-1.0.1-x/LICENSE"]);
  assert.deepEqual([...files.keys()], [NAME, "tmgr-1.0.1-x/LICENSE"]);
  assert.deepEqual(files.get(NAME), body);
});

test("joins ustar prefix and name", () => {
  const tar = makeTar([{ name: "tmgr", prefix: "tmgr-1.0.1-x", data: body }]);
  assert.deepEqual(extractFiles(tar, [NAME]).get(NAME), body);
});

test("rejects unsafe wanted names", () => {
  const tar = makeTar([{ name: NAME, data: body }]);
  for (const bad of ["../evil", "/abs/tmgr", "a/../b", "a\\b", "", "a//b"]) {
    assert.throws(() => extractFiles(tar, [bad]), /unsafe wanted name/);
  }
});

test("never returns unrelated entries even when named like traversal", () => {
  const tar = makeTar([
    { name: "../evil", data: Buffer.from("x") },
    { name: NAME, data: body },
  ]);
  const files = extractFiles(tar, [NAME]);
  assert.equal(files.size, 1);
  assert.equal(files.has("../evil"), false);
});

test("rejects symlink, hardlink and directory with a wanted name", () => {
  for (const type of ["2", "1", "5", "3"]) {
    const tar = makeTar([{ name: NAME, type }]);
    assert.throws(() => extractFiles(tar, [NAME]), /not a regular file/, `type ${type}`);
  }
});

test("rejects duplicate wanted entries", () => {
  const tar = makeTar([
    { name: NAME, data: body },
    { name: NAME, data: body },
  ]);
  assert.throws(() => extractFiles(tar, [NAME]), /duplicate entry/);
});

test("rejects a missing wanted entry", () => {
  const tar = makeTar([{ name: "other", data: body }]);
  assert.throws(() => extractFiles(tar, [NAME]), /missing entry/);
});

test("rejects a corrupt header checksum", () => {
  const tar = makeTar([{ name: NAME, data: body, corruptChecksum: true }]);
  assert.throws(() => extractFiles(tar, [NAME]), /checksum/);
});

test("rejects a truncated archive", () => {
  const tar = makeTar([{ name: NAME, data: Buffer.alloc(2000, 1) }]);
  assert.throws(() => extractFiles(tar.subarray(0, 512 + 600), [NAME]), /exceeds archive size/);
});

test("rejects a wanted entry preceded by a pax or long-name header", () => {
  for (const type of ["x", "L"]) {
    const ext = makeTar([{ name: "ext", type, data: Buffer.from("path=elsewhere\n") }]).subarray(
      0,
      1024,
    );
    const real = Buffer.concat([tarHeader({ name: NAME, data: body }), Buffer.alloc(512)]);
    real.write(body.toString(), 512);
    const tar = Buffer.concat([ext, real, Buffer.alloc(1024)]);
    assert.throws(() => extractFiles(tar, [NAME]), /extended header/);
  }
});
