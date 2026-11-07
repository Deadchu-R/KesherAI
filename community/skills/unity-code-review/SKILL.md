---
name: unity-code-review
description: "Review Unity C# scripts for bugs, performance problems and Unity pitfalls. Use when the user asks to review, check or improve MonoBehaviour, ScriptableObject or other Unity C# code."
---

# Reviewing Unity C# code

Read the whole script (and the scripts it calls, if they are in the project) before you comment.

## Look for, in this order

1. **Bugs**: null references after `Destroy`, `GetComponent` results used without a check, coroutines that never stop, events subscribed in `OnEnable` but not removed in `OnDisable`, `==` on destroyed `UnityEngine.Object`s compared with `?.` or `??` (which skip Unity's null check).
2. **Per-frame cost**: allocations in `Update`/`FixedUpdate`/`LateUpdate` (LINQ, `new List`, string concatenation, boxing, `GetComponent`, `Find*`, `Camera.main` in old versions), physics queries without the `NonAlloc` variants, `SendMessage`.
3. **Physics**: moving a Rigidbody through `transform` instead of `MovePosition`/velocity, physics in `Update` instead of `FixedUpdate`, input read in `FixedUpdate` (missed presses).
4. **Lifecycle**: work in `Awake` that needs other objects' `Awake` to have run (use `Start`), order assumptions between scripts, `DontDestroyOnLoad` duplicates.
5. **Serialization**: public fields that should be `[SerializeField] private`, renamed fields that lose their values (`[FormerlySerializedAs]`), non-serializable types in inspector fields.
6. **Structure**: very large MonoBehaviours, hard references that should be events or ScriptableObjects — only when it really hurts.

## How to answer

- Start with a one-line verdict.
- Then each real problem: the line, why it is a problem, and the fixed code.
- Then small improvements, briefly.
- Do not invent problems. If the code is fine, say so.
- Ask for the Unity version and render pipeline only when the answer depends on them.
