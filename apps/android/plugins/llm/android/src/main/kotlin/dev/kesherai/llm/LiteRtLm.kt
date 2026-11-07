package dev.kesherai.llm

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig

/**
 * Google's newer on-device runtime (LiteRT-LM) for `.litertlm` models such as
 * Gemma 4. It applies each model's own chat format, so the plugin passes
 * plain messages. A small Java-friendly wrapper around the Kotlin API.
 */
class LiteRtLm(private val cacheDir: String) {
    /** Receives the answer as it streams. */
    interface Sink {
        fun token(text: String)
        fun done(error: Throwable?)
    }

    private var engine: Engine? = null
    private var conversation: Conversation? = null
    @Volatile private var stopped = false

    /** Loads a model; returns "gpu" or "cpu" (whichever worked). */
    fun load(path: String, gpu: Boolean): String {
        close()
        if (gpu) {
            try {
                val e = Engine(EngineConfig(modelPath = path, backend = Backend.GPU(), cacheDir = cacheDir))
                e.initialize()
                engine = e
                return "gpu"
            } catch (t: Throwable) {
                // Fall back to the processor below.
            }
        }
        val e = Engine(EngineConfig(modelPath = path, backend = Backend.CPU(), cacheDir = cacheDir))
        e.initialize()
        engine = e
        return "cpu"
    }

    /**
     * Answers [text], given the system instruction and earlier turns
     * (roles "user" / "assistant", alternating).
     */
    fun generate(system: String, roles: List<String>, texts: List<String>, text: String, topK: Int, topP: Double, temperature: Double, sink: Sink) {
        val e = engine ?: throw IllegalStateException("No model is loaded.")
        try { conversation?.close() } catch (_: Throwable) { }
        val history = roles.indices.map { i -> if (roles[i] == "assistant") Message.model(texts[i]) else Message.user(texts[i]) }
        val c = e.createConversation(
            ConversationConfig(
                systemInstruction = Contents.of(system),
                initialMessages = history,
                samplerConfig = SamplerConfig(topK = topK, topP = topP, temperature = temperature),
            ),
        )
        conversation = c
        stopped = false
        c.sendMessageAsync(text, object : MessageCallback {
            override fun onMessage(message: Message) {
                if (!stopped) sink.token(message.toString())
            }
            override fun onDone() = sink.done(null)
            override fun onError(throwable: Throwable) = sink.done(if (stopped) null else throwable)
        })
    }

    /** Stops the answer: asks the runtime to cancel when it can, and drops the rest. */
    fun stop() {
        stopped = true
        val c = conversation ?: return
        for (name in listOf("cancelProcess", "cancel")) {
            try {
                c.javaClass.getMethod(name).invoke(c)
                return
            } catch (_: Throwable) { }
        }
    }

    fun close() {
        try { conversation?.close() } catch (_: Throwable) { }
        conversation = null
        try { engine?.close() } catch (_: Throwable) { }
        engine = null
    }
}
