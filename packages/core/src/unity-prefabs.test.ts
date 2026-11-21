import { test } from "node:test";
import assert from "node:assert/strict";
import { expandPrefabs, fileIdOf, modsOf, parseDocs, setProp, yamlScalar } from "./unity-prefabs.js";

test("YAML scalars as Unity writes them: plain, quoted with \\u escapes (Hebrew), folded over lines", () => {
  assert.equal(yamlScalar("  m_text: Play\n  m_fontSize: 36\n", "m_text"), "Play");
  assert.equal(yamlScalar('  m_text: "\\u05E9\\u05DC\\u05D5\\u05DD\\n world"\n', "m_text"), "שלום\n world");
  assert.equal(yamlScalar('  m_text: "A long\n    line\n\n    two"\n  m_x: 1\n', "m_text"), "A long line\ntwo");
  assert.equal(yamlScalar("  m_text: 'It''s'\n", "m_text"), "It's");
  assert.equal(yamlScalar("  m_text: first\n    second\n  m_x: 1\n", "m_text"), "first second");
  assert.equal(yamlScalar("  m_x: 1\n", "m_text"), undefined);
});

test("overrides applied to a document's text: an inline map's key, a whole field, an object reference, a nested block", () => {
  const body = "Thing:\n  m_LocalPosition: {x: 1, y: 2, z: 3}\n  m_Name: Old\n  m_text: \"long\n    text\"\n  m_Sprite: {fileID: 0}\n  m_FontData:\n    m_FontSize: 14\n  m_Children:\n  - {fileID: 5}\n";
  let b = setProp(body, "m_LocalPosition.y", "-7.5");
  assert.match(b, /m_LocalPosition: \{x: 1, y: -7.5, z: 3\}/);
  b = setProp(b, "m_Name", "Boss Hero");
  assert.equal(yamlScalar(b, "m_Name"), "Boss Hero");
  b = setProp(b, "m_text", "new: \"quoted\"");
  assert.equal(yamlScalar(b, "m_text"), 'new: "quoted"');
  assert.doesNotMatch(b, /text"/, "the old continuation line is gone");
  b = setProp(b, "m_Sprite", "", "{fileID: 21300000, guid: 0123456789abcdef0123456789abcdef, type: 3}");
  assert.match(b, /m_Sprite: \{fileID: 21300000, guid: 0123456789abcdef/);
  b = setProp(b, "m_FontData.m_FontSize", "30");
  assert.match(b, / {4}m_FontSize: 30/);
  assert.equal(setProp(b, "m_Children.Array.data[0]", "9"), b, "array elements are not applied");
  assert.equal(setProp(b, "m_Children", "9"), b, "a block is never replaced by a scalar");
  assert.equal(setProp(b, "m_Missing.x", "1"), b);
});

test("a prefab instance's overrides are read, and a nested object's id is Unity's (instance ^ source) & 2^63-1", () => {
  const mods = modsOf("PrefabInstance:\n  m_Modification:\n    m_TransformParent: {fileID: 0}\n    m_Modifications:\n    - target: {fileID: 5, guid: 0123456789abcdef0123456789abcdef, type: 3}\n      propertyPath: m_text\n      value: \"two\n        words\"\n      objectReference: {fileID: 0}\n    - target: {fileID: 6, guid: 0123456789abcdef0123456789abcdef, type: 3}\n      propertyPath: m_Sprite\n      value: \n      objectReference: {fileID: 213, guid: abcdefabcdefabcdefabcdefabcdefab, type: 3}\n    m_RemovedComponents: []\n");
  assert.deepEqual(mods.map((m) => [m.fileID, m.path, m.value]), [["5", "m_text", "two words"], ["6", "m_Sprite", ""]]);
  assert.match(mods[1]!.objRef!, /guid: abcdef/);
  assert.equal(fileIdOf("12"), "12");
  assert.equal(fileIdOf("6~5"), "3");
  assert.equal(fileIdOf("-1~0"), "9223372036854775807");
});

test("expansion: a prefab inside itself stops (cycle guard), and the size limit keeps an instance as one box", () => {
  const G = "0123456789abcdef0123456789abcdef";
  const self = `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Loop\n--- !u!4 &2\nTransform:\n  m_GameObject: {fileID: 1}\n  m_Father: {fileID: 0}\n--- !u!1001 &3\nPrefabInstance:\n  m_Modification:\n    m_TransformParent: {fileID: 2}\n    m_Modifications: []\n  m_SourcePrefab: {fileID: 100100000, guid: ${G}, type: 3}\n`;
  const scene = parseDocs(`%YAML 1.1\n--- !u!1001 &9\nPrefabInstance:\n  m_Modification:\n    m_TransformParent: {fileID: 0}\n    m_Modifications: []\n  m_SourcePrefab: {fileID: 100100000, guid: ${G}, type: 3}\n`);
  const docs = expandPrefabs(scene, new Map([[G, self]]));
  assert.deepEqual(docs.map((d) => d.id), ["9~1", "9~2", "9~3"], "the inner copy of itself stays a PrefabInstance");
  assert.equal(docs.find((d) => d.id === "9~2")!.instanceRoot, "9");
  assert.deepEqual(expandPrefabs(scene, new Map([[G, self]]), { docs: 1 }).map((d) => d.id), ["9"]);
});
