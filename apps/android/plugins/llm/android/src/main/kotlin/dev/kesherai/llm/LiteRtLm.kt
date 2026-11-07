package dev.kesherai.llm

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
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
    private var path = ""
    private var onGpu = false
    private var conversation: Conversation? = null
    @Volatile private var stopped = false

    /** Whether the loaded model was set up to see images. */
    var seesImages = false
        private set

    private fun start(path: String, gpu: Boolean, vision: Boolean): Engine {
        val main = if (gpu) Backend.GPU() else Backend.CPU()
        val cfg = if (vision) EngineConfig(modelPath = path, backend = main, visionBackend = Backend.GPU(), cacheDir = cacheDir)
        else EngineConfig(modelPath = path, backend = main, cacheDir = cacheDir)
        val e = Engine(cfg)
        try {
            e.initialize()
        } catch (t: Throwable) {
            try { e.close() } catch (_: Throwable) { }
            throw t
        }
        return e
    }

    /** Loads a model (with image understanding when it has it); returns "gpu" or "cpu". */
    fun load(path: String, gpu: Boolean): String {
        close()
        val tries = if (gpu) listOf(true to true, true to false, false to true, false to false) else listOf(false to true, false to false)
        var last: Throwable? = null
        for ((g, v) in tries) {
            try {
                engine = start(path, g, v)
                seesImages = v
                this.path = path
                onGpu = g
                return if (g) "gpu" else "cpu"
            } catch (t: Throwable) {
                last = t
            }
        }
        throw last ?: IllegalStateException("Could not load the model.")
    }

    /**
     * Answers [text], given the system instruction and earlier turns
     * (roles "user" / "assistant", alternating).
     */
    fun generate(system: String, roles: List<String>, texts: List<String>, text: String, images: List<String>, topK: Int, topP: Double, temperature: Double, sink: Sink) {
        val e = engine ?: throw IllegalStateException("No model is loaded.")
        try { conversation?.close() } catch (_: Throwable) { }
        val history = roles.indices.map { i -> if (roles[i] == "assistant") Message.model(texts[i]) else Message.user(texts[i]) }
        val config = ConversationConfig(
            systemInstruction = Contents.of(system),
            initialMessages = history,
            samplerConfig = SamplerConfig(topK = topK, topP = topP, temperature = temperature),
        )
        val c = try {
            e.createConversation(config)
        } catch (t: Throwable) {
            // Some builds have no image part (e.g. "tf_lite_vision_encoder not found"): reload for text only.
            if (!seesImages || !(t.message ?: "").contains("vision", ignoreCase = true)) throw t
            try { e.close() } catch (_: Throwable) { }
            val textOnly = start(path, onGpu, false)
            engine = textOnly
            seesImages = false
            textOnly.createConversation(config)
        }
        conversation = c
        stopped = false
        val callback = object : MessageCallback {
            override fun onMessage(message: Message) {
                if (!stopped) sink.token(message.toString())
            }
            override fun onDone() = sink.done(null)
            override fun onError(throwable: Throwable) = sink.done(if (stopped) null else throwable)
        }
        if (images.isNotEmpty() && seesImages) {
            val parts = images.map { Content.ImageFile(it) } + Content.Text(text)
            c.sendMessageAsync(Contents.of(*parts.toTypedArray()), callback)
        } else {
            c.sendMessageAsync(text, callback)
        }
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
