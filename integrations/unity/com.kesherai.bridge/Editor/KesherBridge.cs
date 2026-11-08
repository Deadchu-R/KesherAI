// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace KesherAI.Bridge
{
    /// <summary>
    /// Connects the Unity Editor to KesherAI running on this computer.
    ///
    /// The editor is the client: it connects to ws://127.0.0.1:&lt;port&gt;/api/unity/ws
    /// (port 7420, or the KESHER_PORT environment variable) and tries again every
    /// few seconds while KesherAI is closed. Nothing listens inside Unity, and
    /// KesherAI accepts the connection only from the same computer.
    ///
    /// Messages arrive on a background thread and are handled on Unity's main
    /// thread (EditorApplication.update), because the asset APIs need it.
    /// </summary>
    [InitializeOnLoad]
    internal static class KesherBridge
    {
        const string Version = "0.1.0";
        static ClientWebSocket socket;
        static CancellationTokenSource stop;
        static readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
        static double nextTry;
        static bool connecting;

        static KesherBridge()
        {
            EditorApplication.update += Pump;
            AssemblyReloadEvents.beforeAssemblyReload += Close;
            EditorApplication.quitting += Close;
        }

        static void Close()
        {
            try
            {
                stop?.Cancel();
                socket?.Abort();
            }
            catch
            {
                // closing anyway
            }
            socket = null;
        }

        static void Pump()
        {
            while (inbox.TryDequeue(out var text)) Handle(text);
            if (connecting || (socket != null && socket.State == WebSocketState.Open)) return;
            if (EditorApplication.timeSinceStartup < nextTry) return;
            _ = Connect();
        }

        static async Task Connect()
        {
            connecting = true;
            var port = Environment.GetEnvironmentVariable("KESHER_PORT");
            if (string.IsNullOrEmpty(port)) port = "7420";
            var ws = new ClientWebSocket();
            stop = new CancellationTokenSource();
            try
            {
                await ws.ConnectAsync(new Uri("ws://127.0.0.1:" + port + "/api/unity/ws"), stop.Token);
                socket = ws;
                Send(new Dictionary<string, object>
                {
                    ["event"] = "hello",
                    ["project"] = Application.productName,
                    ["engine"] = Application.unityVersion,
                    ["bridge"] = Version,
                });
                _ = Receive(ws, stop.Token);
            }
            catch
            {
                // KesherAI is not running: try again in a few seconds, quietly.
                ws.Dispose();
                nextTry = EditorApplication.timeSinceStartup + 5;
            }
            finally
            {
                connecting = false;
            }
        }

        static async Task Receive(ClientWebSocket ws, CancellationToken token)
        {
            var buffer = new byte[64 * 1024];
            var message = new List<byte>();
            try
            {
                while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    var r = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    for (var i = 0; i < r.Count; i++) message.Add(buffer[i]);
                    if (!r.EndOfMessage) continue;
                    inbox.Enqueue(Encoding.UTF8.GetString(message.ToArray()));
                    message.Clear();
                }
            }
            catch
            {
                // dropped: Pump connects again
            }
            nextTry = 0;
        }

        static readonly SemaphoreSlim sending = new SemaphoreSlim(1, 1);

        static void Send(Dictionary<string, object> message)
        {
            var ws = socket;
            if (ws == null || ws.State != WebSocketState.Open) return;
            var bytes = Encoding.UTF8.GetBytes(Json.Write(message));
            _ = Task.Run(async () =>
            {
                await sending.WaitAsync();
                try { await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None); }
                catch { /* the connection dropped */ }
                finally { sending.Release(); }
            });
        }

        static void Handle(string text)
        {
            Dictionary<string, object> input;
            try { input = Json.Parse(text) as Dictionary<string, object>; }
            catch { return; }
            if (input == null) return;
            var id = Json.Str(input, "id");
            var cmd = Json.Str(input, "cmd");
            var path = Json.Str(input, "path");
            Dictionary<string, object> result;
            try
            {
                switch (cmd)
                {
                    case "list": result = KesherGraph.List(); break;
                    case "graph": result = KesherGraph.Read(path); break;
                    case "apply":
                        result = KesherGraph.Apply(path, input.TryGetValue("ops", out var ops) ? ops as List<object> ?? new List<object>() : new List<object>());
                        break;
                    case "compile": result = KesherGraph.Check(path); break;
                    case "save": result = KesherGraph.Save(path); break;
                    case "open": result = KesherGraph.Open(path); break;
                    case "ping": result = new Dictionary<string, object> { ["ok"] = true }; break;
                    default: result = new Dictionary<string, object> { ["error"] = "Unknown command: " + cmd }; break;
                }
            }
            catch (Exception e)
            {
                result = new Dictionary<string, object> { ["error"] = e.Message };
            }
            var answer = new Dictionary<string, object> { ["id"] = id };
            if (result.TryGetValue("error", out var err) && err != null)
            {
                answer["ok"] = false;
                answer["error"] = err.ToString();
            }
            else
            {
                answer["ok"] = true;
                answer["result"] = result;
            }
            Send(answer);
        }
    }
}
