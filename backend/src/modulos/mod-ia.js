// =====================================================================
// MOD-IA · Asistente Virtual (proceso 5.0)
// IA-P01 Chat del asistente · IA-P02 Historial y sugerencias
// =====================================================================
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { Router } from 'express'
import { exec, one, query, AHORA } from '../config/db.js'
import { autenticar, soloRol } from '../middleware/auth.js'
import { forbidden, HttpError, notFound, validar } from '../lib/http.js'

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

// ---------- Rutas del módulo (montadas en /api) ----------
export const router = Router()
router.use('/ia', rIa)
router.use('/admin/ia', rAdminIa)
