/* =====================================================================
   Vouchers (saldo a favor del cliente): cuando una nota de crédito o un
   reembolso no se devuelve en dinero, se emite un voucher por el monto.
   El cliente lo usa como forma de pago (total o parcial) en un nuevo cobro.
   Su saldo = monto − lo aplicado en pagos vigentes (Pendiente, En verificación,
   Confirmado); un pago rechazado o reembolsado libera lo aplicado.
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
IF OBJECT_ID('vouchers') IS NULL
  CREATE TABLE vouchers (
    id_voucher      INT IDENTITY PRIMARY KEY,
    codigo          NVARCHAR(20) NOT NULL CONSTRAINT UX_vouchers_codigo UNIQUE,
    id_cliente      INT NOT NULL REFERENCES clientes (id_cliente),
    monto           DECIMAL(12,2) NOT NULL CHECK (monto > 0),
    origen          NVARCHAR(20) NOT NULL CHECK (origen IN (N'Nota de crédito', N'Reembolso')),
    id_solicitud_nc INT NULL REFERENCES solicitudes_nota_credito (id_solicitud_nc),
    id_pago_origen  INT NULL REFERENCES pagos (id_pago),
    id_nota         INT NULL REFERENCES facturas (id_factura),
    estado          NVARCHAR(10) NOT NULL DEFAULT N'Activo' CHECK (estado IN (N'Activo', N'Anulado')),
    fecha_emision   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    creado_por      INT NULL REFERENCES usuarios (id_usuario)
  );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_vouchers_cliente')
  CREATE INDEX IX_vouchers_cliente ON vouchers (id_cliente);
GO

-- Parte del pago cubierta con un voucher (el resto, con el método del pago)
IF COL_LENGTH('pagos', 'id_voucher') IS NULL ALTER TABLE pagos ADD id_voucher INT NULL CONSTRAINT FK_pagos_voucher REFERENCES vouchers (id_voucher);
IF COL_LENGTH('pagos', 'monto_voucher') IS NULL ALTER TABLE pagos ADD monto_voucher DECIMAL(12,2) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_pagos_voucher')
  ALTER TABLE pagos ADD CONSTRAINT CK_pagos_voucher
    CHECK ((id_voucher IS NULL AND monto_voucher IS NULL) OR (id_voucher IS NOT NULL AND monto_voucher > 0 AND monto_voucher <= monto));
GO

-- Nuevo método de pago: Voucher (cuando el voucher cubre todo el cobro)
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_pagos_metodo_pago' AND definition NOT LIKE '%Voucher%')
  ALTER TABLE pagos DROP CONSTRAINT CK_pagos_metodo_pago;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_pagos_metodo_pago')
  ALTER TABLE pagos ADD CONSTRAINT CK_pagos_metodo_pago
    CHECK (metodo_pago IN (N'Efectivo', N'Transferencia', N'Tarjeta', N'PayPal', N'Voucher'));
GO
