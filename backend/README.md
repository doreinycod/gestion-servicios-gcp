# API · Sistema de Gestión Multiservicios

Backend de Directorio Servicios, SRL. Node.js + Express sobre **SQL Server** (base `GestionMultiservicios`).

## Requisitos

- Node.js 20 o superior
- SQL Server con la base `GestionMultiservicios` (las 22 tablas del diseño)

## Puesta en marcha

```bash
cd backend
npm install
cp .env.example .env          # completar DB_PASSWORD y JWT_SECRET
npm run db:ajustes            # aplica database/01_ajustes.sql (idempotente)
npm run db:seed               # usuarios, prestadores y catálogo de demostración
npm run dev                   # http://127.0.0.1:3000/api
```

Usuarios de demostración (contraseña `Demo1234`):

| Rol | Correo |
|---|---|
| Administrador | ana.diaz@directorioservicios.do |
| Cliente (persona física, plan Hogar+) | maria.rodriguez@gmail.com |
| Cliente (empresa, recibe e31) | compras@textilescaribe.do |
| Prestador | cmendez.electric@gmail.com |
| Prestador pendiente de aprobación | ramonfeliz.plom@gmail.com |

`npm run db:limpiar -- --confirmar` borra solicitudes, pagos, facturas, IA y notificaciones, y reinicia las secuencias e-NCF. No toca los usuarios ni el catálogo.

## Estructura

```
backend/
├─ database/                 ajustes a la base, en orden e idempotentes (npm run db:ajustes)
│  ├─ 01_ajustes.sql         columnas y tablas de soporte
│  ├─ 02_anticipos.sql       pagos.tipo_pago (Total, Anticipo, Saldo)
│  ├─ 03_proveedor_ecf.sql   datos de la plataforma e-CF
│  ├─ 04_notas.sql           notas de crédito/débito, sustitución e32→e31, cargos adicionales
│  ├─ 05_secuencias_proveedor.sql  monitoreo de los rangos e-NCF autorizados
│  ├─ 06_solicitudes_nota_credito.sql  solicitudes de nota de crédito de los clientes
│  └─ 07_comprobante_solicitud.sql     comprobante (e31/e32) elegido al pagar
├─ src/
│  ├─ modulos/               un archivo por módulo funcional (sección 16.2), con sus rutas y su lógica
│  │  ├─ mod-cat.js          MOD-CAT  catálogo, prestadores, planes y suscripciones
│  │  ├─ mod-sol.js          MOD-SOL  solicitudes, panel del prestador, asignación automática
│  │  ├─ mod-pag.js          MOD-PAG  checkout, PayPal, tarjeta, transferencia, efectivo, conciliación
│  │  ├─ mod-fac.js          MOD-FAC  factura, e-CF, envío a la DGII, secuencias, 607
│  │  ├─ mod-ia.js           MOD-IA   asistente virtual e historial
│  │  └─ mod-adm.js          MOD-ADM  acceso, dashboard, prestadores, usuarios, reportes, notificaciones
│  ├─ config/db.js           pool de SQL Server, consultas parametrizadas, transacciones (compartido)
│  ├─ middleware/auth.js     JWT (v_usuarioActivo / v_rolActivo) y control por rol (compartido)
│  ├─ lib/                   reglas fiscales, cálculo de totales, errores HTTP, archivos (compartido)
│  ├─ app.js                 monta los 6 módulos en /api
│  ├─ jobs.js                programa las tareas que define cada módulo
│  └─ scripts/               ajustes, datos demo y limpieza
├─ uploads/                  comprobantes y documentos (no versionado)
└─ storage/ecf/              XML de los e-CF (no versionado)
```

## Endpoints principales (`/api`)

| Módulo | Rutas |
|---|---|
| Acceso (ADM-P01) | `POST /auth/login`, `POST /auth/registro`, `POST /auth/registro-prestador`, `GET /auth/me`, `PUT /auth/perfil`, `POST /auth/cambiar-contrasena` |
| MOD-CAT | `GET /catalogo/categorias`, `GET /catalogo/servicios`, `GET /catalogo/prestadores[/:id]`, `GET /catalogo/planes`; admin: `POST/PUT /catalogo/servicios`, `PATCH /catalogo/servicios/:id/estado`, `POST/PUT /catalogo/planes` |
| MOD-SOL | `POST /solicitudes/cotizar`, `POST /solicitudes`, `GET /solicitudes/mias`, `GET /solicitudes/seguimiento/:codigo`, `POST /solicitudes/:codigo/confirmar`, `POST /solicitudes/:codigo/cancelar`, `POST /solicitudes/:codigo/cargos/:id/responder` |
| Prestador (SOL-P04) | `GET /prestador/panel`, `GET /prestador/asignaciones`, `POST /prestador/asignaciones/:id/aceptar\|rechazar\|completar\|cargos`, `POST /prestador/cargos/:id/anular`, `PATCH /prestador/disponibilidad`, `GET /prestador/calificaciones`, `GET/PUT /prestador/perfil` |
| MOD-PAG | `GET /pagos/checkout/:codigo`, `POST /pagos`, `POST /pagos/:id/paypal/capturar`, `POST /pagos/:id/tarjeta`, `POST /pagos/:id/transferencia`, `POST /pagos/efectivo`, `GET /pagos/mios`, `GET /pagos/:id/recibo`, `POST /webhooks/paypal`, `GET/POST /suscripciones` |
| MOD-FAC | `GET /facturas/mias`, `GET /facturas/:numero`, `GET /facturas/:numero/xml`, `POST /facturas/:numero/solicitar-nota-credito`, `POST /facturas/solicitudes-nota-credito/:id/cancelar`; admin: `POST /admin/facturacion/facturas/:id/nota-credito\|emitir`, `GET /admin/facturacion/solicitudes-nota-credito`, `POST /admin/facturacion/solicitudes-nota-credito/:id/responder\|devuelto`, `GET/POST/DELETE /admin/facturacion/secuencias`, `POST /admin/facturacion/secuencias/sincronizar` |
| MOD-IA | `POST /ia/conversaciones`, `GET /ia/conversaciones[/:id/mensajes]`, `POST /ia/conversaciones/:id/mensajes`, `POST /ia/sugerencias/:id/aceptar` |
| MOD-ADM | `GET /admin/dashboard`, `GET /admin/prestadores`, `POST /admin/prestadores/:id/decision`, `GET/POST/PATCH /admin/usuarios`, `GET/PUT /admin/permisos`, `GET /admin/reportes/:tipo[?formato=csv]`, `GET /admin/pagos`, `POST /admin/pagos/:id/conciliar\|reembolsar`, `GET/POST /admin/facturacion/secuencias`, `GET /admin/facturacion/comprobantes`, `POST /admin/facturacion/ecf/:id/reenviar`, `GET /admin/facturacion/607`, `GET /admin/solicitudes`, `POST /admin/solicitudes/:codigo/asignar` |

## Reglas implementadas

- Contraseñas con bcrypt. Tras 3 intentos fallidos la cuenta queda bloqueada 15 minutos. La sesión es un JWT de 30 minutos.
- Asignación automática por categoría, aprobación, disponibilidad, zona y horario libre, ordenada por mejor calificación y menor carga semanal. El prestador tiene 2 h para responder y hay un máximo de 3 reasignaciones; después pasa a asignación manual.
- **Pago fraccionado 50/50:** el **anticipo (50 %)** se paga cuando el prestador acepta (solicitud En proceso) y el **saldo (50 % + materiales)** cuando el cliente confirma la finalización. El prestador no puede marcar completado sin anticipo pagado o en verificación, y puede cobrar cualquiera de los dos en efectivo. Al confirmarse el anticipo se emite **una sola factura e-CF por el 100 % de los servicios** (a crédito: el anticipo es el primer abono) y el saldo se **abona a esa misma factura**; si se agregaron materiales al cerrar, se facturan con una nota de débito (e33) sobre ella. Un pago Total (sin anticipo) lleva su propia factura. Al reembolsar un abono se emite una nota de crédito por lo abonado, o se anula la factura si ya no queda ningún abono. Si se cancela con anticipo, administración recibe aviso para reembolsarlo.
- **Modelo de cobro tipo marketplace** (`database/10_tarifas_comisiones.sql`, `src/lib/comisiones.js`), con parámetros editables en *Administración › Cuentas de prestadores*:
  - **Tarifa al cliente:** 3 % del neto (mínimo RD$ 180 sobre los servicios), como línea "Tarifa de servicio de la plataforma" con ITBIS en la factura; también 3 % sobre materiales y cargos adicionales. Queda fijada en la solicitud al crearla (`tarifa_pct`, `tarifa_min`); las solicitudes anteriores no la llevan.
  - **Comisión al prestador:** 10 % del valor del servicio sin ITBIS (mínimo RD$ 300), cargada **al aceptar** la asignación y devuelta si la solicitud se cancela; 10 % sobre materiales y cargos al cobrarse.
  - **Estado de cuenta del prestador** (`movimientos_prestador`): gana el valor de catálogo del servicio a medida que el cliente paga (50 % con el anticipo, el resto + materiales con el saldo; los descuentos de plan los absorbe la plataforma). El efectivo que cobra se descuenta de su saldo. Administración registra las liquidaciones (`liquidaciones_prestador`).
  - **Membresía opcional del prestador:** planes con `dirigido_a = 'Prestador'` que fijan su propia comisión, prioridad en la asignación automática y destacado en el catálogo. Se pagan igual que los planes de clientes (perfil de facturación del prestador en `clientes`) y se facturan con e-CF.
- **Vouchers (saldo a favor)** (`database/11_vouchers.sql`, `src/lib/vouchers.js`): si una nota de crédito aprobada o un reembolso no se devuelve en dinero, administración emite un voucher `VCH-XXXXXXXX` por el monto y el cliente recibe el número. Al pagar elige **Voucher** y escribe el número: si cubre el cobro se confirma al instante; si no, el resto se paga con PayPal, tarjeta o transferencia (`pagos.id_voucher`, `monto_voucher`). En el e-CF esa parte va con forma de pago 7 (nota de crédito). El saldo se calcula de los pagos vigentes: un pago rechazado o reembolsado devuelve lo aplicado al voucher.
- Un pago confirmado dispara la factura. Si el cliente no confirma la finalización en 48 h, la solicitud se confirma sola.
- El plan se aplica con `cantidad_incluida` (usos sin costo en el periodo) y `descuento_pct` (descuento sobre el resto). El ITBIS es 18 % de las líneas gravadas.
- Al pagar, el cliente elige el comprobante: **consumo (e32)** o **crédito fiscal (e31)** con RNC/cédula validado en la DGII (`PUT /pagos/comprobante/:codigo`). La elección se guarda en la solicitud y aplica a anticipo, saldo y cobros en efectivo. Si no elige: e31 para empresa con RNC válido, e32 en otro caso.
- **Un e-CF no se cancela ni se modifica.** Toda corrección se hace con notas que llevan `InformacionReferencia` (NCF modificado, fecha, código de modificación) según el Formato e-CF v1.0 de la DGII:
  - **Nota de crédito (e34):** total, código 1, anula el comprobante; parcial, código 3, corrige montos. La generan el reembolso de un pago, el administrador (Facturación e-CF › Nota de crédito) y la aprobación de una solicitud del cliente.
  - **Solicitud del cliente:** en Mis facturas, "Solicitar nota de crédito" (motivo, detalle, total o parcial). Administración recibe un aviso y la atiende en Facturación e-CF › Solicitudes de nota de crédito: aprobar (emite la e34; puede ajustar el monto) o rechazar con respuesta. Si el documento estaba pagado queda "Por devolver" hasta registrar la referencia de la devolución. Si pasan más de 30 días de la factura, `IndicadorNotaCredito = 1` (no rebaja ITBIS).
  - **Cambio a crédito fiscal (automático):** en Mis facturas el cliente indica su RNC/cédula; si la DGII lo valida, se emite una NC que anula el e32 y un e31 nuevo por el mismo pago, con referencia al e32 (código 5). Disponible hasta 30 días después de la factura.
  - **Nota de débito (e33):** el prestador solicita un cargo adicional después de completado y pagado el servicio (hasta 30 días); el cliente lo acepta o rechaza en el seguimiento; su pago emite una ND (código 3) sobre la factura del servicio.
  - La DGII no permite que una nota modifique a otra (regla 655): revertir una ND se hace con una NC sobre la factura original, y la ND queda anulada (`facturas.id_nota_revertida`).
  - Las secuencias e33 y e34 se configuran en el panel del proveedor, igual que e31 y e32.
- **Secuencias e-NCF:** se solicitan en la Oficina Virtual de la DGII y se cargan en la plataforma e-CF, que asigna el número en cada envío. La plataforma no informa sus rangos, así que en Facturación e-CF se registra el rango autorizado por tipo; el sistema calcula el último número usado (los e-NCF asignados y, con `by-encf`, los usados desde otros sistemas con la misma cuenta) y avisa a administración cuando queda menos del 10 % o vence en menos de 30 días. Se sincroniza cada 6 horas y en cada emisión.
- Todas las consultas van parametrizadas, y la bitácora registra inicios de sesión, conciliaciones, aprobaciones y cambios.

## Pendiente para producción

- **Reembolso de dinero:** el reembolso registra la nota de crédito, pero la devolución en PayPal o en la pasarela todavía se hace manualmente.
- **DGII (facturación electrónica):** integrada con la plataforma e-CF del proveedor (`ECF_API_URL` + `ECF_API_KEY` en `.env`). La plataforma asigna el e-NCF, firma con el certificado .p12 y envía a la DGII; el sistema guarda e-NCF, TrackId, estado, código de seguridad, URL de consulta (QR) y emisor. El ambiente (TesteCF, CerteCF, eCF) se elige en el panel del proveedor. Sin esas variables, el sistema vuelve al modo simulado.
- **PayPal:** sin `PAYPAL_CLIENT_ID` funciona en modo simulado. Con credenciales usa la Orders API v2 real.
- **Tarjeta (Azul / CardNet):** está simulada. La tarjeta que termina en 0002 se declina.
- **Asistente IA:** usa Google Gemini con `GEMINI_API_KEY` (modelo `GEMINI_MODELO`, por defecto el alias `gemini-flash-latest`, salida JSON con esquema). Sin esa clave usa Claude si hay `ANTHROPIC_API_KEY`, y si no responde por palabras clave. Si el proveedor falla, esa respuesta se da por palabras clave.
- **Correo y WhatsApp:** las notificaciones se registran en la tabla, pero el envío real todavía no está conectado.
