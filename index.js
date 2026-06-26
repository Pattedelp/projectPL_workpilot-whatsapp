require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// Cargar catálogo
const catalogo = JSON.parse(fs.readFileSync("./catalogo.json", "utf8"));

// ── Verificación del webhook (Meta lo llama una vez para confirmar) ──────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado ✅");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Recibir mensajes de WhatsApp ─────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responder rápido para que Meta no reintente

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const from = message.from; // número del cliente
    const texto = message.text.body;
    const telefono_negocio = changes?.value?.metadata?.phone_number_id;

    console.log(`📩 Mensaje de ${from}: ${texto}`);

    // Procesar con Claude
    const respuesta = await procesarConClaude(texto);

    // Enviar respuesta por WhatsApp
    await enviarMensaje(telefono_negocio, from, respuesta);
  } catch (err) {
    console.error("Error procesando mensaje:", err.message);
  }
});

// ── Procesar con Claude ───────────────────────────────────────────────────────
async function procesarConClaude(mensaje) {
  const systemPrompt = `Sos un asistente comercial de ${catalogo.negocio}, una cadena de pinturerías argentina.
Tu trabajo es responder consultas de clientes por WhatsApp de forma amigable, concisa y útil.
Respondé siempre en español de Argentina.

Información del negocio:
- Horario: ${catalogo.horario}
- Sucursales: ${catalogo.sucursales.map((s) => `${s.nombre} (${s.direccion}, tel: ${s.telefono})`).join(" | ")}

Catálogo de productos disponibles:
${catalogo.productos.map((p) => `- ${p.nombre}: $${p.precio.toLocaleString("es-AR")} (stock: ${p.stock} unidades)`).join("\n")}

Reglas:
- Si te preguntan por un producto que no está en el catálogo, deciles que consultarás con el equipo y que se comuniquen al local más cercano
- Si preguntan precios, dálos claramente
- Si preguntan stock, informá si hay disponibilidad (sin dar el número exacto, solo "disponible" o "stock limitado" o "sin stock")
- Si quieren hacer un pedido o necesitan más info, dales el teléfono del local más cercano
- Respondé siempre de forma breve, máximo 3-4 líneas
- No inventes información que no tenés`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: mensaje }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    },
  );

  return response.data.content[0].text;
}

// ── Enviar mensaje por WhatsApp ───────────────────────────────────────────────
async function enviarMensaje(phoneNumberId, to, texto) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: texto },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  );
  console.log(`✅ Respuesta enviada a ${to}`);
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", negocio: catalogo.negocio });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
