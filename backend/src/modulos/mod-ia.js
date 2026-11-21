// =====================================================================
// MOD-IA · Asistente Virtual (proceso 5.0)
// IA-P01 Chat del asistente · IA-P02 Historial y sugerencias
// =====================================================================
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { Router } from 'express'
import { exec, one, query, AHORA, consultaSoloLectura } from '../config/db.js'
import { autenticar, soloRol } from '../middleware/auth.js'
import { forbidden, HttpError, notFound, validar } from '../lib/http.js'
import { catalogoReportes, ejecutarReporte } from '../lib/reportes.js'

// Proceso 5.0 · Asistencia virtual. Responde con base en v_contextoCatalogo y sugiere un id_servicio.
// Proveedor: Gemini (GEMINI_API_KEY) → Claude (ANTHROPIC_API_KEY) → respuestas por palabras clave (modo local).
// Si el proveedor falla (red, límite de uso), esa respuesta se da en modo local.

const MODELO = 'claude-opus-5-5'
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null
// Modelos en orden: si uno está saturado (503), con límite (429), retirado (404) o tarda demasiado, se usa el siguiente.
// gemini-flash-latest quedó lento (más de 40 s); gemini-3.5-flash responde en ≈ 2 s.
const GEMINI_MODELOS = [...new Set([process.env.GEMINI_MODELO, 'gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'].filter(Boolean))]
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

// Hasta 5 servicios y 5 prestadores recomendados, en orden de mejor a peor (el servidor recorta y valida los ids)
const MAX_RECOMENDACIONES = 5
const Respuesta = z.object({
  respuesta: z.string(),
  servicios_sugeridos: z.array(z.number().int()),
  prestadores_sugeridos: z.array(z.number().int()),
  justificacion: z.string().nullable(),
})

const INSTRUCCIONES = `Eres el asistente virtual de Directorio Servicios, SRL, un marketplace de servicios técnicos, profesionales y del hogar en Santiago de los Caballeros, República Dominicana.
Ayudas al cliente a elegir el servicio adecuado del catálogo y respondes sus dudas sobre cómo funciona la plataforma.
Escribe en español dominicano neutro, cálido y breve (2 a 5 oraciones). Usa texto plano, sin markdown, sin asteriscos ni encabezados; si enumeras pasos, usa líneas que empiecen con "1.", "2.", etc.

Lo que puedes y no puedes hacer:
- Solo sugieres servicios del catálogo vigente, con su id exacto en servicios_sugeridos (lista, de mejor a peor, máximo 5). Si ninguno aplica o la pregunta no es sobre un servicio, deja la lista vacía.
- Solo recomiendas prestadores de la lista "Prestadores aprobados", con su id exacto en prestadores_sugeridos (lista, de mejor a peor, máximo 5). Vacía si la pregunta no es sobre prestadores.
- Si el cliente describe un problema de forma vaga, haz una pregunta concreta antes de sugerir.
- No creas ni modificas solicitudes, no procesas pagos, no emites facturas ni cambias estados. Explica cómo hacerlo en la plataforma (el cliente lo hace con un clic desde la tarjeta del servicio o desde Mis solicitudes).
- Solo conoces los datos del cliente que aparecen en "Datos del cliente". Nunca inventes códigos, montos, fechas ni estados; si no aparecen, dile dónde verlos.
- Si hay riesgo para la seguridad (electricidad, gas, agua), da primero una recomendación breve de seguridad. Ante una emergencia (incendio, olor fuerte a gas, persona electrocutada) indica llamar al 911 de inmediato.
- Si no estás seguro o el tema no es de la plataforma, recomienda contactar a soporte al (849) 880-2724.
- justificacion: una frase corta (máx. 120 caracteres) que resuma por qué recomiendas lo sugerido, o null.

Recomendaciones y rankings (por ejemplo "dame los 5 mejores servicios de luz" o "¿cuál es el mejor prestador?"):
- Identifica el tema: "luz", "electricidad", "breaker" o "corriente" = servicios eléctricos; "aire" = aire acondicionado; etc. Usa solo los servicios y prestadores que correspondan a ese tema.
- Servicios: ordénalos por calificación promedio de los clientes (solo cuenta si tiene calificaciones), luego por cantidad de solicitudes, luego por precio más bajo.
- Prestadores: ordénalos por calificación promedio, pero con pocas reseñas una calificación alta pesa menos (un 4.8 con 20 reseñas supera a un 5.0 con 1); luego por servicios completados. Prefiere a quien ofrece el servicio pedido y está Disponible. La membresía "destacado" es un plan pagado: no la cuentes como mérito.
- Si piden N y hay menos, dilo con honestidad ("en el catálogo hay 2 servicios eléctricos") y lista solo los que existen. Nunca inventes servicios, prestadores, calificaciones ni precios.
- En "respuesta" enumera el ranking en líneas "1.", "2.", … con el dato que justifica el orden (★ calificación y reseñas, servicios completados, precio). Las tarjetas con el detalle se muestran debajo.
- Si el cliente indica su sector o zona, prefiere prestadores que lo cubran.

Cómo funciona la plataforma:
- Solicitar: el cliente elige el servicio, describe el problema, la fecha y la dirección (con el sector), y puede elegir prestador o dejar que el sistema asigne uno disponible en su zona. El prestador tiene 2 horas para aceptar; si no, se reasigna.
- Seguimiento: cada solicitud tiene un código (SOL-XXXXXX) para ver su estado en Mis solicitudes.
- Pago en dos partes: 50 % de anticipo cuando el prestador acepta y 50 % de saldo (más materiales, si los hubo) cuando el cliente confirma que el servicio terminó. Si no confirma en 48 horas, se confirma solo.
- Métodos de pago: PayPal (en dólares a la tasa del día), tarjeta, transferencia bancaria (se verifica en 24 h hábiles) o efectivo al prestador.
- Precios del catálogo: base en RD$ sin ITBIS (18 %). Los planes de suscripción incluyen servicios sin costo y descuentos.
- Comprobante fiscal: al pagar el cliente elige Consumo (e32) o Crédito Fiscal (e31) con su RNC o cédula, que se valida con la DGII. El anticipo y el saldo van en una sola factura electrónica: se emite al pagar el anticipo y el saldo se abona a ella (los materiales salen en una nota de débito). Está en Mis facturas.
- Si le cobraron de más o el servicio no se realizó, en Mis facturas usa "Solicitar nota de crédito"; administración la revisa.
- Cargos adicionales: si el prestador necesita cobrar algo extra después del servicio, el cliente lo acepta o rechaza en el seguimiento de la solicitud; solo se cobra si lo acepta.
- Cancelación sin costo mientras la solicitud esté Pendiente o hasta 12 horas antes de la cita; si ya pagó el anticipo, se reembolsa.`

/** v_contextoCatalogo: servicios Publicados (con su calificación y demanda) y prestadores aprobados. */
export function construirContexto(servicios, prestadores = []) {
  const srv = servicios.map((s) => `- id ${s.id_servicio} · ${s.nombre} · ${s.categoria} · ${s.modalidad} · desde RD$ ${Number(s.precio_base).toFixed(2)} + ITBIS`
    + ` · ${s.calificaciones ? `★ ${Number(s.calificacion).toFixed(1)} (${s.calificaciones} calificaciones)` : 'sin calificaciones'} · ${s.solicitudes} solicitudes · ${s.prestadores} prestadores`).join('\n')
  const pre = prestadores.map((e) => `- id ${e.id_empleado} · ${e.nombre} · ${e.especialidad} · ${e.categoria}`
    + ` · ${e.total_resenas ? `★ ${Number(e.calificacion_promedio).toFixed(1)} (${e.total_resenas} reseñas)` : 'sin reseñas'} · ${e.completados} servicios completados`
    + ` · ${e.estado_disponibilidad}${e.tarifa_hora ? ` · RD$ ${Number(e.tarifa_hora).toFixed(0)}/h` : ''}${e.destacado ? ' · destacado (membresía)' : ''}`
    + ` · ofrece: ${e.servicios || 'servicios de su categoría'} · zona: ${e.zona_cobertura || 'no indicada'}`).join('\n')
  return `${srv}\n\nPrestadores aprobados:\n${pre || '- (ninguno)'}`
}

/** Servicios Publicados con su calificación promedio (de los clientes que lo contrataron) y su demanda. */
const cargarServicios = () => query(
  `SELECT s.id_servicio, s.nombre, s.precio_base, s.modalidad, s.duracion_estimada, c.nombre AS categoria,
          (SELECT COUNT(DISTINCT d.id_solicitud) FROM solicitud_detalle d WHERE d.id_servicio = s.id_servicio) AS solicitudes,
          (SELECT COUNT(*) FROM empleado_servicio es JOIN empleados e ON e.id_empleado = es.id_empleado
            WHERE es.id_servicio = s.id_servicio AND e.estado_aprobacion = 'Aprobado') AS prestadores,
          r.calificacion, COALESCE(r.n, 0) AS calificaciones
     FROM servicios s JOIN categorias_servicio c ON c.id_categoria = s.id_categoria
     OUTER APPLY (SELECT AVG(CAST(a.calificacion_cliente AS DECIMAL(4,2))) AS calificacion, COUNT(*) AS n
                    FROM asignaciones_servicio a JOIN solicitud_detalle d ON d.id_solicitud = a.id_solicitud
                   WHERE d.id_servicio = s.id_servicio AND a.calificacion_cliente IS NOT NULL) r
    WHERE s.estado = 'Publicado' ORDER BY s.id_servicio`)

/** Prestadores aprobados y activos con su reputación, lo que ofrecen y su zona. */
const cargarPrestadores = () => query(
  `SELECT e.id_empleado, CONCAT(u.nombre, ' ', u.apellido) AS nombre, e.especialidad, c.nombre AS categoria, e.calificacion_promedio,
          e.total_resenas, e.estado_disponibilidad, e.tarifa_hora, e.zona_cobertura, e.anios_experiencia,
          (SELECT COUNT(*) FROM asignaciones_servicio a WHERE a.id_empleado = e.id_empleado AND a.estado_asignacion = 'Completada') AS completados,
          (SELECT STRING_AGG(CONCAT(sv.nombre, ' (id ', sv.id_servicio, ')'), ', ') FROM empleado_servicio es JOIN servicios sv ON sv.id_servicio = es.id_servicio
            WHERE es.id_empleado = e.id_empleado AND sv.estado = 'Publicado') AS servicios,
          (SELECT STRING_AGG(CAST(es.id_servicio AS VARCHAR(10)), ',') FROM empleado_servicio es WHERE es.id_empleado = e.id_empleado) AS ids_servicios,
          IIF(EXISTS (SELECT 1 FROM clientes cm JOIN suscripciones sm ON sm.id_cliente = cm.id_cliente JOIN planes pm ON pm.id_plan = sm.id_plan
             WHERE cm.id_usuario = e.id_usuario AND pm.dirigido_a = 'Prestador' AND pm.destacado = 1
               AND sm.estado IN ('Activa','Cancelada') AND sm.fecha_renovacion >= CAST(GETDATE() AS date)), 1, 0) AS destacado
     FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario JOIN categorias_servicio c ON c.id_categoria = e.id_categoria
    WHERE e.estado_aprobacion = 'Aprobado' AND u.estado = 'Activo'
    ORDER BY e.calificacion_promedio DESC, e.total_resenas DESC`)

export const modoIA = () => (process.env.GEMINI_API_KEY ? 'gemini' : client ? 'claude' : 'local')

// Mismo esquema que Respuesta, en el formato de Gemini (responseSchema)
const ESQUEMA_GEMINI = {
  type: 'OBJECT',
  properties: {
    respuesta: { type: 'STRING' },
    servicios_sugeridos: { type: 'ARRAY', items: { type: 'INTEGER' } },
    prestadores_sugeridos: { type: 'ARRAY', items: { type: 'INTEGER' } },
    justificacion: { type: 'STRING', nullable: true },
  },
  required: ['respuesta', 'servicios_sugeridos', 'prestadores_sugeridos', 'justificacion'],
}

/** Gemini (Google AI Studio) con salida JSON según el esquema; el historial usa los roles user / model. */
async function responderGemini({ contexto, datosCliente, historial, pregunta }) {
  try {
    const enviar = (modelo) => fetch(`${GEMINI_URL}/${modelo}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(15_000),
      body: cuerpo,
    })
    const cuerpo = JSON.stringify({
        systemInstruction: { parts: [{ text: `${INSTRUCCIONES}\n\nCatálogo vigente:\n${contexto}\n\nDatos del cliente:\n${datosCliente}` }] },
        contents: [
          ...historial.map((m) => ({ role: m.emisor === 'Cliente' ? 'user' : 'model', parts: [{ text: m.contenido }] })),
          { role: 'user', parts: [{ text: pregunta }] },
        ],
        generationConfig: {
          thinkingConfig: { thinkingLevel: 'low' }, // respuestas rápidas (≈ 3 s)
          responseMimeType: 'application/json',
          responseSchema: ESQUEMA_GEMINI,
          maxOutputTokens: 1500,
        },
      })
    let r = null, d = {}
    for (const modelo of GEMINI_MODELOS) {
      try {
        r = await enviar(modelo)
      } catch (e) {
        console.warn(`[IA Gemini] ${modelo}:`, e.name === 'TimeoutError' ? 'tiempo de espera agotado' : e.message)
        r = null
        continue
      }
      d = await r.json().catch(() => ({}))
      if (r.ok) break
      console.warn(`[IA Gemini] ${modelo} ${r.status}:`, d?.error?.message?.slice(0, 120) || 'error')
      if (![404, 429, 500, 503].includes(r.status)) break // error de la petición: otro modelo no lo arregla
    }
    if (!r?.ok) return null
    const c = d.candidates?.[0]
    const texto = c?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('')
    const o = Respuesta.safeParse((() => { try { return JSON.parse(texto) } catch { return null } })())
    if (c?.finishReason !== 'STOP' || !o.success) {
      console.warn('[IA Gemini] respuesta no válida:', c?.finishReason || d.promptFeedback?.blockReason || 'sin candidatos')
      return null
    }
    return { texto: o.data.respuesta, servicios: o.data.servicios_sugeridos, prestadores: o.data.prestadores_sugeridos, justificacion: o.data.justificacion, tokens: d.usageMetadata?.totalTokenCount ?? null }
  } catch (e) {
    console.error('[IA Gemini]', e.name === 'TimeoutError' ? 'tiempo de espera agotado' : e.message)
    return null
  }
}

/** Gemini → Claude → modo local: si un proveedor falla (saturado, sin red, límite de uso) responde el siguiente. */
export async function responderIA(args) {
  if (process.env.GEMINI_API_KEY) {
    const r = await responderGemini(args)
    if (r) return r
  }
  return responderClaude(args)
}

async function responderClaude({ contexto, datosCliente, historial, pregunta, servicios, prestadores = [] }) {
  if (!client) return responderLocal(pregunta, servicios, prestadores)
  try {
    const messages = [
      ...historial.map((m) => ({ role: m.emisor === 'Cliente' ? 'user' : 'assistant', content: m.contenido })),
      { role: 'user', content: pregunta },
    ]
    const r = await client.messages.parse({
      model: MODELO,
      max_tokens: 2000,
      system: [
        { type: 'text', text: INSTRUCCIONES },
        { type: 'text', text: `Catálogo vigente:\n${contexto}`, cache_control: { type: 'ephemeral' } },
        // Datos del cliente: van después del bloque en caché porque cambian por cliente
        { type: 'text', text: `Datos del cliente:\n${datosCliente}` },
      ],
      messages,
      output_config: { effort: 'low', format: zodOutputFormat(Respuesta) },
    })
    if (r.stop_reason === 'refusal' || !r.parsed_output) return responderLocal(pregunta, servicios, prestadores)
    const o = r.parsed_output
    return {
      texto: o.respuesta,
      servicios: o.servicios_sugeridos,
      prestadores: o.prestadores_sugeridos,
      justificacion: o.justificacion,
      tokens: (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0),
    }
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) console.warn('[IA] límite de tasa; usando respuesta local')
    else if (e instanceof Anthropic.APIError) console.error(`[IA] error ${e.status}:`, e.message)
    else console.error('[IA]', e)
    return responderLocal(pregunta, servicios, prestadores)
  }
}

// Respuestas por palabras clave cuando no hay modelo configurado
// [palabras de la pregunta, palabras del nombre del servicio, texto]; se comparan sin tildes
const sinTildes = (t = '') => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const REGLAS = [
  [/luz|breaker|electric|corto|enchufe|tomacorriente|lampara|abanico|corriente|cableado/, /electric|breaker|lampara|abanico|luz/, 'Parece un problema eléctrico. Por seguridad, deja el breaker apagado hasta la visita. Te recomiendo:'],
  [/aire|a\/a|frio|split/, /aire/, 'Para tu aire acondicionado te sugiero:'],
  [/computadora|laptop|pc|virus|internet/, /computador/, 'Un técnico puede ayudarte en sitio o de forma remota:'],
  [/contrato|abogad|legal/, /legal/, 'Para temas legales te sugiero:'],
  [/impuesto|ir-1|it-1|declaraci|contador|contab/, /impuesto/, 'Un contador puede preparar tu declaración:'],
  [/limpi/, /limpieza/, 'Te recomiendo nuestra limpieza profunda:'],
  [/cucaracha|fumig|plaga|hormiga|rata/, /fumig/, 'Para control de plagas te sugiero:'],
  [/plomer|tuber|destape|fuga|agua/, /plomer/, 'Para problemas de plomería te sugiero:'],
]

// Reputación con pocas reseñas: se acerca al promedio general (un 5.0 con 1 reseña no supera a un 4.8 con 20)
const puntaje = (cal, n, media = 4, peso = 3) => ((Number(cal) || 0) * n + media * peso) / (n + peso)
const rankingServicios = (lista) => [...lista].sort((a, b) =>
  puntaje(b.calificacion, b.calificaciones) - puntaje(a.calificacion, a.calificaciones) || b.solicitudes - a.solicitudes || a.precio_base - b.precio_base)
const rankingPrestadores = (lista) => [...lista].sort((a, b) =>
  puntaje(b.calificacion_promedio, b.total_resenas) - puntaje(a.calificacion_promedio, a.total_resenas) || b.completados - a.completados)
const estrellas = (cal, n) => (n ? `★ ${Number(cal).toFixed(1)} (${n})` : 'sin calificaciones')

function responderLocal(pregunta, servicios, prestadores = []) {
  const q = sinTildes(pregunta)
  const n = Math.min(Number(q.match(/\b([1-9])\b/)?.[1]) || 3, MAX_RECOMENDACIONES)
  const regla = REGLAS.find(([patron]) => patron.test(q.replace('electricista', 'electric')))
  const delTema = regla ? servicios.filter((x) => regla[1].test(sinTildes(x.nombre))) : servicios

  // "¿Cuál es el mejor prestador (de luz)?"
  if (/prestador|tecnico|electricista|plomero|contador|abogad|quien/.test(q) && /mejor|recomiend|top|bueno/.test(q)) {
    const ids = new Set(delTema.map((x) => String(x.id_servicio)))
    const candidatos = regla ? prestadores.filter((e) => String(e.ids_servicios || '').split(',').some((id) => ids.has(id))) : prestadores
    const top = rankingPrestadores(candidatos).slice(0, n)
    if (top.length) {
      return {
        texto: `Estos son los prestadores mejor valorados${regla ? ' para ese tipo de servicio' : ''}:\n${top.map((e, i) => `${i + 1}. ${e.nombre} · ${estrellas(e.calificacion_promedio, e.total_resenas)} · ${e.completados} servicios completados`).join('\n')}`,
        servicios: [], prestadores: top.map((e) => e.id_empleado), justificacion: null, tokens: null,
      }
    }
  }
  // "Dame los 5 mejores servicios de luz"
  if (/mejor|top|recomiend/.test(q) && /servicio/.test(q)) {
    const top = rankingServicios(delTema).slice(0, n)
    if (top.length) {
      const aviso = top.length < n ? `En el catálogo hay ${top.length} servicio${top.length === 1 ? '' : 's'} de ese tipo:` : `Los ${top.length} servicios mejor valorados:`
      return {
        texto: `${aviso}\n${top.map((x, i) => `${i + 1}. ${x.nombre} · ${estrellas(x.calificacion, x.calificaciones)} · desde RD$ ${Number(x.precio_base).toFixed(2)} + ITBIS`).join('\n')}`,
        servicios: top.map((x) => x.id_servicio), prestadores: [], justificacion: null, tokens: null,
      }
    }
  }
  if (regla && delTema.length) {
    const top = rankingServicios(delTema)
    return { texto: regla[2], servicios: top.slice(0, 2).map((x) => x.id_servicio), prestadores: [], justificacion: `${top[0].nombre} · desde RD$ ${Number(top[0].precio_base).toFixed(2)} + ITBIS`, tokens: null }
  }
  if (/factura|rnc|ncf|e31|e32|credito fiscal/.test(q)) return { servicios: [], prestadores: [], texto: 'Al pagar el anticipo se emite la factura electrónica de tu servicio y el saldo se abona a esa misma factura. Al pagar eliges Consumo (e32) o Crédito Fiscal (e31) con tu RNC o cédula.', id_servicio: null, tokens: null }
  if (/pag|paypal|tarjeta|transfer|efectivo|anticipo/.test(q)) return { servicios: [], prestadores: [], texto: 'Pagas en dos partes: 50 % de anticipo cuando el prestador acepta y 50 % al terminar el servicio. Aceptamos PayPal, tarjeta, transferencia bancaria y efectivo al prestador.', id_servicio: null, tokens: null }
  if (/cancel/.test(q)) return { servicios: [], prestadores: [], texto: 'Puedes cancelar sin costo mientras la solicitud esté Pendiente o hasta 12 horas antes de la cita.', id_servicio: null, tokens: null }
  if (/^(hola|hi|hey|buenas|buenos dias|buenas tardes|buenas noches|saludos|que tal)\b/.test(q.trim())) {
    return { servicios: [], prestadores: [], texto: '¡Hola! ¿En qué te ayudo hoy? Cuéntame qué problema tienes (por ejemplo, "se me fue la luz" o "necesito una limpieza") o pídeme una recomendación, como "dame los mejores servicios de luz" o "¿cuál es el mejor electricista?".', tokens: null }
  }
  if (/gracias|perfecto|excelente|ok\b|vale\b/.test(q)) {
    return { servicios: [], prestadores: [], texto: '¡Con gusto! Si necesitas algo más, aquí estoy.', tokens: null }
  }
  if (/que puedes|que haces|ayuda|como funciona/.test(q)) {
    return { servicios: [], prestadores: [], texto: 'Puedo:\n1. Sugerirte el servicio adecuado según tu problema.\n2. Recomendarte los mejores servicios y prestadores por calificación.\n3. Explicarte pagos, facturas, cancelaciones y vouchers.\n4. Decirte el estado de tus solicitudes.', tokens: null }
  }
  return { servicios: [], prestadores: [], texto: 'No estoy seguro de qué servicio necesitas. ¿Puedes darme más detalles? También puedes llamar a soporte al (849) 880-2724.', id_servicio: null, tokens: null }
}

/** Datos del cliente para que el asistente responda sobre sus propias solicitudes (nunca de otros clientes). */
async function datosDelCliente(id_cliente) {
  const c = await one(
    `SELECT u.nombre, c.tipo_cliente, c.ciudad, (SELECT TOP 1 p.nombre FROM suscripciones s JOIN planes p ON p.id_plan = s.id_plan
        WHERE s.id_cliente = c.id_cliente AND s.estado = 'Activa' ORDER BY s.fecha_inicio DESC) AS [plan]
       FROM clientes c JOIN usuarios u ON u.id_usuario = c.id_usuario WHERE c.id_cliente = ?`, [id_cliente])
  const sols = await query(
    `SELECT TOP 5 s.codigo_seguimiento, s.estado, s.fecha_preferida,
            (SELECT STRING_AGG(COALESCE(sv.nombre, d.descripcion), ', ') FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio
              WHERE d.id_solicitud = s.id_solicitud AND d.id_servicio IS NOT NULL) AS servicios
       FROM solicitudes_servicio s WHERE s.id_cliente = ? ORDER BY s.fecha_solicitud DESC`, [id_cliente])
  const lineas = [`- Nombre: ${c?.nombre || 'cliente'} · ${c?.tipo_cliente || ''}${c?.plan ? ` · plan ${c.plan}` : ' · sin plan'}`]
  if (sols.length) {
    lineas.push('- Solicitudes recientes:')
    for (const x of sols) lineas.push(`  ${x.codigo_seguimiento} · ${x.servicios || 'servicio'} · ${x.estado} · cita ${String(x.fecha_preferida).slice(0, 10)}`)
  } else lineas.push('- Aún no tiene solicitudes.')
  return { texto: lineas.join('\n'), nombre: c?.nombre || '' }
}

/** Datos públicos del prestador para la tarjeta del chat. */
const tarjetaPrestador = (e) => ({
  id_empleado: e.id_empleado, nombre: e.nombre, especialidad: e.especialidad, categoria: e.categoria, calificacion: e.calificacion_promedio,
  resenas: e.total_resenas, completados: e.completados, disponibilidad: e.estado_disponibilidad, tarifa_hora: e.tarifa_hora,
  zona: e.zona_cobertura, destacado: !!e.destacado,
})

// IA-P01 · Chat del asistente virtual (proceso 5.0). El asistente solo informa y sugiere:
// no crea solicitudes, no procesa pagos y no cambia estados.
// Pedidos de datos propios en el chat del cliente (se resuelven con el agente de reportes)
const PIDE_DATOS = /report|informe|lista|listado|historial|resumen|cu[aá]nt[oa]s?\b|total|factur|comprobante|ncf|pagu[eé]|pagos?\b|pagad|itbis|gast|estado de cuenta|mis solicitudes|solicitudes que|nota de cr[eé]dito|ahorr|pdf|excel|descarg|imprim/i

const rIa = Router()
rIa.use(autenticar, soloRol('Cliente'))
const LIMITE_HORA = 30

async function conversacionPropia(req) {
  const c = await one('SELECT * FROM ia_conversaciones WHERE id_conversacion = ?', [req.params.id])
  if (!c) throw notFound('Conversación no encontrada')
  if (c.id_cliente !== req.usuario.id_cliente) throw forbidden()
  return c
}

// Modo del asistente (Claude o respuestas locales) y nombre para el saludo
rIa.get('/estado', async (req, res) => {
  const d = await datosDelCliente(req.usuario.id_cliente)
  res.json({ modo: modoIA(), nombre: d.nombre, limite_hora: LIMITE_HORA })
})

rIa.get('/conversaciones', async (req, res) => {
  res.json(await query(
    `SELECT TOP 20 c.id_conversacion, c.fecha_inicio, c.estado,
            (SELECT TOP 1 LEFT(m.contenido, 60) FROM ia_mensajes m WHERE m.id_conversacion = c.id_conversacion AND m.emisor = 'Cliente' ORDER BY m.id_mensaje) AS titulo
       FROM ia_conversaciones c WHERE c.id_cliente = ? ORDER BY c.id_conversacion DESC`,
    [req.usuario.id_cliente]))
})

// Abre una conversación (v_conversacionActiva)
rIa.post('/conversaciones', async (req, res) => {
  const x = await exec("INSERT INTO ia_conversaciones (id_cliente, estado) VALUES (?, 'Abierta')", [req.usuario.id_cliente])
  res.status(201).json({ id_conversacion: x.insertId })
})

rIa.get('/conversaciones/:id/mensajes', async (req, res) => {
  const c = await conversacionPropia(req)
  const mensajes = await query('SELECT id_mensaje, emisor, contenido, fecha_envio, prestadores_sugeridos FROM ia_mensajes WHERE id_conversacion = ? ORDER BY id_mensaje', [c.id_conversacion])
  if (mensajes.some((m) => m.prestadores_sugeridos)) {
    const lista = await cargarPrestadores()
    for (const m of mensajes) {
      m.prestadores = String(m.prestadores_sugeridos || '').split(',').filter(Boolean).map((id) => lista.find((e) => e.id_empleado === Number(id))).filter(Boolean).map(tarjetaPrestador)
      delete m.prestadores_sugeridos
    }
  }
  const sugerencias = await query(
    `SELECT g.id_sugerencia, g.id_servicio, g.id_mensaje, g.descripcion_sugerencia, g.aceptada, g.fecha, s.nombre, s.precio_base, s.modalidad,
            s.duracion_estimada, cat.nombre AS categoria
       FROM ia_sugerencias g JOIN servicios s ON s.id_servicio = g.id_servicio JOIN categorias_servicio cat ON cat.id_categoria = s.id_categoria
      WHERE g.id_conversacion = ? ORDER BY g.id_sugerencia`, [c.id_conversacion])
  res.json({ ...c, mensajes, sugerencias })
})

rIa.post('/conversaciones/:id/mensajes', async (req, res) => {
  const c = await conversacionPropia(req)
  if (c.estado === 'Cerrada') await exec("UPDATE ia_conversaciones SET estado = 'Abierta', fecha_fin = NULL WHERE id_conversacion = ?", [c.id_conversacion])
  const pregunta = String(req.body.texto || '').trim()
  validar({ texto: !(pregunta.length >= 1 && pregunta.length <= 1000) && 'Escribe una pregunta de hasta 1,000 caracteres' })

  const usados = await one(
    `SELECT COUNT(*) AS n FROM ia_mensajes m JOIN ia_conversaciones c ON c.id_conversacion = m.id_conversacion
      WHERE c.id_cliente = ? AND m.emisor = 'Cliente' AND m.fecha_envio >= DATEADD(HOUR, -1, ${AHORA})`,
    [req.usuario.id_cliente])
  if (usados.n >= LIMITE_HORA) throw new HttpError(429, 'Has alcanzado el límite de consultas, intenta más tarde')

  const historial = (await query(
    'SELECT TOP 10 emisor, contenido FROM ia_mensajes WHERE id_conversacion = ? ORDER BY id_mensaje DESC', [c.id_conversacion])).reverse()
  await exec("INSERT INTO ia_mensajes (id_conversacion, emisor, contenido) VALUES (?, 'Cliente', ?)", [c.id_conversacion, pregunta])

  // Si pide datos suyos (facturas, pagos, solicitudes, ITBIS, gastos…), se genera el reporte en el mismo chat
  // ("¿cuánto cuesta…?" o "precio de…" siguen yendo al asistente de servicios, salvo que hable de sus pagos o facturas)
  const preguntaPrecio = /cuesta|cobran|precio|tarifa|vale /i.test(pregunta) && !/factur|pagu|pagad|mis |mi /i.test(pregunta)
  if (PIDE_DATOS.test(pregunta) && !preguntaPrecio) {
    const historialRep = historial.map((m) => ({ rol: m.emisor === 'Cliente' ? 'user' : 'model', texto: m.contenido }))
    const rep = await agenteReportes(req, pregunta, historialRep).catch((e) => { console.error('[IA chat reportes]', e.message); return null })
    if (rep?.reportes?.length) {
      await exec("INSERT INTO ia_mensajes (id_conversacion, emisor, contenido, tokens) VALUES (?, 'Asistente', ?, ?)",
        [c.id_conversacion, rep.respuesta, rep.tokens || null])
      return res.json({ respuesta: rep.respuesta, sugerencias: [], prestadores: [], reportes: rep.reportes, modo: modoIA() })
    }
  }

  // v_contextoCatalogo: servicios Publicados con su calificación y los prestadores aprobados
  const [servicios, prestadores] = await Promise.all([cargarServicios(), cargarPrestadores()])
  const datos = await datosDelCliente(req.usuario.id_cliente)
  const resp = await responderIA({ contexto: construirContexto(servicios, prestadores), datosCliente: datos.texto, historial, pregunta, servicios, prestadores })

  // Solo ids que existan (servicio Publicado, prestador aprobado), sin repetir y en el orden del ranking
  const validos = (ids, lista, clave) => [...new Set(Array.isArray(ids) ? ids : [])].map((id) => lista.find((x) => x[clave] === id)).filter(Boolean).slice(0, MAX_RECOMENDACIONES)
  const srvs = validos(resp.servicios, servicios, 'id_servicio')
  const pres = validos(resp.prestadores, prestadores, 'id_empleado')
  const m = await exec("INSERT INTO ia_mensajes (id_conversacion, emisor, contenido, tokens, prestadores_sugeridos) VALUES (?, 'Asistente', ?, ?, ?)",
    [c.id_conversacion, resp.texto, resp.tokens ?? null, pres.map((e) => e.id_empleado).join(',') || null])
  const sugerencias = []
  for (const [i, x] of srvs.entries()) {
    const desc = (i === 0 && resp.justificacion ? resp.justificacion : `${x.nombre} · desde RD$ ${Number(x.precio_base).toFixed(2)} + ITBIS`).slice(0, 300)
    const g = await exec('INSERT INTO ia_sugerencias (id_conversacion, id_servicio, descripcion_sugerencia, id_mensaje) VALUES (?, ?, ?, ?)', [c.id_conversacion, x.id_servicio, desc, m.insertId])
    sugerencias.push({ id_sugerencia: g.insertId, ...x, descripcion_sugerencia: desc })
  }
  res.json({ respuesta: resp.texto, sugerencias, prestadores: pres.map(tarjetaPrestador), modo: modoIA() })
})

// "Solicitar este servicio": marca la sugerencia como aceptada (luego el frontend abre SOL-P01)
rIa.post('/sugerencias/:id/aceptar', async (req, res) => {
  const x = await exec(
    `UPDATE g SET aceptada = 1 FROM ia_sugerencias g JOIN ia_conversaciones c ON c.id_conversacion = g.id_conversacion
      WHERE g.id_sugerencia = ? AND c.id_cliente = ?`, [req.params.id, req.usuario.id_cliente])
  if (!x.affectedRows) throw notFound('Sugerencia no encontrada')
  const g = await one('SELECT id_servicio FROM ia_sugerencias WHERE id_sugerencia = ?', [req.params.id])
  res.json({ id_servicio: g.id_servicio })
})

rIa.post('/conversaciones/:id/cerrar', async (req, res) => {
  const c = await conversacionPropia(req)
  await exec(`UPDATE ia_conversaciones SET estado = 'Cerrada', fecha_fin = ${AHORA} WHERE id_conversacion = ?`, [c.id_conversacion])
  res.json({ estado: 'Cerrada' })
})

const rAdminIa = Router()
rAdminIa.use(autenticar, soloRol('Administrador'))

// ---------- IA-P02 · Historial y sugerencias del asistente ----------
rAdminIa.get('/', async (_req, res) => {
  const kpis = await one(
    `SELECT (SELECT COUNT(*) FROM ia_conversaciones WHERE fecha_inicio >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) AS conversaciones_mes,
            (SELECT COUNT(*) FROM ia_sugerencias) AS sugerencias,
            (SELECT COUNT(*) FROM ia_sugerencias WHERE aceptada = 1) AS aceptadas,
            (SELECT COALESCE(SUM(tokens), 0) FROM ia_mensajes) AS tokens`)
  const recientes = await query(
    `SELECT TOP 50 c.id_conversacion, CONCAT(u.nombre, ' ', u.apellido) AS cliente, c.estado, c.fecha_inicio,
            (SELECT TOP 1 LEFT(m.contenido, 80) FROM ia_mensajes m WHERE m.id_conversacion = c.id_conversacion AND m.emisor = 'Cliente' ORDER BY m.id_mensaje) AS primera_pregunta,
            (SELECT TOP 1 s.nombre FROM ia_sugerencias g JOIN servicios s ON s.id_servicio = g.id_servicio WHERE g.id_conversacion = c.id_conversacion ORDER BY g.id_sugerencia DESC) AS servicio_sugerido,
            (SELECT MAX(CAST(g.aceptada AS INT)) FROM ia_sugerencias g WHERE g.id_conversacion = c.id_conversacion) AS aceptada,
            (SELECT COALESCE(SUM(tokens), 0) FROM ia_mensajes m WHERE m.id_conversacion = c.id_conversacion) AS tokens
       FROM ia_conversaciones c JOIN clientes cl ON cl.id_cliente = c.id_cliente JOIN usuarios u ON u.id_usuario = cl.id_usuario
      ORDER BY c.id_conversacion DESC`)
  res.json({ kpis, recientes, modo: modoIA() })
})

rAdminIa.get('/conversaciones/:id', async (req, res) => {
  const c = await one(
    `SELECT c.*, CONCAT(u.nombre, ' ', u.apellido) AS cliente FROM ia_conversaciones c JOIN clientes cl ON cl.id_cliente = c.id_cliente
       JOIN usuarios u ON u.id_usuario = cl.id_usuario WHERE c.id_conversacion = ?`, [req.params.id])
  if (!c) throw notFound('Conversación no encontrada')
  const mensajes = await query('SELECT id_mensaje, emisor, contenido, fecha_envio, tokens FROM ia_mensajes WHERE id_conversacion = ? ORDER BY id_mensaje', [c.id_conversacion])
  const sugerencias = await query(
    `SELECT g.id_sugerencia, g.descripcion_sugerencia, g.aceptada, g.fecha, s.nombre FROM ia_sugerencias g JOIN servicios s ON s.id_servicio = g.id_servicio
      WHERE g.id_conversacion = ? ORDER BY g.id_sugerencia`, [c.id_conversacion])
  res.json({ ...c, mensajes, sugerencias })
})

/** Conversaciones con el asistente sin actividad por 30 min → Cerrada. */
export async function cerrarConversaciones() {
  const r = await exec(
    `UPDATE c SET estado = 'Cerrada', fecha_fin = ${AHORA} FROM ia_conversaciones c
      WHERE c.estado = 'Abierta' AND COALESCE((SELECT MAX(fecha_envio) FROM ia_mensajes m WHERE m.id_conversacion = c.id_conversacion), c.fecha_inicio)
            < DATEADD(MINUTE, -30, ${AHORA})`)
  return r.affectedRows
}

// =====================================================================
// IA-P03 · Asistente de reportes (todos los roles).
// Gemini recibe una herramienta, ejecutar_reporte, limitada a las consultas y reportes del rol
// (lib/reportes.js). La IA elige el reporte y los filtros; el sistema lo ejecuta con los permisos
// del usuario y la IA resume el resultado. La IA nunca escribe SQL ni ve datos de otros usuarios.
// =====================================================================
const LIMITE_REPORTES_HORA = 30
// Elegir un reporte y resumir cifras no necesita el modelo grande: los "lite" responden en ≈ 1 s
// y eligen el reporte y las fechas igual de bien. Si están saturados se pasa al siguiente.
const MODELOS_REPORTES = [...new Set([process.env.GEMINI_MODELO_REPORTES, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'].filter(Boolean))]
const usoReportes = new Map() // id_usuario → marcas de tiempo de la última hora

// Guía de uso por rol: el asistente también responde "¿cómo hago…?" con las pantallas reales del sistema
const GUIA_ROL = {
  Administrador: `Menú del administrador y qué se hace en cada opción:
- Dashboard: indicadores del periodo, ingresos, solicitudes por estado y alertas (pagos por conciliar, prestadores por aprobar, e-CF rechazados).
- Catálogo y servicios: crear, editar, publicar o pausar servicios y sus precios.
- Prestadores: aprobar, rechazar o pedir documentos a los prestadores que se registran (revisar documentos y lista de verificación).
- Solicitudes: ver todas las solicitudes y asignar prestador manualmente cuando la asignación automática no encontró a nadie.
- Conciliación de pagos: confirmar o rechazar transferencias y cobros en efectivo; reembolsar un pago confirmado (emite nota de crédito).
- Cuentas de prestadores: comisiones y liquidaciones de los prestadores.
- Facturación e-CF: comprobantes y su estado en la DGII, reintentar emisión, corregir y reenviar rechazados, notas de crédito, solicitudes de nota de crédito de clientes, secuencias e-NCF y exportar el 607.
- Planes y suscripciones: planes para clientes y membresías de prestadores.
- Usuarios y roles: cuentas y permisos. Consultas y reportes: las 14 consultas y reportes del administrador con Excel y PDF.
- Configuración: datos de la empresa, ITBIS, tasa del dólar, plazos y límites.`,
  Empleado: `Menú del prestador y qué se hace en cada opción:
- Mi panel: resumen del día, asignaciones nuevas y agenda de hoy; cambiar disponibilidad (Disponible, Ocupado, No disponible).
- Asignaciones: aceptar o rechazar una asignación (hay 2 horas para responder), marcar el servicio completado (requiere anticipo pagado; se pueden agregar materiales),
  reportar un cobro en efectivo (anticipo, saldo o cargo) y solicitar un cargo adicional al cliente después de completado y pagado (el cliente lo acepta o rechaza).
- Agenda: citas por día. Cobros en efectivo: recibos reportados y su conciliación. Mis ganancias: lo cobrado, la comisión y la liquidación.
- Membresía: planes para prestadores (menor comisión o prioridad en la asignación). Mis facturas: facturas de la membresía.
- Calificaciones: reseñas de los clientes. Mi perfil y disponibilidad: especialidad, tarifa, zona de cobertura y horario.
- Consultas y reportes: las 8 consultas y reportes del prestador con Excel y PDF.`,
  Cliente: `El cliente pide servicios en Nueva solicitud, sigue su estado en Mis solicitudes, paga 50 % de anticipo y 50 % al terminar,
elige comprobante e31 o e32 al pagar y ve sus facturas en Mis facturas (allí puede solicitar crédito fiscal o nota de crédito).`,
}
const FECHA_RD = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit', day: '2-digit' })
const DIA_RD = new Intl.DateTimeFormat('es-DO', { timeZone: 'America/Santo_Domingo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

/** Envía la petición a Gemini probando los modelos en orden (saturado, límite o retirado → el siguiente). */
async function llamarGemini(cuerpo) {
  for (const modelo of MODELOS_REPORTES) {
    let r
    try {
      r = await fetch(`${GEMINI_URL}/${modelo}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        signal: AbortSignal.timeout(12_000), body: JSON.stringify(cuerpo),
      })
    } catch (e) {
      console.warn(`[IA reportes] ${modelo}:`, e.name === 'TimeoutError' ? 'tiempo de espera agotado' : e.message)
      continue
    }
    const d = await r.json().catch(() => ({}))
    if (r.ok) return d
    console.warn(`[IA reportes] ${modelo} ${r.status}:`, d?.error?.message?.slice(0, 160) || 'error')
    if (![404, 429, 500, 503].includes(r.status)) return null
  }
  return null
}

/** Resultado compacto para la IA: totales y hasta 25 filas con los títulos de las columnas. */
function resultadoParaIA(r, def) {
  const valor = (v) => (v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v)
  return {
    reporte: def.titulo, periodo: r.ctx.desde === '1900-01-01' ? 'todo el historial' : `${r.ctx.desde} a ${r.ctx.hasta}`,
    busqueda: r.ctx.q, estado: r.ctx.estado, total_filas: r.filas.length,
    resumen: Object.fromEntries(r.resumen.map((x) => [x.t, x.v])),
    filas: r.filas.slice(0, 25).map((f) => Object.fromEntries(def.columnas.map((c) => [c.t, valor(f[c.k])]))),
    nota: r.filas.length > 25 ? `Se muestran 25 de ${r.filas.length} filas; los totales del resumen incluyen todas.` : undefined,
  }
}

/** Tarjeta para el chat: resumen y primeras filas del reporte ejecutado. */
const tarjetaReporte = (r, def, formato = 'pantalla') => ({
  id: def.id, titulo: def.titulo, tipo: def.tipo, icono: def.icono, formato,
  desde: r.ctx.desde === '1900-01-01' ? '' : r.ctx.desde, hasta: r.ctx.hasta === '2999-12-31' ? '' : r.ctx.hasta,
  q: r.ctx.q || '', estado: r.ctx.estado || '', resumen: r.resumen, columnas: def.columnas, filas: r.filas.slice(0, 200), total_filas: r.filas.length,
})

/** Sin Gemini: elige el reporte cuyo título y descripción se parecen más a la pregunta y lo ejecuta para este año. */
async function reporteLocal(pregunta, usuario, catalogo) {
  const palabras = sinTildes(pregunta).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 3)
  const puntos = (d) => palabras.filter((w) => sinTildes(`${d.titulo} ${d.descripcion}`).includes(w.slice(0, 6))).length
  const mejor = [...catalogo].sort((a, b) => puntos(b) - puntos(a))[0]
  if (!mejor || !puntos(mejor)) {
    return { respuesta: `Puedo prepararte estos reportes: ${catalogo.map((d) => d.titulo).join(', ')}. ¿Cuál necesitas?`, reportes: [] }
  }
  const anio = FECHA_RD.format(new Date()).slice(0, 4)
  const r = await ejecutarReporte(mejor.id, usuario, mejor.filtros.periodo ? { desde: `${anio}-01-01`, hasta: FECHA_RD.format(new Date()) } : {})
  const formato = /pdf|imprim/i.test(pregunta) ? 'pdf' : /excel|descarg|hoja de c/i.test(pregunta) ? 'excel' : 'pantalla'
  return { respuesta: `Aquí tienes "${mejor.titulo}"${mejor.filtros.periodo ? ' de este año' : ''}.`, reportes: [tarjetaReporte(r, r.def, formato)] }
}


// ---------- Consultas libres del administrador (solo lectura) ----------
// Cuando ningún reporte cubre lo pedido, la IA escribe una consulta SELECT sobre el esquema real.
// El servidor la valida (una sola SELECT, sin escrituras ni datos sensibles) y la ejecuta en una
// transacción que siempre se revierte, con límite de tiempo y de filas.
const TABLAS_OCULTAS = ['restablecimientos_contrasena', 'paypal_webhooks']
const COLUMNAS_OCULTAS = ['contrasena_hash', 'token_hash', 'payload_json']
const PROHIBIDO = /\b(insert|update|delete|merge|drop|alter|create|exec|execute|grant|revoke|deny|truncate|into|openrowset|openquery|opendatasource|bulk|backup|restore|shutdown|dbcc|waitfor|kill|reconfigure|use|declare|set|sp_\w*|xp_\w*)\b/i
let esquemaCache = null

/** Tablas, columnas y relaciones de la base (sin lo sensible), para que la IA escriba la consulta. */
async function esquemaBD() {
  if (esquemaCache && Date.now() - esquemaCache.t < 10 * 60e3) return esquemaCache.texto
  const cols = await query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'dbo' ORDER BY TABLE_NAME, ORDINAL_POSITION`)
  const fks = await query(
    `SELECT OBJECT_NAME(f.parent_object_id) AS t, COL_NAME(fc.parent_object_id, fc.parent_column_id) AS c,
            OBJECT_NAME(f.referenced_object_id) AS rt, COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS rc
       FROM sys.foreign_keys f JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id`)
  const tablas = new Map()
  for (const x of cols) {
    if (TABLAS_OCULTAS.includes(x.t) || COLUMNAS_OCULTAS.includes(x.c)) continue
    if (!tablas.has(x.t)) tablas.set(x.t, [])
    tablas.get(x.t).push(`${x.c} ${x.d}`)
  }
  // Valores reales de las columnas de estado, tipo, modalidad o método (para que la IA no los invente)
  const categoricas = cols.filter((x) => ['nvarchar', 'varchar', 'char'].includes(x.d) && !TABLAS_OCULTAS.includes(x.t)
    && /^(estado|estado_\w+|tipo|tipo_\w+|modalidad|metodo_\w+|periodicidad|emisor|canal|nombre_rol)$/.test(x.c))
  // Valores permitidos por las reglas CHECK (aunque hoy no haya filas con ese valor) + los que existen en los datos
  const checks = await query(
    `SELECT OBJECT_NAME(parent_object_id) AS t, definition AS d FROM sys.check_constraints`)
  const valores = []
  for (const x of categoricas) {
    const permitidos = new Set()
    for (const ck of checks.filter((c) => c.t === x.t && c.d.includes(`[${x.c}]`))) {
      for (const m of ck.d.matchAll(new RegExp(`\\[${x.c}\\]\\s*=\\s*N?'([^']*)'`, 'g'))) permitidos.add(m[1])
    }
    try {
      const v = await query(`SELECT DISTINCT TOP 13 [${x.c}] AS v FROM [${x.t}] WHERE [${x.c}] IS NOT NULL`)
      if (v.length <= 12) v.forEach((y) => permitidos.add(y.v))
    } catch { /* columna sin acceso: se omite */ }
    if (permitidos.size && permitidos.size <= 15) valores.push(`${x.t}.${x.c}: ${[...permitidos].map((y) => `'${y}'`).join(' | ')}`)
  }
  const texto = [...tablas].map(([t, c]) => `${t}(${c.join(', ')})`).join('\n') +
    '\nValores existentes (usa exactamente estos en los filtros):\n' + valores.join('\n') +
    '\nRelaciones:\n' + fks.filter((f) => !TABLAS_OCULTAS.includes(f.t)).map((f) => `${f.t}.${f.c} -> ${f.rt}.${f.rc}`).join('\n')
  esquemaCache = { t: Date.now(), texto }
  return texto
}

/** Valida que la consulta sea una sola SELECT de lectura y sin datos sensibles. Devuelve el motivo si no lo es. */
function validarSql(texto) {
  const s = String(texto || '').trim().replace(/;\s*$/, '')
  if (!s) return 'Consulta vacía'
  if (s.length > 4000) return 'Consulta demasiado larga'
  if (/--|\/\*/.test(s)) return 'La consulta no puede tener comentarios'
  if (s.includes(';')) return 'Solo se permite una consulta'
  if (!/^(select|with)\b/i.test(s)) return 'Solo se permiten consultas SELECT'
  const m = s.match(PROHIBIDO)
  if (m) return `No se permite "${m[0]}" (solo lectura)`
  if (/\bsys\.|\binformation_schema\b|\bmaster\b|\bmsdb\b/i.test(s)) return 'No se permiten tablas del sistema'
  const oculta = [...TABLAS_OCULTAS, ...COLUMNAS_OCULTAS].find((x) => new RegExp(`\\b${x}\\b`, 'i').test(s))
  if (oculta) return `No se permite consultar ${oculta}`
  return null
}

// SQL Server puede devolver nombres de días y meses en inglés (DATENAME): se traducen en el resultado
const EN_ES = {
  Monday: 'Lunes', Tuesday: 'Martes', Wednesday: 'Miércoles', Thursday: 'Jueves', Friday: 'Viernes', Saturday: 'Sábado', Sunday: 'Domingo',
  January: 'Enero', February: 'Febrero', March: 'Marzo', April: 'Abril', May: 'Mayo', June: 'Junio', July: 'Julio',
  August: 'Agosto', September: 'Septiembre', October: 'Octubre', November: 'Noviembre', December: 'Diciembre',
}
const traducir = (v) => (typeof v === 'string' && EN_ES[v] ? EN_ES[v] : v)

/** Formato de cada columna del resultado según su nombre y su valor. */
function formatoColumna(nombre, valor) {
  const n = sinTildes(nombre)
  if (valor instanceof Date) return 'fechahora'
  if (typeof valor === 'number') {
    // "Total solicitudes", "cantidad de pagos"… son conteos, no dinero
    if (/cantidad|numero|conteo|^n$|^id|veces|dias|suscriptores|suscripciones|solicitudes|clientes|usuarios|servicios|prestadores|pagos$|documentos|filas|intentos|resenas|asignaciones|facturas|notas|conversaciones|mensajes/.test(n)) return 'numero'
    if (/^total\b/.test(n) && Number.isInteger(valor) && !/monto|precio|itbis|ingreso|pagado|cobrado|comision|costo|venta|saldo|neto|facturado|tarifa|rd\$/.test(n)) return 'numero'
    if (/monto|total|precio|itbis|ingreso|subtotal|tarifa|pagado|cobrado|comision|costo|venta|saldo|descuento|neto|facturado|rd\$/.test(n)) return 'dinero'
    if (/pct|porcentaje|%|tasa/.test(n)) return 'pct'
    if (/calificacion|estrellas|rating/.test(n)) return 'estrellas'
    return 'numero'
  }
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)) return 'fecha'
  return 'texto'
}

/** Tarjeta para el chat con el resultado de una consulta libre (columnas tomadas del resultado). */
function tarjetaConsulta(filas, titulo, sqlTexto, formato) {
  const claves = Object.keys(filas[0] || {})
  const columnas = claves.map((k) => ({ k, t: k, f: formatoColumna(k, filas.find((f) => f[k] !== null && f[k] !== undefined)?.[k]) }))
  const resumen = [{ t: 'Filas', v: filas.length }, ...columnas.filter((c) => c.f === 'dinero').slice(0, 3)
    .map((c) => ({ t: `Total ${c.t}`, v: round2Ia(filas.reduce((s, f) => s + Number(f[c.k] || 0), 0)), f: 'dinero' }))]
  return {
    id: 'consulta-libre', dinamico: true, titulo: String(titulo || 'Consulta').slice(0, 120), tipo: 'reporte', icono: '🧮', formato,
    desde: '', hasta: '', q: '', estado: '', resumen, columnas, filas, total_filas: filas.length, sql: sqlTexto,
  }
}
/** Deja constancia en la bitácora de cada consulta libre que ejecutó la IA. */
async function auditarIA(req, sqlTexto, filas) {
  try {
    await exec('INSERT INTO bitacora (id_usuario, accion, entidad, valor_nuevo, ip) VALUES (?, ?, ?, ?, ?)',
      [req.usuario.id_usuario, 'Consulta libre del asistente IA', 'ia', JSON.stringify({ sql: String(sqlTexto).slice(0, 3500), filas }), req.ip || null])
  } catch (e) { console.error('[IA bitácora]', e.message) }
}
const round2Ia = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

const NOTAS_ESQUEMA = `Notas del negocio para escribir consultas:
- Pagos cobrados: pagos.estado = 'Confirmado' (monto incluye ITBIS). Tipos: pagos.tipo_pago Total | Anticipo | Saldo | Cargo; metodo_pago PayPal | Tarjeta | Transferencia | Efectivo.
- Facturas: facturas.tipo_documento Factura | Nota de crédito | Nota de débito; las notas de crédito restan. Vigentes: facturas.estado = 'Emitida'. e-NCF en ecf.ncf.
- Servicios: servicios.modalidad 'En sitio' (presencial) | 'Remoto' (virtual) | 'Ambas'; estado 'Publicado' es visible. Precio en servicios.precio_base (sin ITBIS).
- Prestador = empleados (nombre en usuarios por empleados.id_usuario); servicios que ofrece en empleado_servicio. Cliente = clientes (nombre en usuarios o razon_social).
- Solicitudes: solicitudes_servicio.estado Pendiente | En proceso | Completado | Cancelado; prestador en asignaciones_servicio (estado_asignacion Asignada | Aceptada | Completada | Rechazada).`

const rIaReportes = Router()
rIaReportes.use(autenticar)

rIaReportes.post('/', async (req, res) => {
  const pregunta = String(req.body.pregunta || '').trim()
  validar({ pregunta: !(pregunta.length >= 2 && pregunta.length <= 600) && 'Escribe tu pedido (hasta 600 caracteres)' })
  const uso = (usoReportes.get(req.usuario.id_usuario) || []).filter((t) => Date.now() - t < 3600e3)
  if (uso.length >= LIMITE_REPORTES_HORA) throw new HttpError(429, 'Has alcanzado el límite de pedidos a la IA por hora; intenta más tarde')
  usoReportes.set(req.usuario.id_usuario, [...uso, Date.now()])
  res.json(await agenteReportes(req, pregunta, req.body.historial))
})

/**
 * Agente de reportes: la IA elige y ejecuta reportes (o una consulta libre si es administrador) y resume el resultado.
 * Lo usan el Asistente IA del administrador y del prestador, y el chat del cliente cuando pide datos suyos.
 * historialEntrada: [{ rol: 'user' | 'model', texto }]
 */
async function agenteReportes(req, pregunta, historialEntrada) {
  const catalogo = catalogoReportes(req.usuario.nombre_rol)
  if (!catalogo.length) throw new HttpError(403, 'Tu rol no tiene reportes disponibles')
  if (!process.env.GEMINI_API_KEY) return { ...(await reporteLocal(pregunta, req.usuario, catalogo)), modo: 'local' }

  const hoy = FECHA_RD.format(new Date())
  const lista = catalogo.map((d) => `- ${d.id}: ${d.titulo} (${d.tipo}). ${d.descripcion}` +
    `${d.filtros.periodo ? ` Periodo por: ${d.filtros.periodo}.` : ' Sin periodo.'}${d.filtros.busqueda ? ` Búsqueda: ${d.filtros.busqueda}.` : ''}` +
    `${d.filtros.estados ? ` ${d.filtros.etiquetaEstado || 'Estado'}: ${d.filtros.estados.join(' | ')}.` : ''}`).join('\n')
  const esAdmin = req.usuario.nombre_rol === 'Administrador'
  const sistema = `Eres el asistente de reportes de Directorio Servicios, SRL (Santiago, República Dominicana).
El usuario es ${req.usuario.nombre} ${req.usuario.apellido}, rol ${req.usuario.nombre_rol === 'Empleado' ? 'Prestador' : req.usuario.nombre_rol}.
Hoy es ${DIA_RD.format(new Date())} (${hoy}). La moneda es RD$.

Ayudas de dos formas:
1) Datos: para cualquier cifra, lista o resumen usa SIEMPRE la herramienta ejecutar_reporte con uno de estos reportes (son los únicos que puedes usar):
${lista}
2) Uso del sistema: explica paso a paso cómo hacer las tareas del rol con esta guía (no ejecutas acciones; indica la pantalla y los botones):
${GUIA_ROL[req.usuario.nombre_rol] || ''}
${esAdmin ? `3) Consulta libre (solo administrador): si NINGÚN reporte de la lista cubre lo pedido, usa la herramienta consulta_sql con UNA sola consulta
SELECT de T-SQL (SQL Server 2022) sobre este esquema. Reglas: solo lectura; usa TOP 1000; pon alias de columna legibles en español entre corchetes
(ej. [Monto total]); une las tablas por sus relaciones; filtra fechas con CAST(col AS date) BETWEEN 'yyyy-mm-dd' AND 'yyyy-mm-dd'; ordena el resultado.
Si la consulta da error, corrígela y vuelve a intentarlo una vez. En los filtros usa solo los valores existentes que aparecen abajo.
${NOTAS_ESQUEMA}
Esquema:
${await esquemaBD()}
` : ''}
Reglas:
- Convierte el periodo pedido a fechas yyyy-mm-dd: "este mes" = del día 1 del mes actual a hoy; "el mes pasado" = mes anterior completo; "este año" = 1 de enero a hoy;
  "hoy", "ayer", "esta semana" (lunes a hoy) igual. Si no dice periodo: en reportes usa este año; en consultas deja desde y hasta vacíos (todo).
- Si el usuario pide un reporte, una lista, un historial o un documento, EJECÚTALO siempre con la herramienta; nunca le digas que lo busque
  en el menú ni que no tienes acceso a sus datos: sus propios datos siempre están disponibles con la herramienta. Si el periodo es relativo
  ("hace un mes", "la semana pasada", "en octubre") conviértelo a fechas; "hace un mes" = el mes calendario anterior completo.
  El reporte completo se le muestra en pantalla (o se abre en PDF o se descarga en Excel según el formato), así que tu texto solo resume lo principal.
- Puedes ejecutar hasta 3 reportes si la pregunta lo necesita (por ejemplo, para comparar dos meses).
- Responde en español, breve y claro (2 a 6 oraciones), en texto plano sin markdown ni asteriscos. Da las cifras exactas del resultado con RD$ y separador de miles.
- Si el resultado viene vacío, dilo y sugiere ampliar el periodo. Nunca inventes cifras: usa solo lo que devuelva la herramienta.
- Si piden algo que ningún reporte cubre o datos de otros usuarios, explícalo y menciona los reportes que sí puedes preparar.
- El usuario puede exportar a Excel o PDF desde la tarjeta del reporte; no hace falta que lo repitas cada vez.`

  const herramienta = {
    functionDeclarations: [{
      name: 'ejecutar_reporte',
      description: 'Ejecuta una consulta o reporte del sistema con los permisos del usuario y devuelve totales y filas.',
      parameters: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', enum: catalogo.map((d) => d.id), description: 'Identificador del reporte' },
          desde: { type: 'STRING', description: 'Fecha inicial yyyy-mm-dd (vacío = sin límite)' },
          hasta: { type: 'STRING', description: 'Fecha final yyyy-mm-dd (vacío = sin límite)' },
          busqueda: { type: 'STRING', description: 'Texto a buscar, si el reporte admite búsqueda' },
          estado: { type: 'STRING', description: 'Uno de los estados del reporte, si aplica' },
          formato: { type: 'STRING', enum: ['pantalla', 'pdf', 'excel'],
            description: 'pdf si el usuario pide PDF, imprimir o un documento; excel si pide Excel, hoja de cálculo o descargar; pantalla en otro caso' },
        },
        required: ['id'],
      },
    }, ...(esAdmin ? [{
      name: 'consulta_sql',
      description: 'Solo si ningún reporte cubre lo pedido: ejecuta una consulta SELECT de solo lectura sobre la base de datos y devuelve las filas.',
      parameters: {
        type: 'OBJECT',
        properties: {
          sql: { type: 'STRING', description: 'Una sola consulta SELECT de T-SQL con TOP 1000 y alias legibles en español' },
          titulo: { type: 'STRING', description: 'Título corto del reporte en español' },
          formato: { type: 'STRING', enum: ['pantalla', 'pdf', 'excel'], description: 'Igual que en ejecutar_reporte' },
        },
        required: ['sql', 'titulo'],
      },
    }] : [])],
  }
  const historial = (Array.isArray(historialEntrada) ? historialEntrada : []).slice(-6)
    .filter((m) => m && ['user', 'model'].includes(m.rol) && typeof m.texto === 'string')
    .map((m) => ({ role: m.rol, parts: [{ text: m.texto.slice(0, 1500) }] }))
  const contents = [...historial, { role: 'user', parts: [{ text: pregunta }] }]
  const tarjetas = []
  let tokens = 0

  for (let paso = 0; paso < 4; paso++) {
    const d = await llamarGemini({
      systemInstruction: { parts: [{ text: sistema }] },
      contents, tools: [herramienta],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 1500 },
    })
    if (!d) return { ...(await reporteLocal(pregunta, req.usuario, catalogo)), modo: 'local', aviso: 'La IA no respondió; se eligió el reporte más parecido a tu pedido.' }
    tokens += d.usageMetadata?.totalTokenCount || 0
    const contenido = d.candidates?.[0]?.content
    const llamadas = (contenido?.parts || []).filter((p) => p.functionCall)
    if (!llamadas.length || paso === 3) {
      const texto = (contenido?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim()
      return { respuesta: texto || (tarjetas.length ? 'Aquí tienes el resultado.' : 'No pude preparar ese reporte. ¿Puedes darme más detalles?'), reportes: tarjetas, modo: 'gemini', tokens }
    }
    // Se devuelve el turno del modelo tal cual (conserva sus firmas de razonamiento) y luego los resultados
    contents.push(contenido)
    const respuestas = []
    for (const { functionCall: fc } of llamadas) {
      const a = fc.args || {}
      let resultado
      if (fc.name === 'consulta_sql') {
        const formato = ['pdf', 'excel'].includes(a.formato) ? a.formato : 'pantalla'
        const problema = !esAdmin ? 'Solo el administrador puede hacer consultas libres' : validarSql(a.sql)
        if (problema) resultado = { error: problema }
        else {
          try {
            // Se quitan del resultado las columnas sensibles (p. ej. si la consulta usó SELECT *)
            const filas = (await consultaSoloLectura(String(a.sql).trim().replace(/;\s*$/, ''))).map((f) => Object.fromEntries(
              Object.entries(f).filter(([k, v]) => !COLUMNAS_OCULTAS.includes(k) && !/hash|token|contrasena|password/i.test(k) && !(typeof v === 'string' && /^\$2[aby]\$/.test(v)))
                .map(([k, v]) => [k, traducir(v)])))
            const t = tarjetaConsulta(filas, a.titulo, a.sql, formato)
            const valor = (v) => (v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v)
            resultado = { total_filas: filas.length, resumen: Object.fromEntries(t.resumen.map((x) => [x.t, x.v])),
              filas: filas.slice(0, 25).map((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, valor(v)]))) }
            const vacia = tarjetas.findIndex((x) => x.dinamico && !x.total_filas)
            if (vacia >= 0) tarjetas[vacia] = t
            else if (tarjetas.length < 3) tarjetas.push(t)
            await auditarIA(req, a.sql, filas.length)
          } catch (e) {
            resultado = { error: `Error de SQL: ${String(e.message).slice(0, 300)}` }
          }
        }
        respuestas.push({ functionResponse: { name: 'consulta_sql', response: resultado } })
        continue
      }
      try {
        const r = await ejecutarReporte(a.id, req.usuario, { desde: a.desde, hasta: a.hasta, q: a.busqueda, estado: a.estado })
        if (!r) resultado = { error: 'Reporte no disponible para este usuario' }
        else {
          resultado = resultadoParaIA(r, r.def)
          // Si la IA repite un reporte porque el intento anterior salió vacío (ajustó un filtro), el nuevo lo reemplaza
          const t = tarjetaReporte(r, r.def, ['pdf', 'excel'].includes(a.formato) ? a.formato : 'pantalla')
          const vacia = tarjetas.findIndex((x) => x.id === t.id && !x.total_filas)
          if (vacia >= 0) tarjetas[vacia] = t
          else if (tarjetas.length < 3) tarjetas.push(t)
        }
      } catch (e) {
        console.error('[IA reportes] ejecutar', a.id, e.message)
        resultado = { error: 'No se pudo ejecutar el reporte' }
      }
      respuestas.push({ functionResponse: { name: 'ejecutar_reporte', response: resultado } })
    }
    contents.push({ role: 'user', parts: respuestas })
  }
}

// ---------- Rutas del módulo (montadas en /api) ----------
export const router = Router()
router.use('/ia/reportes', rIaReportes) // va antes de /ia: ese router es solo para clientes
router.use('/ia', rIa)
router.use('/admin/ia', rAdminIa)
