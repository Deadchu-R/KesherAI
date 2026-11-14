import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCSharp } from "./csharp-graph.js";
import { collapseToFunction } from "./csharp-collapse.js";

const SCRIPT = `using UnityEngine;

public class Player : MonoBehaviour
{
    public float speed = 5f;

    void Update()
    {
        float h = Input.GetAxis("Horizontal");
        Debug.Log("moving");
        transform.Translate(h * speed * Time.deltaTime, 0, 0);
        Debug.Log("moved");
    }
}
`;

test("collapse to function: the steps move into a new method, a call takes their place, read values become parameters", () => {
  const classes = parseCSharp(SCRIPT);
  const body = classes[0]!.methods[0]!.body;
  const r = collapseToFunction(SCRIPT, classes, 0, "Update", [body[1]!.id, body[2]!.id], "Move");
  assert.ok("text" in r, JSON.stringify(r));
  const t = (r as { text: string }).text;
  assert.match(t, /float h = Input\.GetAxis\("Horizontal"\);\n\s+Move\(h\);\n\s+Debug\.Log\("moved"\);/);
  assert.match(t, /private void Move\(float h\)\n {4}\{\n {8}Debug\.Log\("moving"\);\n {8}transform\.Translate\(h \* speed \* Time\.deltaTime, 0, 0\);\n {4}\}\n\}/);
  // The new script reads back with both methods.
  assert.deepEqual(parseCSharp(t)[0]!.methods.map((m) => m.name), ["Update", "Move"]);
});

test("collapse to function: refused for steps apart, a variable used after, a taken name", () => {
  const fresh = () => parseCSharp(SCRIPT);
  let c = fresh();
  let b = c[0]!.methods[0]!.body;
  assert.match((collapseToFunction(SCRIPT, c, 0, "Update", [b[1]!.id, b[3]!.id], "X") as { error: string }).error, /follow one another/);
  c = fresh();
  b = c[0]!.methods[0]!.body;
  assert.match((collapseToFunction(SCRIPT, c, 0, "Update", [b[0]!.id, b[1]!.id], "X") as { error: string }).error, /h is made in these steps/);
  c = fresh();
  b = c[0]!.methods[0]!.body;
  assert.match((collapseToFunction(SCRIPT, c, 0, "Update", [b[1]!.id], "Update") as { error: string }).error, /already has Update/);
});
