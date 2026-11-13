import multer from 'multer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { badRequest } from './http.js'
import { DIR_UPLOADS } from '../config/rutas.js'

// Archivos adjuntos: JPG, PNG o PDF de hasta 5 MB (validaciones sección 29.1)
const DIR = DIR_UPLOADS
fs.mkdirSync(DIR, { recursive: true })
const TIPOS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' }

export const upload = multer({
  storage: multer.diskStorage({
    destination: DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${TIPOS[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) =>
    TIPOS[file.mimetype] ? cb(null, true) : cb(badRequest('Tipo o tamaño de archivo no permitido')),
})

export const urlArchivo = (file) => (file ? `/uploads/${file.filename}` : null)
