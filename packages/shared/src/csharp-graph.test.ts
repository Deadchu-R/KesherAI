import { test } from "node:test";
import assert from "node:assert/strict";
import { addField, csValue, fieldUses, findStmt, methodToNodes, parseCSharp, plainValue, removeField, updateField, writeCSharp } from "./csharp-graph.js";

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

test("a new step and a removed step are written into the method", () => {
  const classes = parseCSharp(SCRIPT);
  const start = classes[0]!.methods[0]!;
  start.body.splice(1, 1); // remove Debug.Log
  start.body.push({ id: "n1", kind: "call", target: "Debug", name: "Log", args: ['"Ready"'], src: "", dirty: true });
  const out = writeCSharp(SCRIPT, classes);
  assert.ok(out.includes('rb = GetComponent<Rigidbody>();\n        Debug.Log("Ready");\n    }'), out.slice(out.indexOf("void Start"), out.indexOf("void Update")));
  assert.ok(!out.includes("Hello { not a block }"));
  assert.equal(parseCSharp(out)[0]!.methods[0]!.body.length, 2);
});

test("variables: add, change (type, value, Inspector, tooltip), rename everywhere, remove", () => {
  let t = SCRIPT;
  let c = parseCSharp(t)[0]!;
  assert.equal(c.indent, "    ");
  assert.deepEqual([c.fields[0]!.isPublic, c.fields[1]!.isPublic], [undefined, true]);
  assert.match(t.slice(c.fields[0]!.start, c.fields[0]!.end), /^\[SerializeField\] private float speed = 5f;$/);

  t = addField(t, c, { type: "bool", name: "canJump", value: "true", shown: true, tooltip: "Can the player jump" });
  assert.match(t, /private Rigidbody rb; \/\/ set in Start\n {4}\[Tooltip\("Can the player jump"\)\] public bool canJump = true;\n/);
  c = parseCSharp(t)[0]!;
  assert.deepEqual(c.fields.at(-1), { ...c.fields.at(-1)!, name: "canJump", type: "bool", value: "true", shown: true, tooltip: "Can the player jump", isPublic: true });
  assert.throws(() => addField(t, c, { type: "int", name: "health", shown: true }), /already used/);
  assert.throws(() => addField(t, c, { type: "int", name: "class", shown: true }), /C# word/);
  assert.throws(() => addField(t, c, { type: "int", name: "2x", shown: true }), /letters/);

  // Rename speed → moveSpeed: every use in the class changes, strings and other objects' members do not.
  const withString = t.replace('Debug.Log("Hello { not a block }");', 'Debug.Log("speed"); other.speed = speed;');
  c = parseCSharp(withString)[0]!;
  assert.equal(fieldUses(withString, c, "speed").length, 3);
  const renamed = updateField(withString, c, "speed", { type: "float", name: "moveSpeed", value: "7f", shown: true });
  assert.match(renamed, /\[UnityEngine\.Serialization\.FormerlySerializedAs\("speed"\)\] \[SerializeField\] private float moveSpeed = 7f;/);
  assert.match(renamed, /Debug\.Log\("speed"\); other\.speed = moveSpeed;/);
  assert.match(renamed, /Vector3\.right \* moveSpeed \* Time/);
  assert.doesNotMatch(renamed.replace(/"speed"/g, "").replace(/other\.speed/, ""), /\bspeed\b/);

  // Hide a public variable from the Inspector; show a private one.
  c = parseCSharp(t)[0]!;
  let u = updateField(t, c, "health", { type: "int", name: "health", value: "100", shown: false });
  assert.match(u, /\[HideInInspector\] public int health = 100;/);
  c = parseCSharp(u)[0]!;
  assert.equal(c.fields.find((f) => f.name === "health")!.shown, false);
  u = updateField(u, c, "rb", { type: "Rigidbody", name: "rb", shown: true });
  assert.match(u, /\[SerializeField\] private Rigidbody rb; \/\/ set in Start/);
  // Public ↔ private: a private variable shown in the Inspector gets [SerializeField], a public one hidden gets [HideInInspector].
  c = parseCSharp(u)[0]!;
  assert.equal(c.fields.find((f) => f.name === "rb")!.access, "private");
  assert.match(updateField(u, c, "rb", { type: "Rigidbody", name: "rb", shown: true, access: "public" }), /\n {4}public Rigidbody rb; \/\/ set in Start/);
  assert.match(updateField(u, c, "rb", { type: "Rigidbody", name: "rb", shown: false, access: "protected" }), /\n {4}protected Rigidbody rb;/);
  assert.match(addField(u, c, { type: "int", name: "lives", value: "3", shown: true, access: "private" }), /\[SerializeField\] private int lives = 3;/);

  // Remove: the whole line goes; the rest of the file is untouched.
  c = parseCSharp(t)[0]!;
  const removed = removeField(t, c, "canJump");
  assert.equal(removed, SCRIPT);
  assert.equal(removeField(SCRIPT, parseCSharp(SCRIPT)[0]!, "health"), SCRIPT.replace("    public int health = 100;\n", ""));
});

test("variables: other attributes stay, locked declarations are not touched, a class with no fields", () => {
  const src = `public class A : MonoBehaviour {\n    [Header("Move")] [Range(0, 10)] public float speed = 1f;\n    const int Max = 3;\n    int a, b;\n    void Start() { }\n}\n`;
  const c = parseCSharp(src)[0]!;
  assert.deepEqual(c.fields.map((f) => [f.name, !!f.locked]), [["speed", false], ["Max", true], ["b", true]]);
  assert.match(updateField(src, c, "speed", { type: "float", name: "speed", value: "2f", shown: true, tooltip: 'Say "hi"' }), /\[Header\("Move"\)\] \[Range\(0, 10\)\] \[Tooltip\("Say \\"hi\\""\)\] public float speed = 2f;/);
  assert.throws(() => updateField(src, c, "Max", { type: "int", name: "Max", shown: false }), /in the code/);
  const empty = `public class B : MonoBehaviour\n{\n    void Start() { }\n}\n`;
  const b = parseCSharp(empty)[0]!;
  assert.equal(addField(empty, b, { type: "GameObject", name: "target", shown: true }), `public class B : MonoBehaviour\n{\n    public GameObject target;\n\n    void Start() { }\n}\n`);
  assert.deepEqual([csValue("float", "2.5"), csValue("string", 'a"b'), csValue("bool", "TRUE"), csValue("int", "")], ["2.5f", '"a\\"b"', "true", ""]);
  assert.deepEqual([plainValue("float", "2.5f"), plainValue("string", '"a\\"b"')], ["2.5", 'a"b']);
});
