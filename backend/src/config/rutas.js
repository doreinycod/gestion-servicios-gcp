import path from 'node:path'

// Carpetas de archivos. En Cloud Run apuntan a un bucket de Cloud Storage montado como volumen
// (DATOS_DIR=/datos); en local quedan dentro de backend/ como siempre.
const base = process.env.DATOS_DIR ? path.resolve(process.env.DATOS_DIR) : path.resolve('.')

/** Adjuntos de los usuarios (comprobantes de transferencia, documentos de prestadores). */
export const DIR_UPLOADS = path.join(base, 'uploads')
/** XML de los e-CF generados en modo simulado. */
export const DIR_ECF = path.join(base, 'storage', 'ecf')
