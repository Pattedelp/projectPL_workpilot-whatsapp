require("dotenv").config();
const express = require("express");
const axios = require("axios");
const twilio = require("twilio");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/panel", express.static(path.join(__dirname, "panel")));

const PORT = process.env.PORT || 10000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY,
);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  const { data: negocios } = await supabase
    .from("negocios")
    .select("nombre, activo");
  res.json({ status: "ok", negocios: negocios?.length || 0 });
});

// ── Recibir mensajes de WhatsApp via Twilio ───────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.status(200).end();

  try {
    const from = req.body.From;
    const to = req.body.To;
    const texto = req.body.Body;

    if (!from || !texto) return;

    console.log(`📩 [${to}] Mensaje de ${from}: ${texto}`);
    console.log(`🔍 Buscando negocio con número: "${to}"`);

    const negocio = await obtenerNegocio(to);
    if (!negocio) {
      console.log(`⚠️ No se encontró negocio para el número ${to}`);
      return;
    }
    console.log("✅ Negocio OK:", negocio.id);

    const config = await obtenerConfiguracion(negocio.id);
    console.log("✅ Config OK:", config?.id || "sin config");

    if (!estaEnHorario()) {
      await enviarMensaje(
        from,
        config?.mensaje_fuera_horario ||
          "Estamos cerrados. Te respondemos pronto.",
      );
      return;
    }

    const conversacion = await obtenerOCrearConversacion(negocio.id, from);
    console.log("✅ Conversacion OK:", conversacion?.id || "null");

    await guardarMensaje(conversacion.id, "cliente", texto);

    const historial = await obtenerHistorial(conversacion.id);
    console.log("✅ Historial OK:", historial.length, "mensajes");

    const catalogo = await obtenerCatalogo(negocio.id);

    const respuesta = await procesarMensaje(
      texto,
      negocio,
      catalogo,
      config,
      historial,
      conversacion,
    );

    await guardarMensaje(conversacion.id, "agente", respuesta);

    await enviarMensaje(from, respuesta);

    console.log(`✅ Respuesta enviada a ${from}`);
  } catch (err) {
    console.error("Error procesando mensaje:", err.message);
    console.error(err.stack);
  }
});

// ── Funciones de base de datos ────────────────────────────────────────────────
async function obtenerNegocio(whatsappNumber) {
  const { data, error } = await supabase
    .from("negocios")
    .select("*")
    .eq("whatsapp_number", whatsappNumber)
    .eq("activo", true)
    .maybeSingle();

  if (error) console.log("Error buscando negocio:", error.message);
  console.log("Negocio encontrado:", data?.nombre || "ninguno");
  return data;
}

async function obtenerConfiguracion(negocioId) {
  const { data } = await supabase
    .from("configuracion")
    .select("*")
    .eq("negocio_id", negocioId)
    .maybeSingle();
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
  const { data: existente } = await supabase
    .from("conversaciones")
    .select("*")
    .eq("negocio_id", negocioId)
    .eq("telefono_cliente", telefonoCliente)
    .maybeSingle();

  if (existente) {
    const ahora = new Date();
    const ultimaActividad = new Date(existente.updated_at);
    const horasSinActividad = (ahora - ultimaActividad) / (1000 * 60 * 60);

    // Si pasaron más de 24hs, resetear zona y sucursal
    if (horasSinActividad > 24) {
      await supabase
        .from("conversaciones")
        .update({
          zona: null,
          sucursal_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existente.id);
      return { ...existente, zona: null, sucursal_id: null };
    }

    await supabase
      .from("conversaciones")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", existente.id);
    return existente;
  }

  const { data: creada, error: errorCreada } = await supabase
    .from("conversaciones")
    .insert([{ negocio_id: negocioId, telefono_cliente: telefonoCliente }])
    .select()
    .single();

  if (errorCreada)
    console.error("Error creando conversación:", errorCreada.message);
  return creada;
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
    .limit(10);
  return data || [];
}

// ── Horario de atención ───────────────────────────────────────────────────────
function estaEnHorario() {
  const ahora = new Date();
  const horaAR = new Date(ahora.getTime() - 3 * 60 * 60 * 1000);
  const dia = horaAR.getDay();
  const hora = horaAR.getHours();
  if (dia === 0) return false;
  if (dia === 6) return hora >= 8 && hora < 13;
  return hora >= 8 && hora < 18;
}

// ── Procesar mensaje ──────────────────────────────────────────────────────────
async function procesarMensaje(
  mensaje,
  negocio,
  catalogo,
  config,
  historial,
  conversacion,
) {
  const m = mensaje.toLowerCase();

  if (
    m.includes("hablar con alguien") ||
    m.includes("persona") ||
    m.includes("humano") ||
    m.includes("encargado")
  ) {
    const sucursal = conversacion.sucursal_id
      ? catalogo.sucursales.find((s) => s.id === conversacion.sucursal_id)
      : catalogo.sucursales[0];
    return `Te comunico con el equipo de ${sucursal?.nombre || "nuestro local"}. Podés llamarnos al ${sucursal?.telefono || config?.derivar_telefono} 📞`;
  }

  if (!conversacion.zona && historial.length >= 2) {
    const yaPreguntoZona = historial.some(
      (h) =>
        h.contenido.toLowerCase().includes("zona") ||
        h.contenido.toLowerCase().includes("sucursal"),
    );
    if (!yaPreguntoZona) {
      return `Para darte la mejor atención, ¿podés indicarme en qué zona o barrio estás? Así te conecto con el local más cercano. 📍`;
    }
  }

  if (!conversacion.zona && historial.length >= 3) {
    const yaPreguntoZona = historial.some(
      (h) =>
        h.contenido.toLowerCase().includes("zona") ||
        h.contenido.toLowerCase().includes("barrio"),
    );
    if (yaPreguntoZona) {
      const sucursalCercana = detectarSucursalPorZona(
        mensaje,
        catalogo.sucursales,
      );
      if (sucursalCercana) {
        await supabase
          .from("conversaciones")
          .update({ zona: mensaje, sucursal_id: sucursalCercana.id })
          .eq("id", conversacion.id);
        conversacion.zona = mensaje;
        conversacion.sucursal_id = sucursalCercana.id;
        return `Perfecto, te asigno al local de *${sucursalCercana.nombre}* (${sucursalCercana.direccion}). ¿En qué te puedo ayudar? 😊`;
      } else {
        return `No pude encontrar una sucursal cercana a "${mensaje}". ¿Podés indicar un barrio o zona? Por ejemplo: Palermo, Belgrano, Centro, Flores. 📍`;
      }
    }
  }

  const sucursalCliente = conversacion.sucursal_id
    ? catalogo.sucursales.find((s) => s.id === conversacion.sucursal_id)
    : catalogo.sucursales[0];

  if (ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== "tu_key_aqui") {
    return await procesarConClaude(
      mensaje,
      negocio,
      catalogo,
      config,
      historial,
      sucursalCliente,
    );
  }
  return respuestaPredefinida(
    mensaje,
    negocio,
    catalogo,
    config,
    sucursalCliente,
  );
}

// ── Detectar sucursal por zona ────────────────────────────────────────────────
function detectarSucursalPorZona(mensaje, sucursales) {
  const m = mensaje.toLowerCase();

  for (const s of sucursales) {
    const nombreLower = s.nombre.toLowerCase();
    const dirLower = (s.direccion || "").toLowerCase();
    if (
      m.includes(nombreLower) ||
      nombreLower.includes(m) ||
      dirLower.includes(m)
    ) {
      return s;
    }
  }

  const zonas = {
    norte: [
      "norte",
      "cabildo",
      "palermo",
      "belgrano",
      "nuñez",
      "saavedra",
      "coghlan",
      "villa urquiza",
    ],
    sur: ["sur", "boca", "barracas", "pompeya", "lugano", "mataderos"],
    oeste: ["oeste", "flores", "floresta", "liniers", "caballito", "almagro"],
    centro: [
      "centro",
      "microcentro",
      "monserrat",
      "san telmo",
      "constitucion",
      "corrientes",
    ],
  };

  for (const [zona, keywords] of Object.entries(zonas)) {
    if (keywords.some((k) => m.includes(k))) {
      const match = sucursales.find(
        (s) =>
          s.nombre.toLowerCase().includes(zona) ||
          (s.direccion || "").toLowerCase().includes(zona) ||
          keywords.some((k) => (s.direccion || "").toLowerCase().includes(k)),
      );
      if (match) return match;
      return sucursales[0];
    }
  }

  if (mensaje.split(" ").length <= 4 && !mensaje.includes("?")) {
    return sucursales[0];
  }

  return null;
}

// ── Respuestas predefinidas ───────────────────────────────────────────────────
function respuestaPredefinida(
  mensaje,
  negocio,
  catalogo,
  config,
  sucursalCliente,
) {
  const m = mensaje.toLowerCase();
  const tel =
    sucursalCliente?.telefono || catalogo.sucursales[0]?.telefono || "";
  const localNombre =
    sucursalCliente?.nombre || catalogo.sucursales[0]?.nombre || negocio.nombre;

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
    return `🎨 Algunos precios en ${localNombre}:\n\n${lista}\n\nPara más info: 📞 ${tel}`;
  }

  if (
    m.includes("stock") ||
    m.includes("tienen") ||
    m.includes("hay") ||
    m.includes("disponib")
  ) {
    const disponibles = catalogo.productos.filter((p) => p.stock > 0).length;
    return `📦 En ${localNombre} tenemos ${disponibles} productos disponibles.\n\nConsultá por uno específico o llamanos:\n📞 ${tel}`;
  }

  if (m.includes("horario") || m.includes("abren") || m.includes("cierran")) {
    return `🕐 Horario de ${localNombre}:\n${config?.horario || "Lunes a Viernes 8-18hs, Sábados 8-13hs"}\n\n📍 ${sucursalCliente?.direccion || ""}`;
  }

  if (
    m.includes("dirección") ||
    m.includes("direccion") ||
    m.includes("dónde") ||
    m.includes("donde")
  ) {
    return `📍 ${localNombre}\n${sucursalCliente?.direccion || ""}\n📞 ${tel}\n\n🕐 ${config?.horario || "Lunes a Viernes 8-18hs"}`;
  }

  const productoEncontrado = catalogo.productos.find((p) =>
    p.nombre
      .toLowerCase()
      .split(" ")
      .some((palabra) => palabra.length > 3 && m.includes(palabra)),
  );
  if (productoEncontrado) {
    return `🎨 ${productoEncontrado.nombre}\n💰 $${Number(productoEncontrado.precio).toLocaleString("es-AR")}\n📦 ${productoEncontrado.stock > 0 ? "✅ Disponible en " + localNombre : "⚠️ Sin stock actualmente"}\n\n📞 ${tel}`;
  }

  if (m.includes("gracias") || m.includes("ok") || m.includes("perfecto")) {
    return `¡De nada! 😊 Cualquier consulta estamos en ${localNombre}. ${negocio.nombre} 🎨`;
  }

  return `Gracias por contactar a ${negocio.nombre}. 🎨\n\n📍 Tu local: ${localNombre}\n📞 ${tel}\n🕐 ${config?.horario || "Lunes a Viernes 8-18hs"}`;
}

// ── Procesar con Claude ───────────────────────────────────────────────────────
async function procesarConClaude(
  mensaje,
  negocio,
  catalogo,
  config,
  historial,
  sucursalCliente,
) {
  const systemPrompt = `Sos un asistente comercial de ${negocio.nombre}, una pinturería argentina.
Respondé en español de Argentina, de forma amigable y concisa (máximo 4 líneas).

El cliente está asignado al local: ${sucursalCliente?.nombre || "Casa Central"}
Dirección: ${sucursalCliente?.direccion || ""}
Teléfono del local: ${sucursalCliente?.telefono || ""}

Horario: ${config?.horario || "Lunes a Viernes 8-18hs, Sábados 8-13hs"}

Catálogo disponible:
${catalogo.productos.map((p) => `- ${p.nombre}: $${Number(p.precio).toLocaleString("es-AR")} (${p.stock > 0 ? "disponible" : "sin stock"})`).join("\n")}

Siempre que derives a un humano, usá el teléfono del local asignado al cliente.
No inventes información.`;

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
