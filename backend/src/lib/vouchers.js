// Vouchers: saldo a favor del cliente cuando una nota de crédito o un reembolso no se devuelve en dinero.
// Se usan como forma de pago (total o parcial). El saldo se calcula de los pagos vigentes que lo aplican,
// así un pago rechazado o reembolsado devuelve automáticamente lo aplicado al voucher.
import { exec, one, query } from '../config/db.js'
import { codigoAleatorio, round2 } from './fiscal.js'
import { conflict, notFound } from './http.js'

const SQL_SALDO = `v.monto - COALESCE((SELECT SUM(p.monto_voucher) FROM pagos p
   WHERE p.id_voucher = v.id_voucher AND p.estado IN ('Pendiente', 'En verificación', 'Confirmado')), 0)`

/** Emite un voucher a nombre del cliente y devuelve { id_voucher, codigo, monto }. */
export async function crearVoucher(cx, { id_cliente, monto, origen, id_solicitud_nc = null, id_pago_origen = null, id_nota = null, creado_por = null }) {
  let codigo
  for (let i = 0; i < 10 && !codigo; i++) {
    const c = `VCH-${codigoAleatorio(8)}`
    if (!(await one('SELECT 1 AS x FROM vouchers WHERE codigo = ?', [c], cx))) codigo = c
  }
  if (!codigo) throw new Error('No se pudo generar el código del voucher')
  const v = await exec(
    `INSERT INTO vouchers (codigo, id_cliente, monto, origen, id_solicitud_nc, id_pago_origen, id_nota, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [codigo, id_cliente, round2(monto), origen, id_solicitud_nc, id_pago_origen, id_nota, creado_por], cx)
  return { id_voucher: v.insertId, codigo, monto: round2(monto) }
}

/** Voucher del cliente con su saldo disponible (bloquea la fila para aplicarlo sin carreras). */
export async function voucherDelCliente(codigo, id_cliente, cx) {
  const v = await one(
    `SELECT v.id_voucher, v.codigo, v.id_cliente, v.monto, v.estado, ${SQL_SALDO} AS saldo
       FROM vouchers v WITH (UPDLOCK, ROWLOCK) WHERE v.codigo = ?`, [String(codigo || '').trim().toUpperCase()], cx)
  if (!v || v.id_cliente !== id_cliente) throw notFound('Voucher no encontrado. Verifica el número.')
  if (v.estado !== 'Activo') throw conflict('El voucher está anulado')
  if (!(Number(v.saldo) > 0)) throw conflict('El voucher ya no tiene saldo disponible')
  return { ...v, saldo: round2(v.saldo) }
}

/** Vouchers del cliente con su saldo. */
export const vouchersDelCliente = (id_cliente) => query(
  `SELECT v.codigo, v.monto, v.origen, v.estado, v.fecha_emision, ${SQL_SALDO} AS saldo, n.numero_factura AS nota
     FROM vouchers v LEFT JOIN facturas n ON n.id_factura = v.id_nota
    WHERE v.id_cliente = ? ORDER BY v.id_voucher DESC`, [id_cliente])
