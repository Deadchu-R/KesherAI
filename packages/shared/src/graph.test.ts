import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileExpr, parseGraph } from "./graph.js";

describe("compileExpr", () => {
  const at = (s: string, x: number, v: Record<string, number> = {}, names: string[] = Object.keys(v)) => compileExpr(s, names)(x, v);
  it("follows precedence and implicit multiplication", () => {
    assert.equal(at("2x^2 + 3x - 1", 2), 13);
    assert.equal(at("-x^2", 3), -9);
    assert.equal(at("2^3^2", 0), 512);
    assert.equal(at("3(x+1)", 1), 6);
    assert.ok(Math.abs(at("a sin(b*x)", Math.PI / 2, { a: 2, b: 1 }) - 2) < 1e-6);
    assert.equal(at("ax", 3, { a: 2 }), 6);
    assert.equal(at("|x - 5|", 2), 3);
    assert.ok(Math.abs(at("sin^2(x) + cos^2(x)", 0.7) - 1) < 1e-6);
    assert.ok(Math.abs(at("e^x", 1) - Math.E) < 1e-6);
    assert.equal(at("x²/2 − 3", 2), -1);
    assert.ok(Number.isNaN(at("sqrt(x)", -1)));
  });
  it("refuses code", () => {
    assert.throws(() => compileExpr("alert(1)"));
    assert.throws(() => compileExpr("x; process.exit()"));
    assert.throws(() => compileExpr("constructor"));
  });
});

describe("parseGraph", () => {
  it("reads functions, ranges and sliders", () => {
    const g = parseGraph("y = a*sin(b*x)\ny = x^2/2 - 3\nx: -7..7\ny: -5..5\na = 2 (0..5)\nb = 1.5 (0.1..4)")!;
    assert.equal(g.fns.length, 2);
    assert.deepEqual(g.x, [-7, 7]);
    assert.deepEqual(g.y, [-5, 5]);
    assert.deepEqual(g.params.map((p) => [p.name, p.value, p.min, p.max]), [["a", 2, 0, 5], ["b", 1.5, 0.1, 4]]);
    assert.ok(Math.abs(g.fns[0]!.f(Math.PI / 3, { a: 2, b: 1.5 }) - 2) < 1e-6);
  });
  it("is undefined when nothing can be drawn", () => {
    assert.equal(parseGraph("y = ("), undefined);
    assert.equal(parseGraph(""), undefined);
  });
  it("accepts f(x) = and pi ranges", () => {
    const g = parseGraph("f(x) = cos x\nx: -pi..pi")!;
    assert.ok(Math.abs(g.x[0] - -Math.PI) < 1e-6);
    assert.equal(g.fns[0]!.f(0, {}), 1);
  });
});
