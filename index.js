require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Cargar catálogo
const catalogo = JSON.parse(fs.readFileSync("./catalogo.json", "utf8"));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", negocio: catalogo.negocio });
});

// ── Recibir mensajes de WhatsApp via Twilio ───────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const from = req.body.From; // número del cliente ej: whatsapp:+5491168936347
    const texto = req.body.Body; // texto del mensaje

    if (!from || !texto) {
      return res.sendStatus(200);
    }

    console.log(`📩 Mensaje de ${from}: ${texto}`);

    // Procesar con Claude o respuestas predefinidas
    const respuesta = await procesarMensaje(texto);

    // Enviar respuesta por Twilio
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: respuesta,
    });

    console.log(`✅ Respuesta enviada a ${from}`);
    res.sendStatus(200);
  } catch (err) {
    console.error("Error procesando mensaje:", err.message);
    res.sendStatus(500);
  }
});

// ── Procesar mensaje ──────────────────────────────────────────────────────────
async function procesarMensaje(mensaje) {
  // Si hay API key de Claude, usarla
  if (ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== "tu_key_aqui") {
    return await procesarConClaude(mensaje);
  }
  // Si no, usar respuestas predefinidas
  return respuestaPredefinida(mensaje);
}

// ── Respuestas predefinidas (modo demo sin API key) ───────────────────────────
function respuestaPredefinida(mensaje) {
  const m = mensaje.toLowerCase();

  if (m.includes("hola") || m.includes("buenas") || m.includes("buen")) {
    return `¡Hola! 👋 Bienvenido a ${catalogo.negocio}. ¿En qué te puedo ayudar?\n\nPodés consultarme sobre:\n• 🎨 Precios de productos\n• 📦 Disponibilidad de stock\n• 🕐 Horarios y ubicaciones`;
  }

  if (
    m.includes("precio") ||
    m.includes("cuánto") ||
    m.includes("cuanto") ||
    m.includes("vale") ||
    m.includes("cuesta")
  ) {
    const productos = catalogo.productos.slice(0, 5);
    const lista = productos
      .map((p) => `• ${p.nombre}: $${p.precio.toLocaleString("es-AR")}`)
      .join("\n");
    return `¡Te paso algunos precios! 🎨\n\n${lista}\n\nPara ver el catálogo completo contactanos:\n📞 ${catalogo.sucursales[0].telefono}`;
  }

  if (
    m.includes("stock") ||
    m.includes("tienen") ||
    m.includes("hay") ||
    m.includes("disponib")
  ) {
    const conStock = catalogo.productos.filter((p) => p.stock > 0);
    const sinStock = catalogo.productos.filter((p) => p.stock === 0);
    return `📦 Estado del stock:\n\n✅ Con disponibilidad: ${conStock.length} productos\n⚠️ Stock limitado: ${catalogo.productos.filter((p) => p.stock <= 3 && p.stock > 0).length} productos\n\nConsultá por un producto específico o llamanos:\n📞 ${catalogo.sucursales[0].telefono}`;
  }

  if (
    m.includes("horario") ||
    m.includes("abren") ||
    m.includes("cierran") ||
    m.includes("hora")
  ) {
    return `🕐 Nuestro horario:\n\nLunes a Viernes: 8 a 18hs\nSábados: 8 a 13hs\n\n📍 Sucursales:\n${catalogo.sucursales.map((s) => `• ${s.nombre}: ${s.direccion}`).join("\n")}`;
  }

  if (
    m.includes("dirección") ||
    m.includes("direccion") ||
    m.includes("dónde") ||
    m.includes("donde") ||
    m.includes("ubicacion") ||
    m.includes("ubicación")
  ) {
    const suc = catalogo.sucursales
      .map((s) => `📍 ${s.nombre}\n   ${s.direccion}\n   Tel: ${s.telefono}`)
      .join("\n\n");
    return `Nuestras sucursales:\n\n${suc}\n\n🕐 Horario: Lunes a Viernes 8-18hs, Sábados 8-13hs`;
  }

  if (m.includes("latex") || m.includes("látex")) {
    const productos = catalogo.productos.filter(
      (p) =>
        p.categoria.toLowerCase().includes("látex") ||
        p.categoria.toLowerCase().includes("latex"),
    );
    if (productos.length > 0) {
      const lista = productos
        .map(
          (p) =>
            `• ${p.nombre}: $${p.precio.toLocaleString("es-AR")} (${p.stock > 0 ? "✅ disponible" : "⚠️ sin stock"})`,
        )
        .join("\n");
      return `🎨 Línea Látex:\n\n${lista}\n\nPara hacer un pedido llamanos:\n📞 ${catalogo.sucursales[0].telefono}`;
    }
  }

  if (m.includes("esmalte")) {
    const productos = catalogo.productos.filter((p) =>
      p.categoria.toLowerCase().includes("esmalte"),
    );
    if (productos.length > 0) {
      const lista = productos
        .map(
          (p) =>
            `• ${p.nombre}: $${p.precio.toLocaleString("es-AR")} (${p.stock > 0 ? "✅ disponible" : "⚠️ sin stock"})`,
        )
        .join("\n");
      return `🎨 Línea Esmaltes:\n\n${lista}\n\nPara hacer un pedido llamanos:\n📞 ${catalogo.sucursales[0].telefono}`;
    }
  }

  if (
    m.includes("gracias") ||
    m.includes("ok") ||
    m.includes("perfecto") ||
    m.includes("listo")
  ) {
    return `¡De nada! 😊 Estamos para ayudarte. Si necesitás algo más no dudes en escribirnos.\n\n${catalogo.negocio} 🎨`;
  }

  // Respuesta por defecto
  return `Gracias por contactar a ${catalogo.negocio}. 🎨\n\nPodés preguntarme sobre precios, stock y horarios, o comunicarte directamente:\n\n📞 ${catalogo.sucursales[0].telefono}\n📍 ${catalogo.sucursales[0].direccion}\n\n🕐 Lunes a Viernes 8-18hs`;
}

// ── Procesar con Claude (cuando haya API key) ─────────────────────────────────
async function procesarConClaude(mensaje) {
  const systemPrompt = `Sos un asistente comercial de ${catalogo.negocio}, una cadena de pinturerías argentina.
Tu trabajo es responder consultas de clientes por WhatsApp de forma amigable, concisa y útil.
Respondé siempre en español de Argentina, máximo 3-4 líneas.

Horario: ${catalogo.horario}
Sucursales: ${catalogo.sucursales.map((s) => `${s.nombre} (${s.direccion}, tel: ${s.telefono})`).join(" | ")}

Catálogo:
${catalogo.productos.map((p) => `- ${p.nombre}: $${p.precio.toLocaleString("es-AR")} (stock: ${p.stock > 0 ? "disponible" : "sin stock"})`).join("\n")}

No inventes información. Si no sabés algo, dales el teléfono del local.`;

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

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📋 Negocio: ${catalogo.negocio}`);
  console.log(
    `🤖 Modo: ${ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== "tu_key_aqui" ? "Claude API" : "Respuestas predefinidas"}`,
  );
});
