@tool
extends EditorPlugin
## KesherAI Bridge: connects the Godot editor to KesherAI on this computer (never the other way round) and answers
## its commands. Every change goes through the editor's undo history, so Ctrl+Z takes it back.

const VERSION := "0.1.1"
const URL := "ws://127.0.0.1:7420/api/godot/ws"

var _ws := WebSocketPeer.new()
var _connected := false
var _retry := 0.0

func _enter_tree() -> void:
	set_process(true)
	_open()

func _exit_tree() -> void:
	_ws.close()

func _open() -> void:
	_ws = WebSocketPeer.new()
	_ws.inbound_buffer_size = 16 * 1024 * 1024
	_ws.outbound_buffer_size = 16 * 1024 * 1024
	_ws.connect_to_url(URL)

func _process(delta: float) -> void:
	_ws.poll()
	var state := _ws.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN:
		if not _connected:
			_connected = true
			_send({"event": "hello", "project": ProjectSettings.get_setting("application/config/name", "Project"), "engine": Engine.get_version_info().string, "bridge": VERSION, "projectFile": ProjectSettings.globalize_path("res://project.godot"), "pid": OS.get_process_id(), "csharp": _has_csproj()})
		while _ws.get_available_packet_count() > 0:
			_on_message(_ws.get_packet().get_string_from_utf8())
	elif state == WebSocketPeer.STATE_CLOSED:
		_connected = false
		_retry += delta
		if _retry > 5.0:
			_retry = 0.0
			_open()

func _has_csproj() -> bool:
	for f in DirAccess.get_files_at("res://"):
		if f.ends_with(".csproj"):
			return true
	return false

func _send(msg: Dictionary) -> void:
	_ws.send_text(JSON.stringify(msg))

func _on_message(text: String) -> void:
	var msg = JSON.parse_string(text)
	if typeof(msg) != TYPE_DICTIONARY or not msg.has("id") or not msg.has("cmd"):
		return
	var out := {"id": msg.id}
	var r = _run(String(msg.cmd), msg)
	if typeof(r) == TYPE_DICTIONARY and r.has("error"):
		out["ok"] = false
		out["error"] = r.error
	else:
		out["ok"] = true
		out["result"] = r
	_send(out)

func _root() -> Node:
	return EditorInterface.get_edited_scene_root()

func _node(path: String) -> Node:
	var root := _root()
	if root == null:
		return null
	if path == "" or path == "." or path == root.name:
		return root
	return root.get_node_or_null(NodePath(path))

func _res(path: String) -> String:
	# Only files inside the project.
	if not path.begins_with("res://") or path.contains(".."):
		return ""
	return path

func _tree(n: Node, depth: int) -> Dictionary:
	var d := {"name": n.name, "type": n.get_class()}
	var s = n.get_script()
	if s:
		d["script"] = s.resource_path
	if depth > 0 and n.get_child_count() > 0:
		var kids := []
		for c in n.get_children():
			if c.owner == _root() or c == _root():
				kids.append(_tree(c, depth - 1))
		d["children"] = kids
	return d

func _value(v):
	match typeof(v):
		TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I, TYPE_COLOR, TYPE_RECT2, TYPE_TRANSFORM2D, TYPE_TRANSFORM3D, TYPE_QUATERNION, TYPE_BASIS:
			return var_to_str(v)
		TYPE_OBJECT:
			return v.resource_path if v is Resource and v.resource_path != "" else (v.get_class() if v else null)
		_:
			return v

func _parse(v, current):
	# Values come as JSON; Godot types are written like Vector2(1, 2) or Color(1, 0, 0, 1).
	if typeof(v) == TYPE_STRING and typeof(current) != TYPE_STRING and typeof(current) != TYPE_STRING_NAME:
		if v.begins_with("res://"):
			return load(v)
		var p = str_to_var(v)
		if p != null:
			return p
	if typeof(current) == TYPE_INT and typeof(v) == TYPE_FLOAT:
		return int(v)
	return v

func _run(cmd: String, a: Dictionary):
	var ur := get_undo_redo()
	match cmd:
		"ping":
			return "pong"
		"tree":
			var root := _root()
			if root == null:
				return {"scene": null}
			return {"scene": root.scene_file_path, "root": _tree(root, int(a.get("depth", 6)))}
		"get":
			var n := _node(String(a.get("path", "")))
			if n == null:
				return {"error": "No such node."}
			var props := {}
			for p in n.get_property_list():
				if p.usage & PROPERTY_USAGE_EDITOR and not String(p.name).begins_with("_"):
					props[p.name] = _value(n.get(p.name))
			return {"name": n.name, "type": n.get_class(), "properties": props}
		"add":
			var parent := _node(String(a.get("parent", "")))
			if parent == null:
				return {"error": "No such parent node."}
			var t := String(a.get("type", "Node"))
			var n: Node
			if t.begins_with("res://") and t.ends_with(".tscn"):
				n = load(t).instantiate()
			elif ClassDB.class_exists(t) and ClassDB.is_parent_class(t, "Node") and ClassDB.can_instantiate(t):
				n = ClassDB.instantiate(t)
			else:
				return {"error": "Unknown node type: " + t}
			n.name = String(a.get("name", t))
			ur.create_action("KesherAI: add " + n.name)
			ur.add_do_method(parent, "add_child", n, true)
			ur.add_do_method(n, "set_owner", _root())
			ur.add_do_reference(n)
			ur.add_undo_method(parent, "remove_child", n)
			ur.commit_action()
			return {"path": String(_root().get_path_to(n))}
		"set":
			var n := _node(String(a.get("path", "")))
			if n == null:
				return {"error": "No such node."}
			var prop := String(a.get("property", ""))
			if not prop in n:
				return {"error": "The node has no property " + prop}
			var old = n.get(prop)
			var raw = a.get("value")
			if typeof(raw) == TYPE_STRING and String(raw).begins_with("res://") and not ResourceLoader.exists(String(raw)):
				return {"error": "No such resource: " + String(raw)}
			var nv = _parse(raw, old)
			ur.create_action("KesherAI: set " + prop)
			ur.add_do_property(n, prop, nv)
			ur.add_undo_property(n, prop, old)
			ur.commit_action()
			return {"value": _value(n.get(prop))}
		"remove":
			var n := _node(String(a.get("path", "")))
			if n == null or n == _root():
				return {"error": "No such node (the root cannot be removed)."}
			var parent := n.get_parent()
			ur.create_action("KesherAI: remove " + n.name)
			ur.add_do_method(parent, "remove_child", n)
			ur.add_undo_method(parent, "add_child", n, true)
			ur.add_undo_method(n, "set_owner", _root())
			ur.add_undo_reference(n)
			ur.commit_action()
			return true
		"attach_script":
			var n := _node(String(a.get("path", "")))
			var sp := _res(String(a.get("script", "")))
			if n == null or sp == "":
				return {"error": "A node and a res:// script are needed."}
			var scr = load(sp)
			ur.create_action("KesherAI: attach script")
			ur.add_do_method(n, "set_script", scr)
			ur.add_undo_method(n, "set_script", n.get_script())
			ur.commit_action()
			return true
		"open":
			var p := _res(String(a.get("scene", "")))
			if p == "" or not FileAccess.file_exists(p):
				return {"error": "No such scene."}
			EditorInterface.open_scene_from_path(p)
			return true
		"new_scene":
			var p := _res(String(a.get("scene", "")))
			var t := String(a.get("root", "Node2D"))
			if p == "" or not p.ends_with(".tscn") or not ClassDB.class_exists(t):
				return {"error": "A res://….tscn path and a root type are needed."}
			if FileAccess.file_exists(p):
				return {"error": "That scene already exists."}
			var root: Node = ClassDB.instantiate(t)
			root.name = p.get_file().get_basename()
			var packed := PackedScene.new()
			packed.pack(root)
			DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(p.get_base_dir()))
			ResourceSaver.save(packed, p)
			root.free()
			EditorInterface.get_resource_filesystem().scan()
			EditorInterface.open_scene_from_path(p)
			return true
		"save":
			return EditorInterface.save_scene() == OK
		"read":
			var p := _res(String(a.get("file", "")))
			if p == "" or not FileAccess.file_exists(p):
				return {"error": "No such file."}
			return {"text": FileAccess.get_file_as_string(p)}
		"write":
			var p := _res(String(a.get("file", "")))
			if p == "":
				return {"error": "Files are written inside the project (res://) only."}
			DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(p.get_base_dir()))
			var f := FileAccess.open(p, FileAccess.WRITE)
			if f == null:
				return {"error": "Could not write the file."}
			f.store_string(String(a.get("text", "")))
			f.close()
			EditorInterface.get_resource_filesystem().update_file(p)
			EditorInterface.get_resource_filesystem().scan()
			return true
		"files":
			var out := []
			_list("res://", out, 0)
			return {"files": out}
		"run":
			if String(a.get("scene", "")) != "":
				EditorInterface.play_custom_scene(_res(String(a.scene)))
			elif a.get("current", false):
				EditorInterface.play_current_scene()
			else:
				EditorInterface.play_main_scene()
			return true
		"stop":
			EditorInterface.stop_playing_scene()
			return true
		"playing":
			return EditorInterface.is_playing_scene()
		"log":
			# The running game's log (file logging is on by default in Godot 4).
			var lp := "user://logs/godot.log"
			if not FileAccess.file_exists(lp):
				return {"text": ""}
			var t := FileAccess.get_file_as_string(lp)
			return {"text": t.substr(max(0, t.length() - 12000))}
		"screenshot":
			var vp: Viewport = EditorInterface.get_editor_viewport_3d(0) if String(a.get("view", "2d")) == "3d" else EditorInterface.get_editor_viewport_2d()
			var img := vp.get_texture().get_image()
			if img.get_width() > 1280:
				img.resize(1280, int(img.get_height() * 1280.0 / img.get_width()))
			return {"png": Marshalls.raw_to_base64(img.save_png_to_buffer())}
		_:
			return {"error": "Unknown command " + cmd}

func _list(dir: String, out: Array, depth: int) -> void:
	if depth > 8 or out.size() > 2000:
		return
	for f in DirAccess.get_files_at(dir):
		if f.get_extension() in ["gd", "cs", "tscn", "tres", "gdshader", "cfg", "json"]:
			out.append(dir.path_join(f))
	for d in DirAccess.get_directories_at(dir):
		if d.begins_with(".") or d == "addons" and dir == "res://":
			continue
		_list(dir.path_join(d), out, depth + 1)
