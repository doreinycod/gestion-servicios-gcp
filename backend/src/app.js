import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import multer from 'multer'
import { verificarConexion } from './config/db.js'
import { autenticar, soloRol } from './middleware/auth.js'
import { HttpError } from './lib/http.js'
import { DIR_UPLOADS } from './config/rutas.js'
// Un archivo por módulo funcional (sección 16.2)
import { router as modCat } from './modulos/mod-cat.js'
import { router as modSol } from './modulos/mod-sol.js'
import { router as modPag } from './modulos/mod-pag.js'
import { router as modFac } from './modulos/mod-fac.js'
import { router as modIa } from './modulos/mod-ia.js'
import { router as modAdm } from './modulos/mod-adm.js'
import { rTareas } from './jobs.js'

export const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(cors({ origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','), credentials: true }))
app.use(express.json({ limit: '1mb' }))
// Cabeceras de seguridad básicas (sección 25.3)
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' })
  next()
})

app.get('/api/salud', async (_req, res) => {
  const db = await verificarConexion()
  res.json({ ok: true, base_datos: db.db, servidor: db.version.split('\n')[0] })
})

app.use('/api', modCat) // /catalogo, /suscripciones, /admin/suscripciones
app.use('/api', modSol) // /solicitudes, /prestador, /admin/solicitudes
app.use('/api', modPag) // /pagos, /admin/pagos, /webhooks/paypal
app.use('/api', modFac) // /facturas, /admin/facturacion
app.use('/api', modIa) //  /ia, /admin/ia
app.use('/api/tareas', rTareas) // Cloud Scheduler (tareas programadas cuando el servicio corre en Cloud Run)
app.use('/api', modAdm) // /auth, /notificaciones, /admin (va al final: /admin es el prefijo más general)

// Comprobantes y documentos adjuntos: solo administradores (contienen datos sensibles)
app.get('/api/archivos/:nombre', autenticar, soloRol('Administrador'), (req, res) => {
  res.sendFile(path.join(DIR_UPLOADS, path.basename(req.params.nombre)), (e) => e && res.status(404).json({ error: 'Archivo no encontrado' }))
})

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }))

// Producción (Docker / Cloud Run): el mismo servicio entrega el frontend compilado (FRONTEND_DIR) en la misma URL
const FRONTEND = process.env.FRONTEND_DIR && path.resolve(process.env.FRONTEND_DIR)
if (FRONTEND && fs.existsSync(path.join(FRONTEND, 'index.html'))) {
  // Los archivos de /assets llevan un hash en el nombre: se pueden guardar en caché un año
  app.use('/assets', express.static(path.join(FRONTEND, 'assets'), { immutable: true, maxAge: '365d' }))
  app.use(express.static(FRONTEND, { index: false, maxAge: '1h' }))
  // Cualquier otra ruta es de la aplicación React (React Router la resuelve en el navegador)
  app.get(/^(?!\/api\/).*/, (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(FRONTEND, 'index.html')))
}

// Manejo central de errores: mensajes claros al usuario, detalle técnico solo en consola
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, detalles: err.detalles })
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Tipo o tamaño de archivo no permitido' : 'Archivo inválido' })
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' })
  // Errores de SQL Server: 2627/2601 clave única, 547 restricción CHECK o llave foránea
  const num = err.number ?? err.originalError?.info?.number
  if (num === 2627 || num === 2601) return res.status(409).json({ error: 'El registro ya existe' })
  if (num === 547) {
    console.error('[SQL 547]', err.message)
    return res.status(400).json({ error: 'Los datos no cumplen las reglas de la base de datos' })
  }
  if (err.code === 'ESOCKET' || err.code === 'ELOGIN') {
    console.error('[BD]', err.message)
    return res.status(503).json({ error: 'No hay conexión con la base de datos' })
  }
  console.error(err.sql ? `[SQL] ${err.message}
      ${err.sql}` : err)
  res.status(500).json({ error: 'Error interno del servidor' })
})
