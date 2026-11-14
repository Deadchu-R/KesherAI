import { test } from "node:test";
import assert from "node:assert/strict";
import { exprAt, parseExpr, purePath, replaceValueAt, withPureNodes, writeExpr } from "./csharp-expr.js";
import { methodToNodes, parseCSharp } from "./csharp-graph.js";

test("expressions read and write back the same", () => {
  for (const s of [
    "speed * Time.deltaTime",
    "Vector3.Distance(transform.position, target.position) < range",
    "GetComponent<Rigidbody>()",
    "new Vector3(0, jump, 0)",
    "!isGrounded && (a + b) * 2 > 3",
    "items[i].name",
    "-5",
    "-x",
    '"Hello " + name',
    "(a - b).normalized",
  ])
    assert.equal(writeExpr(parseExpr(s)), s, s);
});

test("what is not understood stays as text", () => {
  for (const s of ["x => x * 2", "a ? b : c", "(float)count", "Foo(out var x)", "a ?? b"]) assert.equal(parseExpr(s).kind, "raw", s);
  assert.equal(parseExpr("a < b").kind, "bin");
  assert.equal(parseExpr("GetComponent<Rigidbody>()").kind, "call");
});

test("a step's values become pure nodes wired into its inputs", () => {
  const cls = parseCSharp(`using UnityEngine;
public class P : MonoBehaviour {
    public float speed;
    void Update() {
        transform.Translate(Vector3.forward * speed * Time.deltaTime);
        Debug.Log("hi");
    }
}`)[0]!;
  const nodes = withPureNodes(methodToNodes(cls.methods[0]!));
  const call = nodes.find((n) => n.title === "Translate")!;
  const arg = call.pins.find((p) => p.name === "arg0")!;
  assert.equal(arg.default, undefined);
  assert.equal(arg.links?.length, 1);
  const mul = nodes.find((n) => n.id === arg.links![0]!.split(":")[0])!;
  assert.equal(mul.title, "×");
  // (forward * speed) * deltaTime: the left side is another ×; the right a Get.
  const titles = nodes.filter((n) => n.id.startsWith(`${call.id}~arg0~`)).map((n) => n.title).sort();
  assert.deepEqual(titles, ["Get Time.deltaTime", "Get Vector3.forward", "Get speed", "×", "×"]);
  // The target `transform` is a Get node; Debug (a static class) and "hi" stay as text.
  assert.ok(nodes.some((n) => n.title === "Get transform"));
  const log = nodes.find((n) => n.title === "Log")!;
  assert.equal(log.pins.find((p) => p.name === "Target")?.default, "Debug");
  assert.equal(log.pins.find((p) => p.name === "arg0")?.default, '"hi"');
});

test("a change on a pure node's input writes the step's value again", () => {
  const v = "Vector3.Distance(a, b) < range";
  const at = purePath("s1~Condition~0", v, "arg1");
  assert.deepEqual(at, { stepPin: "Condition", path: "0.2", type: "wildcard" });
  assert.equal(writeExpr(exprAt(parseExpr(v), at!.path)!), "b");
  assert.equal(replaceValueAt(v, at!.path, "enemy.position"), "Vector3.Distance(a, enemy.position) < range");
  assert.equal(replaceValueAt("a * b", "1", "c + d"), "a * (c + d)");
  assert.equal(replaceValueAt("x.y", "0", "a + b"), "(a + b).y");
});
