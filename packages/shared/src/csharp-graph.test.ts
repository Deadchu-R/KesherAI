import { test } from "node:test";
import assert from "node:assert/strict";
import { findStmt, methodToNodes, parseCSharp, writeCSharp } from "./csharp-graph.js";

const SCRIPT = `using UnityEngine;
using System.Collections;

public class Player : MonoBehaviour
{
    [SerializeField] private float speed = 5f;
    public int health = 100;
    private Rigidbody rb; // set in Start

    void Start()
    {
        rb = GetComponent<Rigidbody>();
        Debug.Log("Hello { not a block }");
    }

    void Update()
    {
        float h = Input.GetAxis("Horizontal");
        if (h > 0.1f)
        {
            transform.Translate(Vector3.right * speed * Time.deltaTime);
        }
        else if (h < -0.1f) transform.Translate(Vector3.left * speed * Time.deltaTime);
        foreach (var e in FindObjectsByType<Enemy>(FindObjectsSortMode.None)) {
            e.Alert(transform.position, 3);
        }
        health--;
    }

    void OnTriggerEnter(Collider other)
    {
        switch (other.tag) { case "Coin": score++; break; default: break; }
        StartCoroutine(Flash(0.2f));
    }

    IEnumerator Flash(float t) { yield return new WaitForSeconds(t); }
}
`;

test("reads fields, methods and statements of a Unity script", () => {
  const [c] = parseCSharp(SCRIPT);
  assert.equal(c!.name, "Player");
  assert.equal(c!.base, "MonoBehaviour");
  assert.deepEqual(c!.fields.map((f) => [f.name, f.shown]), [["speed", true], ["health", true], ["rb", false]]);
  assert.deepEqual(c!.methods.map((m) => m.name), ["Start", "Update", "OnTriggerEnter", "Flash"]);
  const update = c!.methods[1]!;
  assert.deepEqual(update.body.map((s) => s.kind), ["local", "if", "loop", "set"]);
  const branch = update.body[1]!;
  assert.ok(branch.kind === "if" && branch.cond === "h > 0.1f" && branch.else?.[0]?.kind === "if");
  const start = c!.methods[0]!;
  assert.deepEqual(start.body.map((s) => s.kind), ["set", "call"]);
  assert.ok(start.body[1]!.kind === "call" && start.body[1]!.target === "Debug" && start.body[1]!.args[0] === '"Hello { not a block }"');
  assert.equal(c!.methods[2]!.body[0]!.kind, "code", "switch stays as code");
  assert.equal(c!.methods[1]!.params.length, 0);
  assert.deepEqual(c!.methods[2]!.params, [{ type: "Collider", name: "other" }]);
});

test("nothing changed: the file comes back byte for byte", () => {
  assert.equal(writeCSharp(SCRIPT, parseCSharp(SCRIPT)), SCRIPT);
});

test("an edited value rewrites only that method, and the result parses the same way", () => {
  const classes = parseCSharp(SCRIPT);
  const update = classes[0]!.methods[1]!;
  const branch = update.body[1]!;
  assert.ok(branch.kind === "if");
  branch.cond = "h > 0.5f";
  branch.dirty = true;
  const out = writeCSharp(SCRIPT, classes);
  assert.match(out, /if \(h > 0\.5f\) \{/);
  assert.ok(out.includes('Debug.Log("Hello { not a block }");'), "other methods untouched");
  assert.ok(out.includes("switch (other.tag) { case \"Coin\": score++; break; default: break; }"));
  const again = parseCSharp(out)[0]!.methods[1]!;
  assert.deepEqual(again.body.map((s) => s.kind), ["local", "if", "loop", "set"]);
  const call = findStmt(again.body, again.body[2]!.kind === "loop" ? again.body[2]!.body[0]!.id : "")!;
  assert.ok(call.stmt.kind === "call" && call.stmt.name === "Alert" && call.stmt.args.length === 2);
});

test("a method as nodes: event, branch with True/False, loop body, wired in order", () => {
  const m = parseCSharp(SCRIPT)[0]!.methods[1]!;
  const nodes = methodToNodes(m);
  assert.equal(nodes[0]!.title, "Event Update");
  const branch = nodes.find((n) => n.title === "Branch")!;
  assert.equal(branch.pins.find((p) => p.name === "Condition")!.default, "h > 0.1f");
  assert.ok(branch.pins.find((p) => p.name === "True")!.links!.length === 1);
  assert.ok(nodes.some((n) => n.title === "For Each Loop"));
  assert.ok(nodes.some((n) => n.title === "Alert" && n.pins.filter((p) => p.name.startsWith("arg")).length === 2));
  const local = nodes.find((n) => n.title === "float h")!;
  assert.deepEqual(nodes[0]!.pins[0]!.links, [`${local.id}:execute`]);
});
