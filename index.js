require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
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
  // MODO DEMO — reemplazar con Claude cuando haya API key
  const mensajeLower = mensaje.toLowerCase();

  if (
    mensajeLower.includes("precio") ||
    mensajeLower.includes("cuánto") ||
    mensajeLower.includes("cuanto")
  ) {
    return `¡Hola! Te paso algunos precios de nuestra pinturería:\n\n🎨 Látex interior blanco 4L: $8.500\n🎨 Látex exterior blanco 4L: $9.800\n🎨 Esmalte sintético 1L: $4.200\n\nPara más info podés llamarnos al 011-4444-5555 📞`;
  }

  if (
    mensajeLower.includes("stock") ||
    mensajeLower.includes("tienen") ||
    mensajeLower.includes("hay")
  ) {
    return `¡Hola! Sí, contamos con stock disponible en nuestros locales. Te recomiendo llamarnos para confirmar disponibilidad específica:\n\n📍 Casa Central: 011-4444-5555\n📍 Sucursal Norte: 011-4444-6666\n\nHorario: Lunes a Viernes 8-18hs, Sábados 8-13hs 🕐`;
  }

  if (
    mensajeLower.includes("horario") ||
    mensajeLower.includes("abren") ||
    mensajeLower.includes("cierran")
  ) {
    return `Nuestro horario es:\n\n🕐 Lunes a Viernes: 8 a 18hs\n🕐 Sábados: 8 a 13hs\n\nEstamos en:\n📍 Casa Central: Av. Corrientes 1234\n📍 Sucursal Norte: Av. Cabildo 567`;
  }

  if (
    mensajeLower.includes("hola") ||
    mensajeLower.includes("buenas") ||
    mensajeLower.includes("buen")
  ) {
    return `¡Hola! 👋 Bienvenido a Pinturería Sagitario. ¿En qué te puedo ayudar?\n\nPodés consultarme sobre:\n• Precios de productos\n• Disponibilidad de stock\n• Horarios y ubicaciones\n• Información general`;
  }

  return `¡Hola! Gracias por contactarnos. Para ayudarte mejor, podés llamarnos al 011-4444-5555 o visitarnos en:\n\n📍 Casa Central: Av. Corrientes 1234\n📍 Sucursal Norte: Av. Cabildo 567\n\nHorario: Lunes a Viernes 8-18hs 🕐`;
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
