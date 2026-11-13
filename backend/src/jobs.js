// Tareas programadas (servicios transversales, sección 16.1).
// Cada tarea vive en su módulo; aquí solo se agrupan por frecuencia.
//  - En local (TAREAS distinto de "off"): las dispara el propio servidor con temporizadores.
//  - En Cloud Run (TAREAS=off): las dispara Cloud Scheduler con POST /api/tareas/:grupo. Así el servicio
//    puede bajar a 0 instancias cuando no hay peticiones y las tareas siguen corriendo a su hora.
import crypto from 'node:crypto'
import { Router } from 'express'
import { vencerAsignaciones, confirmarAutomaticamente } from './modulos/mod-sol.js'
import { reintentarPendientesDgii, revisarSecuencias } from './modulos/mod-fac.js'
import { cerrarConversaciones } from './modulos/mod-ia.js'
import { vencerSuscripciones } from './modulos/mod-cat.js'

/** Grupos de tareas por frecuencia (los mismos intervalos que usa el servidor en local). */
export const GRUPOS = {
  // Cada minuto: plazos de 2 h y 48 h, conversaciones del asistente inactivas
  frecuentes: { cadaMin: 1, tareas: { 'SOL · asignaciones vencidas (2 h)': vencerAsignaciones, 'SOL · confirmación automática (48 h)': confirmarAutomaticamente, 'IA · cerrar conversaciones inactivas': cerrarConversaciones } },
  // Cada 5 minutos: e-CF en proceso o sin emitir
  dgii: { cadaMin: 5, tareas: { 'FAC · reintento DGII': reintentarPendientesDgii } },
  // Cada hora: suscripciones vencidas
  horarias: { cadaMin: 60, tareas: { 'CAT · suscripciones vencidas': vencerSuscripciones } },
  // Cada 6 horas: secuencias e-NCF por agotarse o vencer
  secuencias: { cadaMin: 360, tareas: { 'FAC · secuencias e-NCF': revisarSecuencias } },
}

/** Ejecuta un grupo; un error en una tarea no detiene las demás. */
export async function ejecutarGrupo(nombre) {
  const resultado = {}
  for (const [tarea, fn] of Object.entries(GRUPOS[nombre].tareas)) {
    try {
      await fn()
      resultado[tarea] = 'ok'
    } catch (e) {
      console.error(`[tarea ${tarea}]`, e.message)
      resultado[tarea] = `error: ${e.message}`
    }
  }
  return resultado
}

/** Local: temporizadores dentro del servidor. */
export function iniciarTareas() {
  for (const [nombre, g] of Object.entries(GRUPOS)) {
    setInterval(() => ejecutarGrupo(nombre), g.cadaMin * 60_000).unref()
  }
  ejecutarGrupo('frecuentes')
  ejecutarGrupo('secuencias')
}

/**
 * Cloud Scheduler: POST /api/tareas/:grupo con la cabecera X-Tareas-Token (secreto TAREAS_TOKEN).
 * Sin TAREAS_TOKEN configurado la ruta no existe (404).
 */
export const rTareas = Router()
rTareas.post('/:grupo', async (req, res) => {
  const esperado = process.env.TAREAS_TOKEN
  const recibido = String(req.get('X-Tareas-Token') || '')
  if (!esperado) return res.status(404).json({ error: 'Ruta no encontrada' })
  const ok = recibido.length === esperado.length && crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(esperado))
  if (!ok) return res.status(401).json({ error: 'No autorizado' })
  if (!GRUPOS[req.params.grupo]) return res.status(404).json({ error: 'Grupo de tareas no existe' })
  res.json({ grupo: req.params.grupo, resultado: await ejecutarGrupo(req.params.grupo) })
})
