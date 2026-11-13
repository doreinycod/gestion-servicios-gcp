// Restablece la contraseña de un usuario y lo desbloquea (uso administrativo en desarrollo).
// Uso: npm run db:restablecer -- correo@ejemplo.com NuevaClave123
import bcrypt from 'bcryptjs'
import { exec, one, getPool } from '../config/db.js'
import { contrasenaValida } from '../lib/fiscal.js'

const [email, nueva] = process.argv.slice(2)
if (!email || !nueva) {
  console.error('Uso: npm run db:restablecer -- correo@ejemplo.com NuevaClave123')
  process.exit(1)
}
if (!contrasenaValida(nueva)) {
  console.error('La contraseña debe tener al menos 8 caracteres, una mayúscula y un número.')
  process.exit(1)
}
const u = await one('SELECT id_usuario, nombre, apellido FROM usuarios WHERE email = ?', [email.trim().toLowerCase()])
if (!u) {
  console.error(`No existe un usuario con el correo ${email}`)
  process.exit(1)
}
await exec(
  "UPDATE usuarios SET contrasena_hash = ?, estado = IIF(estado = 'Bloqueado', 'Activo', estado), intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?",
  [await bcrypt.hash(nueva, 10), u.id_usuario])
console.log(`✓ Contraseña restablecida y cuenta desbloqueada: ${u.nombre} ${u.apellido} <${email}>`)
await (await getPool()).close()
