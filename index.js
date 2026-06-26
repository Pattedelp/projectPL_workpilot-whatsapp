require("dotenv").config();
const express = require("express");
const axios = require("axios");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
const path = require("path");
app.use("/panel", express.static(path.join(__dirname, "panel")));
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  const { data: negocios } = await supabase
    .from("negocios")
    .select("nombre, activo");
  res.json({ status: "ok", negocios: negocios?.length || 0 });
});

// Servir el panel web
app.use("/panel", express.static(path.join(__dirname, "panel")));

// ── Recibir mensajes de WhatsApp via Twilio ───────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const from = req.body.From; // ej: whatsapp:+5491168936347
    const to = req.body.To; // ej: whatsapp:+14155238886 (número del negocio)
    const texto = req.body.Body;

    if (!from || !texto) return;

    console.log(`📩 [${to}] Mensaje de ${from}: ${texto}`);

    // Identificar el negocio por el número de WhatsApp
    const negocio = await obtenerNegocio(to);
    if (!negocio) {
      console.log(`⚠️ No se encontró negocio para el número ${to}`);
      return;
    }

    // Verificar horario de atención
    const config = await obtenerConfiguracion(negocio.id);
    if (!estaEnHorario()) {
      await enviarMensaje(
        from,
        config?.mensaje_fuera_horario ||
          "Estamos cerrados. Te respondemos pronto.",
      );
      return;
    }

    // Obtener o crear conversación
    const conversacion = await obtenerOCrearConversacion(negocio.id, from);

    // Guardar mensaje del cliente
    await guardarMensaje(conversacion.id, "cliente", texto);

    // Obtener historial reciente
    const historial = await obtenerHistorial(conversacion.id);

    // Cargar catálogo del negocio
    const catalogo = await obtenerCatalogo(negocio.id);

    // Procesar con Claude o respuestas predefinidas
    const respuesta = await procesarMensaje(
      texto,
      negocio,
      catalogo,
      config,
      historial,
    );

    // Guardar respuesta del agente
    await guardarMensaje(conversacion.id, "agente", respuesta);

    // Enviar respuesta
    await enviarMensaje(from, respuesta);

    console.log(`✅ Respuesta enviada a ${from}`);
  } catch (err) {
    console.error("Error procesando mensaje:", err.message);
  }
});

// ── Funciones de base de datos ────────────────────────────────────────────────

async function obtenerNegocio(whatsappNumber) {
  const { data } = await supabase
    .from("negocios")
    .select("*")
    .eq("whatsapp_number", whatsappNumber)
    .eq("activo", true)
    .single();
  return data;
}

async function obtenerConfiguracion(negocioId) {
  const { data } = await supabase
    .from("configuracion")
    .select("*")
    .eq("negocio_id", negocioId)
    .single();
  return data;
}

async function obtenerCatalogo(negocioId) {
  const { data: productos } = await supabase
    .from("productos")
    .select("*")
    .eq("negocio_id", negocioId)
    .eq("activo", true)
    .order("categoria");

  const { data: sucursales } = await supabase
    .from("sucursales")
    .select("*")
    .eq("negocio_id", negocioId);

  return { productos: productos || [], sucursales: sucursales || [] };
}

async function obtenerOCrearConversacion(negocioId, telefonoCliente) {
  // Buscar conversación existente
  const { data: existente } = await supabase
    .from("conversaciones")
    .select("*")
    .eq("negocio_id", negocioId)
    .eq("telefono_cliente", telefonoCliente)
    .single();

  if (existente) {
    // Actualizar updated_at
    await supabase
      .from("conversaciones")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", existente.id);
    return existente;
  }

  // Crear nueva conversación
  const { data: nueva } = await supabase
    .from("conversaciones")
    .insert([{ negocio_id: negocioId, telefono_cliente: telefonoCliente }])
    .select()
    .single();
  return nueva;
}

async function guardarMensaje(conversacionId, rol, contenido) {
  await supabase
    .from("mensajes")
    .insert([{ conversacion_id: conversacionId, rol, contenido }]);
}

async function obtenerHistorial(conversacionId) {
  const { data } = await supabase
    .from("mensajes")
    .select("rol, contenido")
    .eq("conversacion_id", conversacionId)
    .order("created_at", { ascending: true })
    .limit(10); // últimos 10 mensajes para contexto

  return data || [];
}

// ── Horario de atención ───────────────────────────────────────────────────────
function estaEnHorario() {
  const ahora = new Date();
  // Convertir a hora Argentina (UTC-3)
  const horaAR = new Date(ahora.getTime() - 3 * 60 * 60 * 1000);
  const dia = horaAR.getDay(); // 0=domingo, 1=lunes...6=sábado
  const hora = horaAR.getHours();

  if (dia === 0) return false; // domingo cerrado
  if (dia === 6) return hora >= 8 && hora < 13; // sábado 8-13
  return hora >= 8 && hora < 18; // lunes a viernes 8-18
}

// ── Procesar mensaje ──────────────────────────────────────────────────────────
async function procesarMensaje(mensaje, negocio, catalogo, config, historial) {
  // Detectar si quiere hablar con humano
  const m = mensaje.toLowerCase();
  if (
    m.includes("hablar con alguien") ||
    m.includes("persona") ||
    m.includes("humano") ||
    m.includes("encargado")
  ) {
    return `Te comunico con nuestro equipo. Podés llamarnos al ${config?.derivar_telefono || catalogo.sucursales[0]?.telefono || "nuestro local"} 📞`;
  }

  if (ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== "tu_key_aqui") {
    return await procesarConClaude(
      mensaje,
      negocio,
      catalogo,
      config,
      historial,
    );
  }
  return respuestaPredefinida(mensaje, negocio, catalogo, config);
}

// ── Respuestas predefinidas ───────────────────────────────────────────────────
function respuestaPredefinida(mensaje, negocio, catalogo, config) {
  const m = mensaje.toLowerCase();
  const tel = catalogo.sucursales[0]?.telefono || "";

  if (m.includes("hola") || m.includes("buenas") || m.includes("buen")) {
    return (
      config?.mensaje_bienvenida ||
      `¡Hola! 👋 Bienvenido a ${negocio.nombre}. ¿En qué te puedo ayudar?\n\n• 🎨 Precios\n• 📦 Stock\n• 🕐 Horarios\n• 📍 Ubicaciones`
    );
  }

  if (
    m.includes("precio") ||
    m.includes("cuánto") ||
    m.includes("cuanto") ||
    m.includes("vale") ||
    m.includes("cuesta")
  ) {
    const lista = catalogo.productos
      .slice(0, 5)
      .map((p) => `• ${p.nombre}: $${Number(p.precio).toLocaleString("es-AR")}`)
      .join("\n");
    return `🎨 Algunos precios:\n\n${lista}\n\nPara más info: 📞 ${tel}`;
  }

  if (
    m.includes("stock") ||
    m.includes("tienen") ||
    m.includes("hay") ||
    m.includes("disponib")
  ) {
    const disponibles = catalogo.productos.filter((p) => p.stock > 0).length;
    return `📦 Tenemos ${disponibles} productos disponibles.\n\nConsultá por uno específico o llamanos:\n📞 ${tel}`;
  }

  if (
    m.includes("horario") ||
    m.includes("abren") ||
    m.includes("cierran") ||
    m.includes("hora")
  ) {
    return `🕐 Horario:\n${config?.horario || "Lunes a Viernes 8-18hs, Sábados 8-13hs"}\n\n📍 ${catalogo.sucursales.map((s) => `${s.nombre}: ${s.direccion}`).join("\n📍 ")}`;
  }

  if (
    m.includes("dirección") ||
    m.includes("direccion") ||
    m.includes("dónde") ||
    m.includes("donde")
  ) {
    return `📍 Nuestras sucursales:\n\n${catalogo.sucursales.map((s) => `• ${s.nombre}\n  ${s.direccion}\n  Tel: ${s.telefono}`).join("\n\n")}`;
  }

  // Buscar producto específico en el catálogo
  const productoEncontrado = catalogo.productos.find(
    (p) =>
      p.nombre.toLowerCase().includes(m) ||
      m.includes(p.nombre.toLowerCase().split(" ")[0]),
  );
  if (productoEncontrado) {
    return `🎨 ${productoEncontrado.nombre}\n💰 Precio: $${Number(productoEncontrado.precio).toLocaleString("es-AR")}\n📦 Stock: ${productoEncontrado.stock > 0 ? "✅ Disponible" : "⚠️ Sin stock"}\n\nPara hacer un pedido: 📞 ${tel}`;
  }

  if (m.includes("gracias") || m.includes("ok") || m.includes("perfecto")) {
    return `¡De nada! 😊 Estamos para ayudarte. ${negocio.nombre} 🎨`;
  }

  return `Gracias por contactar a ${negocio.nombre}. 🎨\n\nPodés preguntarme sobre precios, stock y horarios, o llamarnos:\n📞 ${tel}\n\n🕐 ${config?.horario || "Lunes a Viernes 8-18hs"}`;
}

// ── Procesar con Claude ───────────────────────────────────────────────────────
async function procesarConClaude(
  mensaje,
  negocio,
  catalogo,
  config,
  historial,
) {
  const systemPrompt = `Sos un asistente comercial de ${negocio.nombre}, una pinturería argentina.
Respondé en español de Argentina, de forma amigable y concisa (máximo 4 líneas).

Horario: ${config?.horario || "Lunes a Viernes 8-18hs, Sábados 8-13hs"}
Sucursales: ${catalogo.sucursales.map((s) => `${s.nombre} - ${s.direccion} - Tel: ${s.telefono}`).join(" | ")}

Catálogo:
${catalogo.productos.map((p) => `- ${p.nombre}: $${Number(p.precio).toLocaleString("es-AR")} (${p.stock > 0 ? "disponible" : "sin stock"})`).join("\n")}

No inventes información. Si no sabés algo, dales el teléfono del local.`;

  // Construir historial para Claude
  const mensajesAPI = historial.map((m) => ({
    role: m.rol === "cliente" ? "user" : "assistant",
    content: m.contenido,
  }));
  mensajesAPI.push({ role: "user", content: mensaje });

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: systemPrompt,
      messages: mensajesAPI,
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

// ── Enviar mensaje por Twilio ─────────────────────────────────────────────────
async function enviarMensaje(to, texto) {
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    body: texto,
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`🗄️  Supabase: ${SUPABASE_URL ? "conectado" : "no configurado"}`);
  console.log(
    `🤖 Modo: ${ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== "tu_key_aqui" ? "Claude API" : "Respuestas predefinidas"}`,
  );
});
