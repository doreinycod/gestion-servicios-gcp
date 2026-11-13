// Envío de correos por SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM).
// Sin SMTP configurado, el correo se muestra en la consola del backend (modo desarrollo).
import nodemailer from 'nodemailer'

export const correoConfigurado = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)

let transporte = null
function obtenerTransporte() {
  if (!transporte) {
    const puerto = Number(process.env.SMTP_PORT || 587)
    transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: puerto, secure: puerto === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  }
  return transporte
}

/** Envía un correo. Devuelve true si salió por SMTP; false si solo se registró en la consola. */
export async function enviarCorreo({ para, asunto, texto, html }) {
  if (!correoConfigurado()) {
    console.log(`\n[correo · sin SMTP] Para: ${para}\nAsunto: ${asunto}\n${texto}\n`)
    return false
  }
  await obtenerTransporte().sendMail({
    from: process.env.SMTP_FROM || `Directorio Servicios <${process.env.SMTP_USER}>`, to: para, subject: asunto, text: texto, html,
  })
  return true
}
