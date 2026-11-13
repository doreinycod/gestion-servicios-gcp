/* =====================================================================
   Pago fraccionado: 50 % de anticipo al aceptar el prestador y 50 % de saldo
   al finalizar el servicio. Idempotente.
   pagos.tipo_pago: Total (pago único), Anticipo (50 % antes del servicio), Saldo (resto al finalizar)
   ===================================================================== */
USE GestionMultiservicios;
GO
IF COL_LENGTH('pagos', 'tipo_pago') IS NULL
  ALTER TABLE pagos ADD tipo_pago NVARCHAR(10) NOT NULL CONSTRAINT DF_pagos_tipo_pago DEFAULT N'Total';
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_pagos_tipo_pago')
  ALTER TABLE pagos ADD CONSTRAINT CK_pagos_tipo_pago CHECK (tipo_pago IN (N'Total', N'Anticipo', N'Saldo'));
GO
